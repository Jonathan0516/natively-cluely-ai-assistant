# LLM 网关 阶段3：STT 上云(Deepgram-only + 后端 WS 反代) — 设计文档

- 日期:2026-06-18
- 状态:已评审,待落实现计划
- 作者:Jonathan(与 Claude 协作)
- 前置:阶段1(聊天网关)、阶段2(embeddings + 目录转 Gemini)已合入 main

## 1. 背景与目标

当前 STT 在客户端本地直连各家:`electron/main.ts` 按 `CredentialsManager.getSttProvider()` 在 6 个实现里选一个(Deepgram/Soniox/ElevenLabs/OpenAI/Google/Rest),各自用用户 key 直连上游。没有计量、配额、平台密钥控制。

**目标**:把实时 STT 砍到 **只剩 Deepgram**,并改为经后端 **`WS /llm/stt` 反代**——后端持平台 Deepgram key、按音频秒计量配额、配额耗尽硬切连接。客户端不再持 STT key,登录即用。

**关键决策(已确认)**:
| 决策项 | 结论 |
|---|---|
| STT provider | 只剩 **Deepgram**;删除其余 5 个实现 |
| 架构 | 后端 **WS 反代**(非客户端直连/临时 key) |
| WS 鉴权 | 连接时 `?token=<jwt>` 查询参数 |
| 上游连接 | 后端用原生 **`websockets`** 库连 `wss://api.deepgram.com/v1/listen`,`Authorization: Token <平台key>` |
| 计量 | `kind="stt"`,按**音频秒**换算 credits;连接关闭时记账 + 流中周期性配额复查 |
| 平台 key | `DEEPGRAM_API_KEY`(阶段1已在 config 留字段) |
| 交付顺序 | 后端先行(可注入假上游、可单测),再改客户端 |

## 2. 总体架构

```
MicrophoneCapture / SystemAudioCapture
   │ linear16 PCM 帧 (Buffer)
DeepgramStreamingSTT (改写:plain WS 客户端,保持 write()/'transcript' 接口不变)
   │ 二进制音频  ──ws──▶  WS /llm/stt  ──ws(Token 头)──▶  wss://api.deepgram.com/v1/listen
   │ 转写 JSON  ◀──ws──   反代 + 数音频秒 + 配额  ◀──        Deepgram 转写
```

## 3. 后端改动(阶段 3a)

### 3.1 模型目录加 STT spec

`model_catalog.py` 新增 `stt-default`(tier=free):`provider="deepgram"`、`upstream_model="nova-2"`(默认 Deepgram 模型)、`capabilities=("stt",)`、新增字段 `credits_per_audio_second: float = 0.0`(stt-default 设如 `0.1`)。`base_url`/`key_env="deepgram_api_key"`。

`usage_meter.record` 增加 STT 分支:当 `kind=="stt"`,`credits = max(1, ceil(audio_seconds * spec.credits_per_audio_second))`(覆盖原 token 逻辑)。

### 3.2 STT 反代 service `services/stt_relay.py`

- **可注入的上游连接器** `DeepgramUpstream`(Protocol):`connect(params: dict) -> AsyncUpstream`;`AsyncUpstream` 提供 `send(data: bytes)`、`__aiter__()`(yield 上游转写 str)、`close()`。
- 生产实现 `WebsocketsDeepgramUpstream`:用 `websockets.connect(url, additional_headers={"Authorization": f"Token {key}"})` 连 `wss://api.deepgram.com/v1/listen?<params>`。
- `params` 由客户端连接 query 透传:`encoding`、`sample_rate`、`channels`、`model`、`language`、`interim_results`。

### 3.3 `WS /llm/stt` 端点(`routers/stt.py`)

流程:
1. `websocket.accept()` 前/后取 `?token=` → 复用 jwt 校验 + `user_repo.get_by_id`;失败 `close(code=4401)`。
2. `meter.check(user.id)`;配额耗尽 `close(code=4029)`。
3. 经注入的 `DeepgramUpstream.connect(params)` 连上游。
4. **双向中继**(两个并发任务):
   - 上行:`async for msg in websocket.iter_bytes()` → `upstream.send(msg)`,累计 `total_bytes`。
   - 下行:`async for transcript in upstream` → `websocket.send_text(transcript)`。
5. **音频秒**:`audio_seconds = total_bytes / (sample_rate * channels * 2)`(linear16=2 字节/采样)。
6. **周期配额复查**:每累计约 30 秒音频做一次 `meter.status`,耗尽即 `close(4029)`。
7. 任一方断开/出错:取消另一任务,`meter.record(kind="stt", spec=stt_spec, usage=Usage(), audio_seconds=…)`,关闭上游。

关闭码语义:`4401` 鉴权失败、`4029` 配额耗尽、`1011` 上游故障、`1000` 正常。

### 3.4 deps 装配

`get_stt_upstream()` 返回生产 `WebsocketsDeepgramUpstream`(读 `settings.deepgram_api_key`);测试用 `app.dependency_overrides` 注入假上游。

### 3.5 依赖

`backend/pyproject.toml` 加 `websockets>=13`(FastAPI/starlette 已间接依赖,显式声明用于上游客户端)。

## 4. 客户端改动(阶段 3b)

### 4.1 改写 `DeepgramStreamingSTT`

- 去掉 `@deepgram/sdk`,改用 plain `WebSocket` 连 `wss://<backend>/llm/stt?token=<jwt>&sample_rate=…&channels=…&encoding=linear16&model=…&interim_results=true`。
- **保持公开接口不变**:`write(chunk: Buffer)` → `ws.send(chunk)`;收到下行转写 JSON → `emit('transcript', { text, isFinal, confidence })`;`emit('error')`。`main.ts` 调用方不变。
- backend WS 地址 + JWT 从现有 `CloudClient`/`AuthStorage` 取(复用 token)。

### 4.2 简化 `main.ts` STT 选择

STT 收敛为 deepgram-only(永远走后端):移除 soniox/elevenlabs/openai/google/rest 分支、`STTProvider` 联合类型与 import、以及"无 key → GoogleSTT 兜底"逻辑。`sttProvider==='none'` 时不启用 STT。

### 4.3 删除文件 + 凭据清理

删除 `electron/audio/{OpenAIStreamingSTT,RestSTT,GoogleSTT,SonioxStreamingSTT,ElevenLabsStreamingSTT}.ts`;`CredentialsManager` 下线各 STT provider key 存取(Deepgram key 也不再需要,客户端不持 key)。

### 4.4 不触碰

`MicrophoneCapture`、`SystemAudioCapture`、`AudioDevices`、转写消费侧(meeting/transcript 管线)不变——只换"音频送哪、转写从哪来"。

## 5. 鉴权与错误

- 强制登录:无 JWT 无法连 STT WS。
- WS 关闭码区分鉴权(4401)、配额(4029)、上游故障(1011)。客户端 `DeepgramStreamingSTT` 把关闭码映射为 `'error'` 事件 / 重连或停采策略(配额耗尽提示升级,沿用 402 同款 UI 文案)。

## 6. 测试

- 后端:`TestClient.websocket_connect("/llm/stt?token=…")` + **假上游**(回放固定转写),验证:无 token/坏 token → 关闭 4401;配额耗尽 → 4029;正常中继音频→转写;音频秒计量(发已知字节数,断言 `usage_events.audio_seconds`/credits)。
- 客户端:`tsc --noEmit -p electron/tsconfig.json` 类型检查 + 手动冒烟(有 DEEPGRAM_API_KEY 时联机)。

## 7. 非目标

- 客户端聊天叶子改写、设置 UI(配额/模型目录展示)—— 阶段4。
- 非 Deepgram STT、离线 STT、说话人分离调优。
- 转写后处理/标点/语言自动检测的改动(沿用 Deepgram 既有参数)。
