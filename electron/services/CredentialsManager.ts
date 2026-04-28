import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';

const CREDENTIALS_PATH = path.join(app.getPath('userData'), 'credentials.enc');
const OPENAI_MODEL = 'gpt-5.4';

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
    openaiApiKey?: string;
    openAiSttApiKey?: string;
    defaultModel?: string;
    sttProvider?: 'openai';
    sttLanguage?: string;
    aiResponseLanguage?: string;
    tavilyApiKey?: string;
    openaiPreferredModel?: string;
    trialToken?: string;
    trialExpiresAt?: string;
    trialStartedAt?: string;
    trialClaimed?: boolean;
}

export class CredentialsManager {
    private static instance: CredentialsManager;
    private credentials: StoredCredentials = {};

    public static getInstance(): CredentialsManager {
        if (!CredentialsManager.instance) {
            CredentialsManager.instance = new CredentialsManager();
        }
        return CredentialsManager.instance;
    }

    public init(): void {
        this.loadCredentials();
        this.normalizeOpenAIOnlyCredentials();
        console.log('[CredentialsManager] Initialized OpenAI-only credentials');
    }

    public getOpenaiApiKey(): string | undefined {
        return this.credentials.openaiApiKey || process.env.OPENAI_API_KEY || undefined;
    }

    public getOpenAiSttApiKey(): string | undefined {
        return this.credentials.openAiSttApiKey || this.getOpenaiApiKey();
    }

    public getSttProvider(): 'openai' {
        return 'openai';
    }

    public getDefaultModel(): string {
        return this.credentials.defaultModel || OPENAI_MODEL;
    }

    public getSttLanguage(): string {
        return this.credentials.sttLanguage || 'english-us';
    }

    public getAiResponseLanguage(): string {
        return this.credentials.aiResponseLanguage || 'auto';
    }

    public getTavilyApiKey(): string | undefined {
        return this.credentials.tavilyApiKey;
    }

    public getPreferredModel(provider: 'openai' | string): string | undefined {
        return provider === 'openai' ? this.credentials.openaiPreferredModel : undefined;
    }

    public getAllCredentials(): StoredCredentials {
        return { ...this.credentials, sttProvider: 'openai', defaultModel: this.getDefaultModel() };
    }

    public setOpenaiApiKey(key: string): void {
        this.credentials.openaiApiKey = key.trim() || undefined;
        this.saveCredentials();
        console.log('[CredentialsManager] OpenAI API Key updated');
    }

    public setOpenAiSttApiKey(key: string): void {
        this.credentials.openAiSttApiKey = key.trim() || undefined;
        this.saveCredentials();
        console.log('[CredentialsManager] OpenAI STT API Key updated');
    }

    public setSttProvider(_provider: string): void {
        this.credentials.sttProvider = 'openai';
        this.saveCredentials();
        console.log('[CredentialsManager] STT Provider fixed to OpenAI');
    }

    public setDefaultModel(model: string): void {
        this.credentials.defaultModel = model?.trim() || OPENAI_MODEL;
        this.saveCredentials();
        console.log(`[CredentialsManager] Default OpenAI model set to: ${this.credentials.defaultModel}`);
    }

    public setSttLanguage(language: string): void {
        this.credentials.sttLanguage = language || 'english-us';
        this.saveCredentials();
    }

    public setAiResponseLanguage(language: string): void {
        this.credentials.aiResponseLanguage = language || 'auto';
        this.saveCredentials();
    }

    public setTavilyApiKey(key: string): void {
        this.credentials.tavilyApiKey = key.trim() || undefined;
        this.saveCredentials();
    }

    public setPreferredModel(provider: 'openai' | string, modelId: string): void {
        if (provider === 'openai') {
            this.credentials.openaiPreferredModel = modelId;
            this.saveCredentials();
        }
    }

    // Removed provider compatibility stubs. They intentionally do not persist data.
    public getGeminiApiKey(): undefined { return undefined; }
    public getGroqApiKey(): undefined { return undefined; }
    public getClaudeApiKey(): undefined { return undefined; }
    public getNativelyApiKey(): undefined { return undefined; }
    public getGoogleServiceAccountPath(): undefined { return undefined; }
    public getDeepgramApiKey(): undefined { return undefined; }
    public getGroqSttApiKey(): undefined { return undefined; }
    public getGroqSttModel(): string { return ''; }
    public getElevenLabsApiKey(): undefined { return undefined; }
    public getAzureApiKey(): undefined { return undefined; }
    public getAzureRegion(): string { return ''; }
    public getIbmWatsonApiKey(): undefined { return undefined; }
    public getIbmWatsonRegion(): string { return ''; }
    public getSonioxApiKey(): undefined { return undefined; }
    public getCustomProviders(): CustomProvider[] { return []; }
    public getCurlProviders(): CurlProvider[] { return []; }
    public setGeminiApiKey(_key: string): void { this.saveCredentials(); }
    public setGroqApiKey(_key: string): void { this.saveCredentials(); }
    public setClaudeApiKey(_key: string): void { this.saveCredentials(); }
    public setNativelyApiKey(_key: string): void { this.saveCredentials(); }
    public setGoogleServiceAccountPath(_filePath: string): void { this.saveCredentials(); }
    public setDeepgramApiKey(_key: string): void { this.saveCredentials(); }
    public setGroqSttApiKey(_key: string): void { this.saveCredentials(); }
    public setGroqSttModel(_model: string): void { this.saveCredentials(); }
    public setElevenLabsApiKey(_key: string): void { this.saveCredentials(); }
    public setAzureApiKey(_key: string): void { this.saveCredentials(); }
    public setAzureRegion(_region: string): void { this.saveCredentials(); }
    public setIbmWatsonApiKey(_key: string): void { this.saveCredentials(); }
    public setIbmWatsonRegion(_region: string): void { this.saveCredentials(); }
    public setSonioxApiKey(_key: string): void { this.saveCredentials(); }
    public saveCustomProvider(_provider: CustomProvider): void { this.saveCredentials(); }
    public deleteCustomProvider(_id: string): void { this.saveCredentials(); }
    public saveCurlProvider(_provider: CurlProvider): void { this.saveCredentials(); }
    public deleteCurlProvider(_id: string): void { this.saveCredentials(); }

    public getTrialToken(): string | undefined { return this.credentials.trialToken; }
    public getTrialExpiresAt(): string | undefined { return this.credentials.trialExpiresAt; }
    public getTrialStartedAt(): string | undefined { return this.credentials.trialStartedAt; }
    public getTrialClaimed(): boolean { return this.credentials.trialClaimed === true; }

    public setTrialToken(token: string, expiresAt: string, startedAt: string): void {
        this.credentials.trialToken = token;
        this.credentials.trialExpiresAt = expiresAt;
        this.credentials.trialStartedAt = startedAt;
        this.credentials.trialClaimed = true;
        this.saveCredentials();
    }

    public clearTrialToken(): void {
        delete this.credentials.trialToken;
        delete this.credentials.trialExpiresAt;
        delete this.credentials.trialStartedAt;
        this.saveCredentials();
    }

    public clearAll(): void {
        this.scrubMemory();
        if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
        const plaintextPath = CREDENTIALS_PATH + '.json';
        if (fs.existsSync(plaintextPath)) fs.unlinkSync(plaintextPath);
    }

    public scrubMemory(): void {
        for (const key of Object.keys(this.credentials) as (keyof StoredCredentials)[]) {
            if (typeof this.credentials[key] === 'string') {
                (this.credentials as any)[key] = '';
            }
        }
        this.credentials = {};
    }

    private normalizeOpenAIOnlyCredentials(): void {
        const raw = this.credentials as any;
        this.credentials = {
            openaiApiKey: raw.openaiApiKey,
            openAiSttApiKey: raw.openAiSttApiKey,
            defaultModel: raw.defaultModel && String(raw.defaultModel).startsWith('gpt-') ? raw.defaultModel : OPENAI_MODEL,
            sttProvider: 'openai',
            sttLanguage: raw.sttLanguage,
            aiResponseLanguage: raw.aiResponseLanguage,
            tavilyApiKey: raw.tavilyApiKey,
            openaiPreferredModel: raw.openaiPreferredModel,
            trialToken: raw.trialToken,
            trialExpiresAt: raw.trialExpiresAt,
            trialStartedAt: raw.trialStartedAt,
            trialClaimed: raw.trialClaimed,
        };
        this.saveCredentials();
    }

    private saveCredentials(): void {
        try {
            const data = JSON.stringify(this.credentials);
            if (!safeStorage.isEncryptionAvailable()) {
                fs.writeFileSync(CREDENTIALS_PATH + '.json', data);
                return;
            }
            fs.writeFileSync(CREDENTIALS_PATH, safeStorage.encryptString(data));
        } catch (error) {
            console.error('[CredentialsManager] Failed to save credentials:', error);
        }
    }

    private loadCredentials(): void {
        try {
            if (fs.existsSync(CREDENTIALS_PATH) && safeStorage.isEncryptionAvailable()) {
                this.credentials = JSON.parse(safeStorage.decryptString(fs.readFileSync(CREDENTIALS_PATH)));
                return;
            }
            const plaintextPath = CREDENTIALS_PATH + '.json';
            if (fs.existsSync(plaintextPath)) {
                this.credentials = JSON.parse(fs.readFileSync(plaintextPath, 'utf-8'));
                return;
            }
            this.credentials = {};
        } catch (error) {
            console.error('[CredentialsManager] Failed to load credentials:', error);
            this.credentials = {};
        }
    }
}
