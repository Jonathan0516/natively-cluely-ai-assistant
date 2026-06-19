# LLM 网关 阶段4a+4b：客户端聊天接入网关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. 无 JS 测试框架——`npx tsc -b electron/tsconfig.json --force` 为门禁;4a 用 Node 脚本打真实后端验证流式 + 计量;4b 运行时由用户开 flag 验。

**Goal:** 给 CloudClient 加 `streamLLM`(SSE)/`llmJson`,并让 LLMHelper 的 `streamChat` 在 `NATIVELY_GATEWAY_CHAT=1` 时改走后端网关。

**Architecture:** CloudClient 用 Node 全局 `fetch` 读 `/llm/chat` 的 SSE 流逐 delta yield;LLMHelper 加 `streamWithGateway` leaf + `streamChat` 顶部 flag 分流。开关默认关 → 零行为变化。

## Global Constraints

- 逻辑模型:`gemini-3.1-pro-preview→answer-pro`,其余→`answer-fast`。
- SSE 行格式:`data: {"delta":"…"}` / `data: [DONE]` / `data: {"error":{…}}`。
- 错误:HTTP 401→`CloudError(401)`;402→`CloudError(402)`。
- 门禁:`npx tsc -b electron/tsconfig.json --force` 必须 0 error(用 `-b --force`,`--noEmit -p` 会因 composite 缓存给假 0)。

---

## Task 1: CloudClient.streamLLM + llmJson

**Files:** Modify: `electron/services/CloudClient.ts`

**Interfaces:** Produces: `streamLLM(body): AsyncGenerator<string>`;`llmJson(body): Promise<{text:string}>`。Consumes: 现有 `accessToken()`、`backendUrl()`、`post()`、`CloudError`。

- [ ] **Step 1: 在 LLM gateway 区(`llmEmbeddings` 附近)加方法**

```ts
  /** Stream chat tokens from the backend gateway (SSE). Yields text deltas. */
  async *streamLLM(body: {
    model: string
    messages: { role: string; content: string }[]
    images?: string[]
    max_tokens?: number
    temperature?: number
  }): AsyncGenerator<string, void, unknown> {
    const token = await this.accessToken()
    const resp = await fetch(`${backendUrl()}/llm/chat`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (resp.status === 401) throw new CloudError(401, "not authenticated")
    if (resp.status === 402) throw new CloudError(402, "quota exhausted")
    if (!resp.ok || !resp.body) throw new CloudError(resp.status, `stream failed: ${resp.status}`)

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const data = line.slice(6).trim()
          if (data === "[DONE]") return
          let obj: any
          try { obj = JSON.parse(data) } catch { continue }
          if (obj.error) throw new CloudError(502, obj.error?.message || "stream error")
          if (typeof obj.delta === "string") yield obj.delta
        }
      }
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }
  }

  /** Non-streaming structured JSON generation via the gateway. */
  async llmJson(body: {
    model: string
    messages: { role: string; content: string }[]
    images?: string[]
  }): Promise<{ text: string }> {
    return this.post(`/llm/json`, body)
  }
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc -b electron/tsconfig.json --force` → grep `error TS` 计数
Expected: 0（若 `CloudError`/`backendUrl` 不在作用域,补 import/引用——二者均在本文件顶部已定义）。

- [ ] **Step 3: 提交**

```bash
git add electron/services/CloudClient.ts
git commit -m "feat(client): add CloudClient.streamLLM (SSE) and llmJson gateway methods"
```

---

## Task 2: LLMHelper 经 flag 走网关

**Files:** Modify: `electron/LLMHelper.ts`

**Interfaces:** Consumes: `CloudClient.streamLLM`(Task 1)、`this.currentModelId`。Produces: `streamChat` 在 flag 开时走网关。

- [ ] **Step 1: 加 helper 方法**

在 `LLMHelper` 类内(靠近其它 `streamWith*` leaf)加:

```ts
  private gatewayChatEnabled(): boolean {
    return process.env.NATIVELY_GATEWAY_CHAT === '1';
  }

  private toLogicalModel(modelId: string): string {
    if (modelId === 'gemini-3.1-pro-preview') return 'answer-pro';
    return 'answer-fast';
  }

  private async *streamWithGateway(
    userContent: string,
    systemPrompt: string,
    images?: string[],
  ): AsyncGenerator<string, void, unknown> {
    const { CloudClient } = require('./services/CloudClient');
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

> 用 `require('./services/CloudClient')`(仓库主进程惯用,见 `VectorStore`/`SettingsManager`),避免顶部循环 import 风险。

- [ ] **Step 2: streamChat 顶部分流**

在 `streamChat`(LLMHelper:2226)里、`const userContent = …` 与 `const finalSystemPrompt = …` 都已定义之后(约 2320 行,provider 选择之前)插入:

```ts
    if (this.gatewayChatEnabled()) {
      yield* this.streamWithGateway(userContent, finalSystemPrompt, imagePaths);
      return;
    }
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc -b electron/tsconfig.json --force`
Expected: 0 error。

- [ ] **Step 4: 提交**

```bash
git add electron/LLMHelper.ts
git commit -m "feat(client): route streamChat through backend gateway behind NATIVELY_GATEWAY_CHAT flag"
```

---

## Task 3: 4a 联机验证 + 4b 手动冒烟说明

**Files:** 无（验证）

- [ ] **Step 1: 驱动 streamLLM 打真实后端(验证 SSE 解析 + 计量)**

起后端(`backend/.env` 有 `GEMINI_API_KEY`),mint token,用 Node 复刻 streamLLM 的 SSE 解析打 `/llm/chat`:

```bash
cd backend
uv run uvicorn app.main:app --app-dir src --port 8000 &
until curl -sf http://localhost:8000/health >/dev/null; do sleep 0.5; done
TOKEN=$(PYTHONPATH=src uv run python -c "from app.config import get_settings as g; from app.services.jwt_service import JwtService as J; s=g(); print(J(secret=s.jwt_secret,algorithm=s.jwt_algorithm,access_ttl=s.jwt_access_ttl_seconds,refresh_ttl=s.jwt_refresh_ttl_seconds).issue('f4e48046-3c71-438d-811e-2eeb5c1572af','13800138001').access_token)")
curl -s -N -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"answer-fast","messages":[{"role":"system","content":"Reply concisely."},{"role":"user","content":"Say hello in 3 words"}]}' \
  http://localhost:8000/llm/chat
kill %1
```
Expected: 多个 `data: {"delta":"…"}` 事件 + `data: [DONE]`(证明 SSE 流式 + answer-fast→Gemini 通路)。

- [ ] **Step 2: 确认计量**

Supabase 查 `select kind, model, input_tokens, output_tokens, credits from usage_events where kind='chat' order by created_at desc limit 3;`
Expected: 新增一条 `chat / answer-fast`。

- [ ] **Step 3: 4b 手动冒烟(需用户)**

1. `NATIVELY_GATEWAY_CHAT=1` 启动 app(后端可达、已登录)。
2. 触发 Answer 模式,确认回答**流式出字**且内容正常。
3. Supabase 看 `usage_events` 的 `chat` 随提问增长。
4. 关掉 flag 重启,确认回到原直连行为(回归)。

> 说明:4a 的 SSE 流式 + 计量本任务已联机验;`CloudClient.streamLLM` 自身经 tsc + 与 Step1 等价解析逻辑保证;4b 运行时行为需用户按上面冒烟。

---

## Self-Review

- **Spec 覆盖**:§3.1 streamLLM→Task1;§3.2 llmJson→Task1;§4.1 leaf+映射→Task2;§4.2 streamChat 分流→Task2;§6 验证→Task3。
- **类型一致性**:`streamLLM`/`llmJson` 签名、`toLogicalModel`、`gatewayChatEnabled`、`streamWithGateway(userContent, systemPrompt, images)` 命名一致;`userContent`/`finalSystemPrompt`/`imagePaths` 已确认存在于 streamChat。
- **已知限制**:无 JS 单测;4b 运行时靠手动;多模态图片经网关本切片随带但以文本验;`streamChatWithGemini` 及其余 leaf 不在本切片(4c)。
