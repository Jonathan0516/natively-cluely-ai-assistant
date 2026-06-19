# LLM 网关 阶段4a+4b：客户端聊天接入网关(基础 + 一条链路) — 设计文档

- 日期:2026-06-19
- 状态:已评审,待落实现计划
- 作者:Jonathan(与 Claude 协作)
- 前置:阶段1-3 已合入 main(`/llm/chat` SSE、`/llm/json`、`/llm/embeddings`、`WS /llm/stt` 均已联机验证)

## 1. 背景与目标

阶段1-3 把 STT、embeddings 上云,但**聊天仍在客户端 `LLMHelper`(3536 行)本地直连各家 SDK**(GoogleGenAI/OpenAI/Groq/Anthropic/Ollama),带跨 provider 回退。聊天是 LLM 成本主体,是「付费控制」的核心。

阶段4 完整改造很大且仓库无 JS 测试,故**先做 4a+4b 垂直切片**:
- **4a**:给 `CloudClient` 加聊天网关接口(`streamLLM` SSE、`llmJson`)。
- **4b**:加一个走网关的 leaf,并让 `streamChat` 在**特性开关**打开时改走网关,先打通 Answer 等基于 `streamChat` 的模式。开关默认关 → 零行为变化。

验证 Answer 一条链路能流式出字 + 后端计量后,再做 4c(全量改写)/4d(设置 UI)/4e(tier 门禁)。

## 2. 关键决策

| 决策项 | 结论 |
|---|---|
| 范围 | 只做 4a(CloudClient 接口)+ 4b(`streamChat` 经开关走网关) |
| 灰度 | **特性开关**(env `NATIVELY_GATEWAY_CHAT=1`),默认关;开则 `streamChat` 全部走网关 |
| 逻辑模型映射 | `gemini-3.1-flash-lite→answer-fast`、`gemini-3.1-pro-preview→answer-pro`,其余默认 `answer-fast` |
| 接口形态 | `streamLLM` 为 `AsyncGenerator<string>`(逐 delta);`llmJson` 返回 `{text}` |
| 不动 | `prompts.ts`、各模式模块对外接口、旧 provider 回退路径(开关关时原样保留) |
| 错误语义 | 401→需登录、402→配额、其它→普通错误,抛出供上层提示 |

## 3. 4a:CloudClient 聊天接口

`electron/services/CloudClient.ts` 新增:

### 3.1 `streamLLM`

```ts
async *streamLLM(body: {
  model: string;
  messages: { role: string; content: string }[];
  images?: string[];
  max_tokens?: number;
  temperature?: number;
}): AsyncGenerator<string, void, unknown>
```

- `fetch` 到 `${backendUrl()}/llm/chat`,带 `Authorization: Bearer <token>`(复用 `accessToken()`)。
- 读 `resp.body`(ReadableStream),按行解析 SSE:`data: {json}`;`{"delta": "..."}` → `yield delta`;`[DONE]` → 结束;`{"error": {...}}` → 抛错。
- HTTP 401 → 抛 `CloudError(401)`(触发现有 `auth-session-expired`);402 → 抛 `CloudError(402, "quota")`。
- Node 主进程用全局 `fetch`(Electron/undici 已提供);用 `TextDecoder` 增量解码 + 跨 chunk 行缓冲。

### 3.2 `llmJson`

```ts
async llmJson(body: { model: string; messages: {role:string;content:string}[]; images?: string[] }):
  Promise<{ text: string }>
```

走现有 `request()`(POST `/llm/json`,JWT/401 重试复用)。

## 4. 4b:LLMHelper 经开关走网关

### 4.1 网关 leaf

`electron/LLMHelper.ts` 新增:

```ts
private gatewayChatEnabled(): boolean {
  return process.env.NATIVELY_GATEWAY_CHAT === '1';
}

private toLogicalModel(modelId: string): string {
  if (modelId === 'gemini-3.1-pro-preview') return 'answer-pro';
  return 'answer-fast';
}

private async *streamWithGateway(
  userContent: string, systemPrompt: string, images?: string[]
): AsyncGenerator<string, void, unknown> {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  yield* CloudClient.getInstance().streamLLM({
    model: this.toLogicalModel(this.currentModelId),
    messages,
    images,
  });
}
```

### 4.2 `streamChat` 顶部分流

在 `streamChat`(LLMHelper:2226)组装好 system/user 文本后、构建 provider 数组之前插入:

```ts
if (this.gatewayChatEnabled()) {
  yield* this.streamWithGateway(userContent, finalSystemPrompt, imagePaths);
  return;
}
```

(`userContent`/`finalSystemPrompt`/`imagePaths` 沿用该方法内已有变量;开关关时后续原逻辑不变。)

### 4.3 不改

`AnswerLLM` 等模式模块、`streamChatWithGemini`(本切片不动,留待 4c)、`prompts.ts`、`MODE_CONFIGS`。

## 5. 鉴权与错误

- 开关开时需登录;未登录 `streamLLM` 抛 401 → 现有 `auth-session-expired` 广播跳登录。
- 402 配额 → 上层提示升级(沿用现有错误展示)。

## 6. 测试

- 4a:无 JS 测试框架;用一次性 Node 脚本(`tsx`/编译后)或等价 `fetch`+SSE 解析脚本打到**真实后端**(真 Gemini),断言收到流式 delta 且 `usage_events` 出现一条 `kind='chat'`。
- 4b:`npx tsc -b electron/tsconfig.json --force` 0 错;运行时由用户在 app 内 `NATIVELY_GATEWAY_CHAT=1` 开启后验证 Answer 模式流式出字。

## 7. 非目标(后续阶段)

- 4c:`streamChatWithGemini` 与其余 leaf 全量改写、删 SDK/Ollama/客户端回退。
- 4d:设置 UI(套餐/配额/模型目录展示、下线填 key)、AI 强制登录默认化。
- 4e:后端按 plan tier 在调用时门禁(免费用户拒 pro 模型)。
- 多模态图片经网关的完整打磨(本切片传 images,但以文本链路为主验)。
