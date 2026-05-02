// TokenUsageTracker.ts
// Global per-session aggregator for LLM token usage and STT audio seconds.
// LLMHelper / STT services call .recordLLM() / .recordSTT() when an API response returns.
// MeetingPersistence calls .snapshot() on stop, then .reset() for the next meeting.

import { estimateLLMCost, estimateSTTCost, LLMProvider, STTProvider } from './PricingTable';

export interface LLMUsageEntry {
    provider: LLMProvider;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    timestamp: number;
    cost: number;
}

export interface STTUsageEntry {
    provider: STTProvider | string;
    seconds: number;
    timestamp: number;
    cost: number;
}

export interface ProviderAggregate {
    provider: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    callCount: number;
    cost: number;
}

export interface TokenUsageSnapshot {
    llmEntries: LLMUsageEntry[];
    sttEntries: STTUsageEntry[];
    totals: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        sttSeconds: number;
        llmCost: number;
        sttCost: number;
        totalCost: number;
        llmCallCount: number;
    };
    byProvider: ProviderAggregate[];
    byModel: ProviderAggregate[];
}

class TokenUsageTrackerImpl {
    private llmEntries: LLMUsageEntry[] = [];
    private sttEntries: STTUsageEntry[] = [];

    recordLLM(provider: LLMProvider, model: string, usage: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
    }): void {
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cachedInputTokens = usage.cachedInputTokens ?? 0;
        if (inputTokens === 0 && outputTokens === 0) return;

        const cost = estimateLLMCost(model, inputTokens, outputTokens);
        this.llmEntries.push({
            provider,
            model,
            inputTokens,
            outputTokens,
            cachedInputTokens,
            timestamp: Date.now(),
            cost,
        });
    }

    recordSTT(provider: STTProvider | string, seconds: number): void {
        if (!seconds || seconds <= 0) return;
        const cost = estimateSTTCost(provider, seconds);
        this.sttEntries.push({
            provider,
            seconds,
            timestamp: Date.now(),
            cost,
        });
    }

    /**
     * Extract usage from any LLM SDK response shape (OpenAI/Groq/Anthropic/Gemini).
     * Returns null if no usage data found. Records automatically if found.
     */
    recordFromResponse(provider: LLMProvider, model: string, response: any): { input: number; output: number } | null {
        if (!response) return null;
        let inputTokens = 0;
        let outputTokens = 0;
        let cachedInputTokens = 0;

        // OpenAI / Groq shape: response.usage = { prompt_tokens, completion_tokens, prompt_tokens_details: { cached_tokens } }
        if (response.usage) {
            const u = response.usage;
            if (typeof u.prompt_tokens === 'number') inputTokens = u.prompt_tokens;
            if (typeof u.completion_tokens === 'number') outputTokens = u.completion_tokens;
            if (u.prompt_tokens_details?.cached_tokens) cachedInputTokens = u.prompt_tokens_details.cached_tokens;

            // Anthropic shape: response.usage = { input_tokens, output_tokens, cache_read_input_tokens }
            if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
            if (typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
            if (typeof u.cache_read_input_tokens === 'number') cachedInputTokens = u.cache_read_input_tokens;
        }

        // Gemini shape: response.usageMetadata = { promptTokenCount, candidatesTokenCount, cachedContentTokenCount }
        if (response.usageMetadata) {
            const u = response.usageMetadata;
            if (typeof u.promptTokenCount === 'number') inputTokens = u.promptTokenCount;
            if (typeof u.candidatesTokenCount === 'number') outputTokens = u.candidatesTokenCount;
            if (typeof u.cachedContentTokenCount === 'number') cachedInputTokens = u.cachedContentTokenCount;
        }

        if (inputTokens === 0 && outputTokens === 0) return null;

        this.recordLLM(provider, model, { inputTokens, outputTokens, cachedInputTokens });
        return { input: inputTokens, output: outputTokens };
    }

    snapshot(): TokenUsageSnapshot {
        const totals = {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            sttSeconds: 0,
            llmCost: 0,
            sttCost: 0,
            totalCost: 0,
            llmCallCount: this.llmEntries.length,
        };

        const providerMap = new Map<string, ProviderAggregate>();
        const modelMap = new Map<string, ProviderAggregate>();

        for (const e of this.llmEntries) {
            totals.inputTokens += e.inputTokens;
            totals.outputTokens += e.outputTokens;
            totals.cachedInputTokens += e.cachedInputTokens ?? 0;
            totals.llmCost += e.cost;

            const pKey = e.provider;
            const pAgg = providerMap.get(pKey) ?? {
                provider: pKey,
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                callCount: 0,
                cost: 0,
            };
            pAgg.inputTokens += e.inputTokens;
            pAgg.outputTokens += e.outputTokens;
            pAgg.cachedInputTokens += e.cachedInputTokens ?? 0;
            pAgg.callCount += 1;
            pAgg.cost += e.cost;
            providerMap.set(pKey, pAgg);

            const mKey = `${e.provider}:${e.model}`;
            const mAgg = modelMap.get(mKey) ?? {
                provider: e.provider,
                model: e.model,
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                callCount: 0,
                cost: 0,
            };
            mAgg.inputTokens += e.inputTokens;
            mAgg.outputTokens += e.outputTokens;
            mAgg.cachedInputTokens += e.cachedInputTokens ?? 0;
            mAgg.callCount += 1;
            mAgg.cost += e.cost;
            modelMap.set(mKey, mAgg);
        }

        for (const e of this.sttEntries) {
            totals.sttSeconds += e.seconds;
            totals.sttCost += e.cost;

            const pKey = `stt:${e.provider}`;
            const pAgg = providerMap.get(pKey) ?? {
                provider: pKey,
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                callCount: 0,
                cost: 0,
            };
            pAgg.callCount += 1;
            pAgg.cost += e.cost;
            providerMap.set(pKey, pAgg);
        }

        totals.totalCost = totals.llmCost + totals.sttCost;

        return {
            llmEntries: [...this.llmEntries],
            sttEntries: [...this.sttEntries],
            totals,
            byProvider: Array.from(providerMap.values()).sort((a, b) => b.cost - a.cost),
            byModel: Array.from(modelMap.values()).sort((a, b) => b.cost - a.cost),
        };
    }

    reset(): void {
        this.llmEntries = [];
        this.sttEntries = [];
    }

    isEmpty(): boolean {
        return this.llmEntries.length === 0 && this.sttEntries.length === 0;
    }
}

export const TokenUsageTracker = new TokenUsageTrackerImpl();

/**
 * Merge two TokenUsageSnapshots. Used when extending an in-meeting snapshot with
 * post-meeting summary-generation tokens (or when recovering an unprocessed meeting).
 */
export function mergeTokenUsageSnapshots(a: TokenUsageSnapshot | undefined | null, b: TokenUsageSnapshot | undefined | null): TokenUsageSnapshot | null {
    if (!a && !b) return null;
    if (!a) return b!;
    if (!b) return a!;

    const aggregateMap = new Map<string, ProviderAggregate>();
    const seedAggregates = (list: ProviderAggregate[], keyer: (p: ProviderAggregate) => string) => {
        for (const p of list) {
            const k = keyer(p);
            const existing = aggregateMap.get(k);
            if (existing) {
                existing.inputTokens += p.inputTokens;
                existing.outputTokens += p.outputTokens;
                existing.cachedInputTokens += p.cachedInputTokens;
                existing.callCount += p.callCount;
                existing.cost += p.cost;
            } else {
                aggregateMap.set(k, { ...p });
            }
        }
    };

    const providerMap = new Map<string, ProviderAggregate>();
    const modelMap = new Map<string, ProviderAggregate>();
    for (const p of [...a.byProvider, ...b.byProvider]) {
        const k = p.provider;
        const e = providerMap.get(k);
        if (e) {
            e.inputTokens += p.inputTokens;
            e.outputTokens += p.outputTokens;
            e.cachedInputTokens += p.cachedInputTokens;
            e.callCount += p.callCount;
            e.cost += p.cost;
        } else {
            providerMap.set(k, { ...p });
        }
    }
    for (const m of [...a.byModel, ...b.byModel]) {
        const k = `${m.provider}:${m.model ?? ''}`;
        const e = modelMap.get(k);
        if (e) {
            e.inputTokens += m.inputTokens;
            e.outputTokens += m.outputTokens;
            e.cachedInputTokens += m.cachedInputTokens;
            e.callCount += m.callCount;
            e.cost += m.cost;
        } else {
            modelMap.set(k, { ...m });
        }
    }

    return {
        llmEntries: [...a.llmEntries, ...b.llmEntries],
        sttEntries: [...a.sttEntries, ...b.sttEntries],
        totals: {
            inputTokens: a.totals.inputTokens + b.totals.inputTokens,
            outputTokens: a.totals.outputTokens + b.totals.outputTokens,
            cachedInputTokens: a.totals.cachedInputTokens + b.totals.cachedInputTokens,
            sttSeconds: a.totals.sttSeconds + b.totals.sttSeconds,
            llmCost: a.totals.llmCost + b.totals.llmCost,
            sttCost: a.totals.sttCost + b.totals.sttCost,
            totalCost: a.totals.totalCost + b.totals.totalCost,
            llmCallCount: a.totals.llmCallCount + b.totals.llmCallCount,
        },
        byProvider: Array.from(providerMap.values()).sort((x, y) => y.cost - x.cost),
        byModel: Array.from(modelMap.values()).sort((x, y) => y.cost - x.cost),
    };
}
