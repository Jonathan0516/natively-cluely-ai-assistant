/**
 * DeepgramStreamingSTT — streams audio to the backend STT gateway (WS /llm/stt),
 * which reverse-proxies Deepgram with the platform key and meters usage.
 * Keeps the same interface as before:
 *   Events: 'transcript' ({ text, isFinal, confidence }), 'error' (Error)
 *   Methods: start(), stop(), write(chunk), setSampleRate(), setAudioChannelCount(),
 *            setRecognitionLanguage(), setCredentials()
 */
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import { CloudClient } from '../services/CloudClient';

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;
const STT_MODEL = 'nova-3';

export class DeepgramStreamingSTT extends EventEmitter {
    private ws: WebSocket | null = null;
    private isActive = false;
    private isOpen = false;
    private connecting = false;
    private fatal = false; // auth/quota close — do not reconnect

    private sampleRate = 16000;
    private numChannels = 1;
    private languageCode = 'en';

    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private buffer: Buffer[] = [];

    public setSampleRate(rate: number): void {
        if (this.sampleRate === rate) return;
        this.sampleRate = rate;
        if (this.isActive) this.restart();
    }

    public setAudioChannelCount(count: number): void {
        if (this.numChannels === count) return;
        this.numChannels = count;
        if (this.isActive) this.restart();
    }

    public setRecognitionLanguage(key: string): void {
        if (key === 'auto') {
            if (this.languageCode === 'multi') return;
            this.languageCode = 'multi';
            if (this.isActive) this.restart();
            return;
        }
        const config = RECOGNITION_LANGUAGES[key];
        if (config && this.languageCode !== config.iso639) {
            this.languageCode = config.iso639;
            if (this.isActive) this.restart();
        }
    }

    public setCredentials(_path: string): void { }

    private restart(): void {
        this.stop();
        this.start();
    }

    public start(): void {
        if (this.isActive) return;
        this.isActive = true;
        this.fatal = false;
        this.reconnectAttempts = 0;
        void this.connect();
    }

    public stop(): void {
        this.isActive = false;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) {
            try { this.ws.close(1000); } catch { /* ignore */ }
            this.ws = null;
        }
        this.isOpen = false;
        this.connecting = false;
        this.buffer = [];
    }

    public write(chunk: Buffer): void {
        if (!this.isActive) return;
        if (this.isOpen && this.ws) {
            try { this.ws.send(chunk); } catch { /* ignore */ }
            return;
        }
        this.buffer.push(chunk);
        if (this.buffer.length > 500) this.buffer.shift();
    }

    private async connect(): Promise<void> {
        if (this.connecting || !this.isActive) return;
        this.connecting = true;
        try {
            const cloud = CloudClient.getInstance();
            const token = await cloud.getAccessToken();
            const qs = new URLSearchParams({
                token,
                sample_rate: String(this.sampleRate),
                channels: String(this.numChannels),
                encoding: 'linear16',
                model: STT_MODEL,
                interim_results: 'true',
            });
            if (this.languageCode && this.languageCode !== 'en') qs.set('language', this.languageCode);

            const ws = new WebSocket(`${cloud.wsBaseUrl}/llm/stt?${qs.toString()}`);
            this.ws = ws;

            ws.on('open', () => {
                this.isOpen = true;
                this.connecting = false;
                this.reconnectAttempts = 0;
                for (const c of this.buffer) { try { ws.send(c); } catch { /* ignore */ } }
                this.buffer = [];
            });

            ws.on('message', (data: WebSocket.RawData) => {
                try {
                    const obj = JSON.parse(data.toString());
                    if (obj && obj.text) {
                        this.emit('transcript', {
                            text: obj.text,
                            isFinal: !!obj.isFinal,
                            confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
                        });
                    }
                } catch { /* ignore non-JSON frames */ }
            });

            ws.on('error', (err: Error) => { this.emit('error', err); });

            ws.on('close', (code: number) => {
                this.isOpen = false;
                this.connecting = false;
                this.ws = null;
                if (code === 4401) {
                    this.fatal = true;
                    this.emit('error', new Error('STT auth failed — please sign in again'));
                    return;
                }
                if (code === 4029) {
                    this.fatal = true;
                    this.emit('error', new Error('STT quota exhausted — please upgrade your plan'));
                    return;
                }
                if (this.isActive && !this.fatal) this.scheduleReconnect();
            });
        } catch (err) {
            this.connecting = false;
            this.emit('error', err instanceof Error ? err : new Error(String(err)));
            if (this.isActive && !this.fatal) this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            this.emit('error', new Error('STT reconnect attempts exhausted'));
            return;
        }
        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
            RECONNECT_MAX_DELAY_MS,
        );
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isActive) void this.connect();
        }, delay);
    }
}
