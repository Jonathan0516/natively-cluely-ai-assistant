# LLM 网关 阶段3b：客户端 STT 切到后端 WS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`). 无 JS 测试框架——每个任务以 `npx tsc --noEmit -p electron/tsconfig.json` 类型检查为门禁,最终由用户运行 Electron app + 麦克风手动验收。

**Goal:** 把客户端 `DeepgramStreamingSTT` 从直连 Deepgram SDK 改为连后端 `WS /llm/stt`(平台 key、计量),并把 STT 收敛为 deepgram-only、删除其余 provider。

**Architecture:** 复用 `ws` 包(仓库已有,`import WebSocket from 'ws'`,Soniox/OpenAI STT 同款)。`DeepgramStreamingSTT` 保持公开接口(`start/stop/write/setSampleRate/setAudioChannelCount/setRecognitionLanguage/setCredentials` + `'transcript'`/`'error'` 事件)不变,内部换成连 `${CloudClient.wsBaseUrl}/llm/stt?token=…`。`main.ts` 选择逻辑收敛为永远 `new DeepgramStreamingSTT()`。

**Tech Stack:** TypeScript / Electron 主进程,`ws` WebSocket,`CloudClient` 取 token + ws base url。验证:`tsc --noEmit` + 手动冒烟。

## Global Constraints

- 不改音频采集(`MicrophoneCapture`/`SystemAudioCapture`)与转写消费侧(`main.ts` 的 `transcript`/`error` 事件 wiring,919+ 行)。
- `DeepgramStreamingSTT` 公开接口与事件 payload(`{text,isFinal,confidence}`)保持不变。
- WS 鉴权用 `?token=<jwt>`;model 用 `nova-3`(保持现状);language 用 `RECOGNITION_LANGUAGES[key].iso639`,`auto`→`multi`。
- 关闭码 `4401`(鉴权)/`4029`(配额)→ 不重连、报错;其他异常断开 → 退避重连。
- 客户端不再持任何 STT key。

---

## Task 1: CloudClient 暴露 token + ws base url

**Files:** Modify: `electron/services/CloudClient.ts`

**Interfaces:** Produces: `CloudClient.getAccessToken(): Promise<string>`;`CloudClient.wsBaseUrl: string`(getter)。

- [ ] **Step 1: 加公开方法**

在 `private async accessToken()` 之后加:

```ts
  /** Public valid-access-token getter (refreshes proactively) for WS auth. */
  async getAccessToken(): Promise<string> {
    return this.accessToken()
  }

  /** ws(s):// base URL for streaming endpoints (mirrors the http backend base). */
  get wsBaseUrl(): string {
    return backendUrl().replace(/^http/, "ws")
  }
```

- [ ] **Step 2: 类型检查 + 提交**

Run: `npx tsc --noEmit -p electron/tsconfig.json`
Expected: 无新增错误。

```bash
git add electron/services/CloudClient.ts
git commit -m "feat(client): expose CloudClient.getAccessToken and wsBaseUrl for STT WS"
```

---

## Task 2: 改写 DeepgramStreamingSTT → 后端 WS

**Files:** Modify (全量替换): `electron/audio/DeepgramStreamingSTT.ts`

**Interfaces:** Consumes: `CloudClient.getAccessToken/wsBaseUrl`(Task 1)、`RECOGNITION_LANGUAGES`。Produces: 同名 class,接口不变。

- [ ] **Step 1: 全量替换文件内容**

```ts
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
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p electron/tsconfig.json`
Expected: 无与 DeepgramStreamingSTT 相关的新错误。（`RECOGNITION_LANGUAGES[key].iso639` 字段名沿用原文件,已验证存在。）

- [ ] **Step 3: 提交**

```bash
git add electron/audio/DeepgramStreamingSTT.ts
git commit -m "feat(client): rewrite DeepgramStreamingSTT to use backend WS /llm/stt"
```

---

## Task 3: main.ts STT 收敛为 deepgram-only(后端)

**Files:** Modify: `electron/main.ts`

**Interfaces:** Consumes: 改写后的 `DeepgramStreamingSTT()`(无参构造)。

- [ ] **Step 1: 替换 provider 选择块**

把 `let stt: STTProvider;` 起、到 `else { stt = new GoogleSTT(speaker); }` 结束的整段 provider 选择(`if (sttProvider === 'deepgram') … } else { stt = new GoogleSTT(speaker); }`)替换为:

```ts
    // STT now always goes through the backend Deepgram WS reverse-proxy (platform key, metered).
    // Provider selection / per-provider keys are obsolete; login is required.
    const stt: DeepgramStreamingSTT = new DeepgramStreamingSTT();
```

(保留上方 `sttProvider === 'none'` 提前返回;保留下方 `stt.setRecognitionLanguage(sttLanguage)` 与 `transcript`/`error` 事件 wiring 不变。)

- [ ] **Step 2: 收紧 STTProvider 类型 + 删除无用 import**

把 `electron/main.ts:173` 的 `type STTProvider = (GoogleSTT | RestSTT | DeepgramStreamingSTT | SonioxStreamingSTT | ElevenLabsStreamingSTT | OpenAIStreamingSTT) & {…}` 简化为只含 Deepgram(保留其后的 `& { … }` 交集方法签名原样):

```ts
type STTProvider = DeepgramStreamingSTT & {
```

删除 `electron/main.ts` 顶部对 `GoogleSTT`/`RestSTT`/`SonioxStreamingSTT`/`ElevenLabsStreamingSTT`/`OpenAIStreamingSTT` 的 import 行(保留 `DeepgramStreamingSTT`)。

- [ ] **Step 3: 类型检查(会暴露残留引用)**

Run: `npx tsc --noEmit -p electron/tsconfig.json`
Expected: 若仍有对已删 import 的引用,tsc 报错 → 按报错逐个移除/改为 Deepgram。直到 0 新错误。

- [ ] **Step 4: 提交**

```bash
git add electron/main.ts
git commit -m "feat(client): route all STT through backend Deepgram WS; drop local provider selection"
```

---

## Task 4: 删除其余 STT provider 文件

**Files:** Delete: `electron/audio/{GoogleSTT,RestSTT,OpenAIStreamingSTT,SonioxStreamingSTT,ElevenLabsStreamingSTT}.ts`

- [ ] **Step 1: 确认无其他引用**

Run: `grep -rnE "GoogleSTT|RestSTT|OpenAIStreamingSTT|SonioxStreamingSTT|ElevenLabsStreamingSTT" electron/ --include=*.ts | grep -v "audio/\(GoogleSTT\|RestSTT\|OpenAIStreamingSTT\|SonioxStreamingSTT\|ElevenLabsStreamingSTT\).ts"`
Expected: 无输出(除将被删文件自身)。若有(如 `ipcHandlers.ts` 的连接测试),改为不引用这些 class(连接测试可保留其内联 `ws` 逻辑,不依赖 provider class)。

- [ ] **Step 2: 删除文件**

```bash
git rm electron/audio/GoogleSTT.ts electron/audio/RestSTT.ts electron/audio/OpenAIStreamingSTT.ts electron/audio/SonioxStreamingSTT.ts electron/audio/ElevenLabsStreamingSTT.ts
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p electron/tsconfig.json`
Expected: 0 新错误。

- [ ] **Step 4: 提交**

```bash
git add -A electron/audio
git commit -m "chore(client): delete obsolete local STT providers (backend-only now)"
```

---

## Task 5: 最终类型检查 + 手动冒烟说明

**Files:** 无（验证）

- [ ] **Step 1: 全量 tsc**

Run: `npx tsc --noEmit -p electron/tsconfig.json`
Expected: 0 新错误(与本阶段开始前的基线一致)。

- [ ] **Step 2: 手动冒烟（需用户运行 app）**

前提:`backend/.env` 有 `DEEPGRAM_API_KEY`;后端跑在 `http://localhost:8765`(或设 `NATIVELY_BACKEND_URL`);客户端已登录。

1. 启动后端 + Electron app,开始一场会议(触发音频采集)。
2. 说话,确认转写出现在 overlay/launcher(走 `native-audio-transcript`)。
3. Supabase 查 `select kind, audio_seconds, credits from usage_events where kind='stt' order by created_at desc limit 5;` 应随说话增长。
4. 断网/登出场景:WS 关闭码 4401 → 提示重新登录;4029 → 提示升级。

> 说明:本阶段无自动化测试(仓库无 JS 测试框架),正确性靠接口不变 + tsc;运行时行为需上述手动验收。

---

## Self-Review

- **Spec 覆盖**:§4.1 改写 DeepgramStreamingSTT → Task 2;§4.2 main.ts 收敛 → Task 3;§4.3 删除 provider 文件 → Task 4(CredentialsManager 各 STT key getter 暂留为死代码,低风险,后续清理);§4.4 不碰采集/消费 → 全程保持。§5 关闭码 4401/4029 映射 → Task 2 `close` 处理。
- **接口一致性**:`DeepgramStreamingSTT` 公开方法/事件 payload 与原版一致;`CloudClient.getAccessToken/wsBaseUrl`(Task 1)被 Task 2 使用;`RECOGNITION_LANGUAGES[key].iso639`、model `nova-3` 与原版一致。
- **已知限制**:无 JS 单测,仅 tsc + 手动;空闲时 Deepgram 上游 keepalive 未实现(连续音频场景不受影响),留作后续;CredentialsManager STT key getter 暂留死代码。
