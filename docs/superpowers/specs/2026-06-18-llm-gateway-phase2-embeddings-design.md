# LLM 网关 阶段2：Embeddings 上云 + 目录转 Gemini — 设计文档

- 日期:2026-06-18
- 状态:已评审,待落实现计划
- 作者:Jonathan(与 Claude 协作)
- 前置:阶段1后端网关已落地并合入 main（`/llm/json`、`/llm/chat`、`/llm/models`、`/llm/quota`、usage_meter、model_catalog、OpenAICompatProvider、LLMGateway）

## 1. 背景与目标

阶段1把聊天/JSON 调用收敛到后端 `/llm/*` 计费网关,但:

1. **embedding 仍在客户端本地算**:`electron/rag/` 下 OpenAI/Gemini/Ollama/Local 四个 provider 各自直连或本地跑模型,后端 `/embeddings/*` 只负责存储+检索(pgvector 暴力余弦),不计算、不计量。
2. **阶段1模型目录指向 Groq/OpenAI/Netmind**,与平台实际持有的密钥不符。

**平台决策(已确认)**:统一用 **Gemini**(`GEMINI_API_KEY`)作为服务方,聊天和 embedding 都走 Gemini。Groq/OpenAI/Netmind 暂不使用。

**本阶段目标**:
- 把 embedding 计算搬到后端新端点 `POST /llm/embeddings`(平台 Gemini key、计量配额),客户端 RAG 改为调它。
- 把阶段1聊天目录retarget 到 Gemini,使整套网关用同一个 Gemini key 真实跑通。

**关键手段**:Gemini 提供 **OpenAI 兼容端点** `https://generativelanguage.googleapis.com/v1beta/openai/`,聊天(`/chat/completions`)和 embedding(`/embeddings`)都兼容。因此**复用阶段1的 `OpenAICompatProvider`**,只换 `base_url` + `GEMINI_API_KEY`,无需新写 Gemini provider。

## 2. 已确认的关键决策

| 决策项 | 结论 |
|---|---|
| 平台 provider | 全部 Gemini(OpenAI 兼容端点) |
| 聊天模型 | `answer-fast`(free)→ `gemini-3.1-flash-lite`;`answer-pro`(pro)→ `gemini-3.1-pro-preview`(与客户端现用模型一致);下线 `answer-netmind` |
| embedding 模型 | `gemini-embedding-001` @ **768 维**(请求带 `dimensions=768`;`text-embedding-004` 在该 Gemini 账号/兼容端点不可用,联机已验证) |
| embedding 计量 | `kind="embeddings"`,按 input token 换算 credits(低单价) |
| 存储/检索 | **不动** 现有 `/embeddings/*`(chunks/summary/search),后端检索已按 `dim` 过滤 |
| 历史数据 | 现有 3 条测试 chunk 为 384 维(本地 MiniLM),切换后成孤儿(检索按 dim 过滤,不报错、不返回);可选一次性清理,非必须 |
| 本地兜底 | 保留 `LocalEmbeddingProvider`(384 维)仅作离线最后兜底;彻底移除留到阶段4 |
| 交付顺序 | **后端先行**(TDD、独立验收),再改客户端 |

## 3. 后端改动(阶段 2a)

### 3.1 `model_catalog.py` retarget 到 Gemini

```python
GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
```

- `answer-fast`(tier=free)→ `upstream_model="gemini-3.1-flash-lite"`, `base_url=GEMINI_OPENAI_BASE`, `key_env="gemini_api_key"`, fallbacks=`("answer-pro",)`
- `answer-pro`(tier=pro)→ `upstream_model="gemini-3.1-pro-preview"`, 同 base/key,capabilities 含 vision
- 删除 `answer-netmind`
- 新增 embedding spec:`embed-default`(tier=free)→ `upstream_model="gemini-embedding-001"`, `base_url=GEMINI_OPENAI_BASE`, `key_env="gemini_api_key"`, `capabilities=("embedding",)`, `embed_dim=768`(provider 请求带 `dimensions=768`),低 credits 单价。注:OpenAI 兼容 `/embeddings` 不返回 token usage,embedding 计量按 1 credit 下限。

> 注:embedding spec 需要一个维度字段(`embed_dim: int = 768`)或沿用约定;`credits_for` 对 embedding 只按 input token 计。

### 3.2 `OpenAICompatProvider.embed()`

新增方法:

```python
async def embed(self, model: str, texts: list[str]) -> EmbedResult:
    # POST {base}/embeddings  body: {"model": model, "input": texts}
    # resp: {"data": [{"embedding": [...]}, ...], "usage": {"prompt_tokens": N}}
```

返回 `EmbedResult(vectors: list[list[float]], dim: int, usage: Usage, model: str)`(新增到 `llm_types.py`)。Provider Protocol(`base.py`)加 `embed` 方法签名。

### 3.3 `LLMGateway.embed()`

```python
async def embed(self, model_id, texts) -> tuple[ModelSpec, EmbedResult]:
    spec, prov = self.resolve(model_id)
    res = await prov.embed(spec.upstream_model, texts)
    return spec, res
```

(embedding 暂不做回退链——单一模型;失败直接抛 `NoModelAvailable`。)

### 3.4 `POST /llm/embeddings` 端点(`routers/llm.py`)

请求:`{ texts: string[], model?: string="embed-default" }`
响应:`{ embeddings: number[][], dim: int, model: string }`

流程:`get_current_user` → `meter.check`(402)→ `gateway.embed`(未知模型 400)→ `meter.record(kind="embeddings", spec, usage)` → 返回。

### 3.5 计量

`usage_meter.record` 已支持任意 `kind`;embedding 走 input_tokens 单价。`model_catalog` 给 embed spec 设低 `credits_per_1k_input`(如 0.1)、`credits_per_1k_output=0`。

## 4. 客户端改动(阶段 2b)

### 4.1 `CloudClient.llmEmbeddings()`

```ts
async llmEmbeddings(texts: string[], model?: string):
  Promise<{ embeddings: number[][]; dim: number; model: string }>
// POST /llm/embeddings,复用现有 request() 的 JWT 注入/刷新/401 重试
```

### 4.2 `CloudEmbeddingProvider`(新增,实现 `IEmbeddingProvider`)

- `name="cloud"`, `dimensions=768`
- `embed(texts)` → `CloudClient.llmEmbeddings(texts)`,返回向量
- `isAvailable()` → 已登录(有 token)即 true

`EmbeddingProviderResolver`:已登录时**首选 `CloudEmbeddingProvider`**;移除 OpenAI/Gemini/Ollama 本地 provider;`LocalEmbeddingProvider` 仅作离线最后兜底保留。

### 4.3 不触碰

`/embeddings/*` 存储与检索、`SemanticChunker`、`VectorStore`、`RAGRetriever`、`LiveRAGIndexer` 的上层逻辑不变——只换"向量从哪来"。

## 5. 鉴权与错误

沿用阶段1:401 未登录、402 配额耗尽、400 未知模型、503/上游错误→ `NoModelAvailable`。客户端 `CloudEmbeddingProvider` 把这些转成 RAG 层可处理的异常(失败时索引降级/跳过,不阻塞主流程)。

## 6. 测试

- 后端:`test_openai_compat_provider.py` 追加 `embed` 用例(MockTransport 伪造 Gemini `/embeddings` 响应);`test_llm_gateway.py` 追加 `embed` 编排用例;新增 `test_llm_router_embeddings.py`(成功+计量、未知模型 400、配额 402)。
- 客户端:`CloudEmbeddingProvider` 单测(mock CloudClient),resolver 选择逻辑单测。

## 7. 非目标

- STT 上云(阶段3)、客户端聊天叶子改写与设置 UI(阶段4)。
- 历史 384 维数据迁移/重算(可选,非本阶段必须)。
- embedding 跨模型回退链(单模型,YAGNI)。
