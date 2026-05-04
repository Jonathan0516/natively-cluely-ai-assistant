// PricingTable.ts
// Per-model pricing for token usage and STT services.
// Rates are USD per 1M tokens (LLM) or USD per minute (STT).
// Update when providers change pricing.

export type LLMProvider = 'openai' | 'anthropic' | 'groq' | 'gemini' | 'ollama' | 'natively' | 'custom';
export type STTProvider = 'whisper' | 'deepgram' | 'soniox' | 'elevenlabs' | 'google';

interface LLMRate {
    inputPer1M: number;
    outputPer1M: number;
    cachedInputPer1M?: number;
}

const LLM_RATES: Record<string, LLMRate> = {
    // OpenAI
    'gpt-5.4': { inputPer1M: 1.25, outputPer1M: 10.0 },
    'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
    'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
    'gpt-4-turbo': { inputPer1M: 10.0, outputPer1M: 30.0 },

    // Anthropic
    'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'claude-opus-4-7': { inputPer1M: 15.0, outputPer1M: 75.0 },
    'claude-haiku-4-5': { inputPer1M: 1.0, outputPer1M: 5.0 },

    // Google Gemini
    'gemini-3.1-flash-lite-preview': { inputPer1M: 0.075, outputPer1M: 0.3 },
    'gemini-3.1-pro-preview': { inputPer1M: 1.25, outputPer1M: 10.0 },
    'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },

    // Groq (Llama)
    'llama-3.3-70b-versatile': { inputPer1M: 0.59, outputPer1M: 0.79 },
    'llama-3.1-8b-instant': { inputPer1M: 0.05, outputPer1M: 0.08 },
};

// USD per minute of audio
const STT_RATES: Record<string, number> = {
    whisper: 0.006,
    'whisper-1': 0.006,
    'gpt-4o-transcribe': 0.006,
    deepgram: 0.0043,         // Nova-3 streaming
    'nova-3': 0.0043,
    soniox: 0.0067,
    elevenlabs: 0.005,
    google: 0.024,            // Google STT enhanced
};

export function getLLMRate(model: string): LLMRate | null {
    if (LLM_RATES[model]) return LLM_RATES[model];
    // Fuzzy match: try lowercase prefix match
    const lower = model.toLowerCase();
    for (const [key, rate] of Object.entries(LLM_RATES)) {
        if (lower.startsWith(key.toLowerCase()) || key.toLowerCase().startsWith(lower)) {
            return rate;
        }
    }
    return null;
}

export function estimateLLMCost(model: string, inputTokens: number, outputTokens: number): number {
    const rate = getLLMRate(model);
    if (!rate) return 0;
    return (inputTokens / 1_000_000) * rate.inputPer1M + (outputTokens / 1_000_000) * rate.outputPer1M;
}

export function estimateSTTCost(provider: string, seconds: number): number {
    const rate = STT_RATES[provider.toLowerCase()] ?? 0;
    return (seconds / 60) * rate;
}

export function getSTTRate(provider: string): number {
    return STT_RATES[provider.toLowerCase()] ?? 0;
}
