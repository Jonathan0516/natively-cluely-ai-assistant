/**
 * CredentialsManager - Secure storage for API keys and service account paths
 * Uses Electron's safeStorage API for encryption at rest
 */

import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';

const CREDENTIALS_PATH = path.join(app.getPath('userData'), 'credentials.enc');

// Legacy shape kept only so the LLMHelper.setModel signature and any persisted
// blobs still type-check. Custom/curl provider selection is no longer supported.
export interface CustomProvider {
    id: string;
    name: string;
    curlCommand: string;
}

export interface CurlProvider {
    id: string;
    name: string;
    curlCommand: string;
    responsePath: string;
}

export interface StoredCredentials {
    defaultModel?: string;
    // STT on/off. Cloud-only: transcription always runs through the backend
    // Deepgram WS relay (platform key); 'none' disables it.
    sttProvider?: 'none' | 'deepgram';
    sttLanguage?: string;
    aiResponseLanguage?: string;
    // Tavily Search (web search — not an LLM/STT provider key)
    tavilyApiKey?: string;
}

export class CredentialsManager {
    private static instance: CredentialsManager;
    private credentials: StoredCredentials = {};

    private constructor() {
        // Load on construction after app ready
    }

    public static getInstance(): CredentialsManager {
        if (!CredentialsManager.instance) {
            CredentialsManager.instance = new CredentialsManager();
        }
        return CredentialsManager.instance;
    }

    /**
     * Initialize - load credentials from disk
     * Must be called after app.whenReady()
     */
    public init(): void {
        this.loadCredentials();
        console.log('[CredentialsManager] Initialized');
    }

    // =========================================================================
    // Getters
    // =========================================================================

    public getSttProvider(): 'none' | 'deepgram' {
        return this.credentials.sttProvider || 'deepgram';
    }

    public getTavilyApiKey(): string | undefined {
        return this.credentials.tavilyApiKey;
    }

    public getSttLanguage(): string {
        return this.credentials.sttLanguage || 'english-us';
    }

    public getAiResponseLanguage(): string {
        return this.credentials.aiResponseLanguage || 'auto';
    }
    public getDefaultModel(): string {
        // Cloud-only: default is the gateway's fast tier (catalog id). Falls back here only
        // when the user hasn't picked a model.
        return this.credentials.defaultModel || 'gemini-2.5-flash-lite';
    }

    public getAllCredentials(): StoredCredentials {
        return { ...this.credentials };
    }

    // =========================================================================
    // Setters (auto-save)
    // =========================================================================

    public setSttProvider(provider: 'none' | 'deepgram'): void {
        this.credentials.sttProvider = provider;
        this.saveCredentials();
        console.log(`[CredentialsManager] STT enabled = ${provider !== 'none'}`);
    }

    public setTavilyApiKey(key: string): void {
        // Store undefined (not empty string) when removing, so hasKey() checks stay consistent
        this.credentials.tavilyApiKey = key.trim() || undefined;
        this.saveCredentials();
        console.log('[CredentialsManager] Tavily API Key updated');
    }

    public setSttLanguage(language: string): void {
        this.credentials.sttLanguage = language;
        this.saveCredentials();
        console.log(`[CredentialsManager] STT Language set to: ${language}`);
    }

    public setAiResponseLanguage(language: string): void {
        this.credentials.aiResponseLanguage = language;
        this.saveCredentials();
        console.log(`[CredentialsManager] AI Response Language set to: ${language}`);
    }
    public setDefaultModel(model: string): void {
        this.credentials.defaultModel = model;
        this.saveCredentials();
        console.log(`[CredentialsManager] Default Model set to: ${model}`);
    }

    public clearAll(): void {
        this.scrubMemory();
        if (fs.existsSync(CREDENTIALS_PATH)) {
            fs.unlinkSync(CREDENTIALS_PATH);
        }
        const plaintextPath = CREDENTIALS_PATH + '.json';
        if (fs.existsSync(plaintextPath)) {
            fs.unlinkSync(plaintextPath);
        }
        console.log('[CredentialsManager] All credentials cleared');
    }

    /**
     * Scrub all API keys from memory to minimize exposure window.
     * Called on app quit and credential clear.
     */
    public scrubMemory(): void {
        // Overwrite each string field with empty before discarding
        for (const key of Object.keys(this.credentials) as (keyof StoredCredentials)[]) {
            const val = this.credentials[key];
            if (typeof val === 'string') {
                (this.credentials as any)[key] = '';
            }
        }
        this.credentials = {};
        console.log('[CredentialsManager] Memory scrubbed');
    }

    // =========================================================================
    // Storage (Encrypted)
    // =========================================================================

    private saveCredentials(): void {
        try {
            if (!safeStorage.isEncryptionAvailable()) {
                console.warn('[CredentialsManager] Encryption not available, falling back to plaintext');
                // Fallback: save as plaintext (less secure, but functional)
                const plainPath = CREDENTIALS_PATH + '.json';
                const tmpPlain = plainPath + '.tmp';
                fs.writeFileSync(tmpPlain, JSON.stringify(this.credentials));
                fs.renameSync(tmpPlain, plainPath);
                return;
            }

            const data = JSON.stringify(this.credentials);
            const encrypted = safeStorage.encryptString(data);
            const tmpEnc = CREDENTIALS_PATH + '.tmp';
            fs.writeFileSync(tmpEnc, encrypted);
            fs.renameSync(tmpEnc, CREDENTIALS_PATH);
        } catch (error) {
            console.error('[CredentialsManager] Failed to save credentials:', error);
        }
    }

    private loadCredentials(): void {
        try {
            // Try encrypted file first
            if (fs.existsSync(CREDENTIALS_PATH)) {
                if (!safeStorage.isEncryptionAvailable()) {
                    console.warn('[CredentialsManager] Encryption not available for load');
                    return;
                }

                const encrypted = fs.readFileSync(CREDENTIALS_PATH);
                const decrypted = safeStorage.decryptString(encrypted);
                try {
                    const parsed = JSON.parse(decrypted);
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.credentials = parsed;
                        console.log('[CredentialsManager] Loaded encrypted credentials');
                    } else {
                        throw new Error('Decrypted credentials is not a valid object');
                    }
                } catch (parseError) {
                    console.error('[CredentialsManager] Failed to parse decrypted credentials — file may be corrupted. Starting fresh:', parseError);
                    this.credentials = {};
                }

                // Clean up any leftover plaintext fallback file to eliminate the data leak
                const plaintextPath = CREDENTIALS_PATH + '.json';
                if (fs.existsSync(plaintextPath)) {
                    try {
                        fs.unlinkSync(plaintextPath);
                        console.log('[CredentialsManager] Removed stale plaintext credential file');
                    } catch (cleanupErr) {
                        console.warn('[CredentialsManager] Could not remove stale plaintext file:', cleanupErr);
                    }
                }
                return;
            }

            // Fallback: try plaintext file
            const plaintextPath = CREDENTIALS_PATH + '.json';
            if (fs.existsSync(plaintextPath)) {
                const data = fs.readFileSync(plaintextPath, 'utf-8');
                try {
                    const parsed = JSON.parse(data);
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.credentials = parsed;
                        console.log('[CredentialsManager] Loaded plaintext credentials');
                    } else {
                        throw new Error('Plaintext credentials is not a valid object');
                    }
                } catch (parseError) {
                    console.error('[CredentialsManager] Failed to parse plaintext credentials — file may be corrupted. Starting fresh:', parseError);
                    this.credentials = {};
                }
                return;
            }

            console.log('[CredentialsManager] No stored credentials found');
        } catch (error) {
            console.error('[CredentialsManager] Failed to load credentials:', error);
            this.credentials = {};
        }
    }
}
