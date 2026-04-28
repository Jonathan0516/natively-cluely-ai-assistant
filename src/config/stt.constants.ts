/**
 * OpenAI-only Speech-to-Text configuration.
 */

export type SttProviderId = 'openai';

export interface SttProviderConfig {
    id: SttProviderId;
    name: string;
    description: string;
    endpoint: string;
    model: string;
    uploadType: 'multipart' | 'websocket';
    authHeader: (apiKey: string) => Record<string, string>;
    responseContentPath: string;
}

export const STT_PROVIDERS: Record<SttProviderId, SttProviderConfig> = {
    openai: {
        id: 'openai',
        name: 'OpenAI Whisper',
        description: 'Transcription via OpenAI Realtime with Whisper REST fallback',
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'whisper-1',
        uploadType: 'multipart',
        authHeader: (apiKey: string) => ({ Authorization: `Bearer ${apiKey}` }),
        responseContentPath: 'text',
    },
};

export const STT_PROVIDER_OPTIONS = Object.values(STT_PROVIDERS);
export const DEFAULT_STT_PROVIDER: SttProviderId = 'openai';
