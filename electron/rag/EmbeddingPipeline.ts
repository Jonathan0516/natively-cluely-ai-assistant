// electron/rag/EmbeddingPipeline.ts
// Post-meeting embedding generation. Vectors are computed locally with a pluggable
// IEmbeddingProvider (Gemini, OpenAI, or Ollama); on provider exhaustion the meeting is
// transparently downgraded to the on-device LocalEmbeddingProvider (MiniLM).
//
// Storage/search live in the cloud (pgvector via VectorStore → CloudClient). The former
// SQLite-backed retry queue is replaced by an in-memory pending set — chunks are buffered in
// VectorStore and embedded here, then appended to the cloud.

import { VectorStore } from './VectorStore';
import { EmbeddingProviderResolver } from './EmbeddingProviderResolver';
import { IEmbeddingProvider } from './providers/IEmbeddingProvider';
import { LocalEmbeddingProvider } from './providers/LocalEmbeddingProvider';
import { ActiveMeeting } from '../services/ActiveMeeting';

const MAX_RETRIES = 3;
const RETRY_DELAY_BASE_MS = 2000;

export class EmbeddingPipeline {
    private provider: IEmbeddingProvider | null = null;
    /** Always-available on-device fallback (MiniLM). Null only if the bundled model is corrupted. */
    private fallbackProvider: IEmbeddingProvider | null = null;
    /** Meetings downgraded to local fallback after primary provider exhaustion. */
    private fallbackMeetings = new Set<string>();
    private vectorStore: VectorStore;
    private pending = new Set<string>();
    private isProcessing = false;
    private initPromise: Promise<void> | null = null;

    constructor(vectorStore: VectorStore) {
        this.vectorStore = vectorStore;
    }

    // Cloud-only: the embedding provider (cloud gateway → bundled local fallback) is
    // resolved without any per-user keys. Idempotent — resolves once.
    async initialize(): Promise<void> {
        if (this.initPromise) return this.initPromise;
        console.log('[EmbeddingPipeline] Initializing embedding provider…');
        this.initPromise = this._doInitialize();
        return this.initPromise;
    }

    private async _doInitialize(): Promise<void> {
        // Local fallback first, so it's always available even if the primary throws.
        try {
            const local = new LocalEmbeddingProvider();
            if (await local.isAvailable()) {
                this.fallbackProvider = local;
                console.log(`[EmbeddingPipeline] Local fallback provider ready (${local.dimensions}d)`);
            } else {
                console.warn('[EmbeddingPipeline] Local fallback provider unavailable — bundled model may be missing');
            }
        } catch (e) {
            console.warn('[EmbeddingPipeline] Could not initialize local fallback provider:', e);
        }

        try {
            this.provider = await EmbeddingProviderResolver.resolve();
            console.log(`[EmbeddingPipeline] Ready with provider: ${this.provider.name} (${this.provider.dimensions}d)`);
            if (this.provider instanceof LocalEmbeddingProvider) {
                this.fallbackProvider = this.provider;
            }
        } catch (err) {
            console.error('[EmbeddingPipeline] Failed to initialize primary provider:', err);
            if (!this.fallbackProvider) throw err;
            console.warn('[EmbeddingPipeline] Falling back to local-only mode for all meetings.');
            this.provider = this.fallbackProvider;
        }
    }

    isReady(): boolean {
        return this.provider !== null;
    }

    async waitForReady(timeoutMs: number = 15000): Promise<void> {
        if (this.provider) return;
        if (this.initPromise) {
            await Promise.race([
                this.initPromise,
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error(`Embedding pipeline initialization timed out after ${timeoutMs}ms`)), timeoutMs),
                ),
            ]);
            return;
        }
        throw new Error('Embedding pipeline has not been initialized');
    }

    getActiveProviderName(): string | undefined {
        return this.provider?.name;
    }

    // Live indexing and query embeds run during an active meeting, so attribute their usage to
    // it by default (callers may override). Post-meeting batch embedding passes its own id via
    // embedMeeting → embedWithRetry. meetingId resolves to null when no meeting is active.
    async getEmbedding(text: string, meetingId: string | null = ActiveMeeting.get()): Promise<number[]> {
        if (!this.provider) throw new Error('Embedding provider not initialized');
        return this.provider.embed(text, { meetingId });
    }

    async getEmbeddingForQuery(text: string, meetingId: string | null = ActiveMeeting.get()): Promise<number[]> {
        if (!this.provider) throw new Error('Embedding provider not initialized');
        return this.provider.embedQuery(text, { meetingId });
    }

    /** Queue a meeting for embedding (called when a meeting ends / is reprocessed). */
    async queueMeeting(meetingId: string): Promise<void> {
        const chunks = this.vectorStore.getChunksWithoutEmbeddings(meetingId);
        if (chunks.length === 0 && !this.vectorStore.getSummaryText(meetingId)) {
            console.log(`[EmbeddingPipeline] Nothing to embed for meeting ${meetingId}`);
            return;
        }
        this.pending.add(meetingId);
        await this.processQueue();
    }

    /** Embed all pending meetings. */
    async processQueue(): Promise<void> {
        if (this.isProcessing) return;
        if (!this.provider) {
            console.log('[EmbeddingPipeline] No provider, skipping queue processing');
            return;
        }
        this.isProcessing = true;
        try {
            for (const meetingId of [...this.pending]) {
                await this.embedMeeting(meetingId);
            }
        } finally {
            this.isProcessing = false;
        }
    }

    private async embedMeeting(meetingId: string): Promise<void> {
        const useFallback = this.fallbackMeetings.has(meetingId);
        const provider = useFallback ? this.fallbackProvider : this.provider;
        if (!provider) return;

        const chunks = this.vectorStore.getChunksWithoutEmbeddings(meetingId);
        for (const chunk of chunks) {
            try {
                const embedding = await this.embedWithRetry(chunk.text, provider, meetingId);
                await this.vectorStore.storeEmbedding(chunk.id, embedding);
            } catch (err) {
                if (!useFallback && this.fallbackProvider) {
                    console.warn(`[EmbeddingPipeline] Primary exhausted for ${meetingId}; switching to local fallback.`);
                    await this.activateMeetingFallback(meetingId);
                    return this.embedMeeting(meetingId); // restart with fallback provider
                }
                console.error(`[EmbeddingPipeline] Failed to embed chunk for ${meetingId}, leaving pending:`, err);
                return; // stays pending for a later retry
            }
        }

        const summaryText = this.vectorStore.getSummaryText(meetingId);
        if (summaryText) {
            try {
                const embedding = await this.embedWithRetry(summaryText, provider, meetingId);
                await this.vectorStore.storeSummaryEmbedding(meetingId, embedding);
            } catch (err) {
                console.error(`[EmbeddingPipeline] Failed to embed summary for ${meetingId}:`, err);
            }
        }

        this.pending.delete(meetingId);
        console.log(`[EmbeddingPipeline] Embedded meeting ${meetingId} via ${provider.name}`);
    }

    private async embedWithRetry(text: string, provider: IEmbeddingProvider, meetingId?: string): Promise<number[]> {
        let lastErr: any;
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                return await provider.embed(text, { meetingId });
            } catch (err) {
                lastErr = err;
                if (attempt < MAX_RETRIES - 1) {
                    await this.delay(RETRY_DELAY_BASE_MS * Math.pow(2, attempt));
                }
            }
        }
        throw lastErr;
    }

    private async activateMeetingFallback(meetingId: string): Promise<void> {
        if (!this.fallbackProvider) return;
        const fallback = this.fallbackProvider;
        // Clear any partial cloud embeddings so dimensions can't clash; chunks stay buffered.
        await this.vectorStore.clearEmbeddingsForMeeting(meetingId);
        this.fallbackMeetings.add(meetingId);
        try {
            const { BrowserWindow } = require('electron');
            BrowserWindow.getAllWindows().forEach((win: any) => {
                if (!win.isDestroyed()) {
                    win.webContents.send('embedding:fallback-activated', {
                        meetingId,
                        fallbackProvider: fallback.name,
                        reason: 'Primary embedding provider failed after max retries',
                    });
                }
            });
        } catch { /* non-fatal */ }
    }

    getQueueStatus(): { pending: number; processing: number; completed: number; failed: number } {
        let pending = 0;
        for (const meetingId of this.pending) {
            pending += this.vectorStore.getChunksWithoutEmbeddings(meetingId).length;
        }
        return { pending, processing: this.isProcessing ? 1 : 0, completed: 0, failed: 0 };
    }

    cleanupQueue(_daysOld: number = 7): void {
        /* No persistent queue in the cloud model — nothing to clean up. */
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
