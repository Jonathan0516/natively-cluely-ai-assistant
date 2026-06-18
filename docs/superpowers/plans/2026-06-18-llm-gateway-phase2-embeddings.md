# LLM 网关 阶段2：Embeddings 上云 + 目录转 Gemini Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增后端 `POST /llm/embeddings`(平台 Gemini key、计量配额),并把阶段1聊天目录 retarget 到 Gemini,客户端 RAG 改为调后端算向量。

**Architecture:** 复用阶段1的 `OpenAICompatProvider`——Gemini 的 OpenAI 兼容端点同时支持 `/chat/completions` 与 `/embeddings`。Provider 加 `embed()`,Gateway 加 `embed()` 编排(单模型无回退),Router 加 `/llm/embeddings`(鉴权→配额→网关→计量)。客户端新增 `CloudEmbeddingProvider` 调 `CloudClient.llmEmbeddings()`,存储/检索侧不动。

**Tech Stack:** 后端 FastAPI + pydantic v2 + httpx(`MockTransport` 测试)+ pytest(`asyncio_mode=auto`,`pythonpath=src`)+ uv + ruff,命令在 `backend/`。客户端 TypeScript(Electron),无单测框架——用 `npx tsc --noEmit` 类型检查 + 手动冒烟验收。

## Global Constraints

- 所有平台调用走 Gemini OpenAI 兼容端点:`base_url = "https://generativelanguage.googleapis.com/v1beta/openai"`,`key_env = "gemini_api_key"`(阶段1已在 `config.py` 加 `gemini_api_key` 字段)。
- embedding 维度固定 **768**(`text-embedding-004` 原生 768)。
- 后端行长 ≤ 100(ruff line-length=100);新代码须 ruff-clean(B008 `Depends` 默认值是仓库既有 FastAPI 约定,豁免)。
- 后端测试文件受根 `.gitignore` 的 `test_*.py` 影响,但已加 `!backend/tests/` 例外,正常 `git add` 即可。
- 不触碰 `/embeddings/*` 存储/检索、`SemanticChunker`、`VectorStore`、`RAGRetriever`。

---

## File Structure

```
backend/
  src/app/
    services/
      llm_types.py        # 修改:加 EmbedResult
      model_catalog.py    # 修改:retarget 到 Gemini + 加 embed-default spec + embed_dim 字段
      providers/base.py   # 修改:Provider Protocol 加 embed()
      providers/openai_compat.py  # 修改:加 embed()
      llm_gateway.py      # 修改:加 embed()
    deps.py               # 修改:_OpenAICompatRouter 加 embed()
    routers/llm.py        # 修改:加 POST /llm/embeddings;/llm/models 过滤掉纯 embedding 模型
  tests/
    conftest.py           # 修改:FakeProvider 加 embed()
    test_model_catalog.py # 修改:加 embedding 目录用例
    test_openai_compat_provider.py  # 修改:加 embed 用例
    test_llm_gateway.py   # 修改:加 embed 编排用例
    test_llm_router_embeddings.py   # 新增
    test_llm_router_models_quota.py # 修改:断言 embed-default 不在 /llm/models
electron/
  services/CloudClient.ts # 修改:加 llmEmbeddings()
  rag/providers/CloudEmbeddingProvider.ts  # 新增
  rag/EmbeddingProviderResolver.ts         # 修改:首选 CloudEmbeddingProvider
```

---

## Task 1: 共享类型 + 模型目录转 Gemini

**Files:**
- Modify: `backend/src/app/services/llm_types.py`
- Modify: `backend/src/app/services/model_catalog.py`
- Test: `backend/tests/test_model_catalog.py`

**Interfaces:**
- Produces: `EmbedResult(vectors: list[list[float]], dim: int, usage: Usage, model: str)`;`ModelSpec.embed_dim: int`;`CATALOG` 含 `answer-fast`/`answer-pro`/`embed-default`(均 provider=`openai_compat`,base=Gemini,key_env=`gemini_api_key`)。

- [ ] **Step 1: 加 EmbedResult 到 llm_types.py**

在 `backend/src/app/services/llm_types.py` 的 `GenResult` 之后插入:

```python
@dataclass
class EmbedResult:
    vectors: list[list[float]]
    dim: int
    usage: Usage
    model: str         # actual upstream model used
```

- [ ] **Step 2: 写失败测试(model_catalog)**

把 `backend/tests/test_model_catalog.py` 整体替换为:

```python
from app.services.model_catalog import CATALOG, PLANS, credits_for


def test_catalog_has_free_and_pro_models():
    tiers = {m.tier for m in CATALOG.values()}
    assert "free" in tiers and "pro" in tiers


def test_every_model_points_at_gemini():
    for m in CATALOG.values():
        assert m.provider == "openai_compat"
        assert m.base_url.startswith("https://generativelanguage.googleapis.com")
        assert m.key_env == "gemini_api_key"


def test_chat_models_use_gemini_3_1():
    assert CATALOG["answer-fast"].upstream_model == "gemini-3.1-flash-lite"
    assert CATALOG["answer-pro"].upstream_model == "gemini-3.1-pro-preview"
    assert "answer-netmind" not in CATALOG


def test_embedding_model_present_768d():
    spec = CATALOG["embed-default"]
    assert spec.capabilities == ("embedding",)
    assert spec.embed_dim == 768
    assert spec.upstream_model == "text-embedding-004"


def test_credits_rounds_up_from_tokens():
    spec = CATALOG["answer-pro"]
    c = credits_for(spec, input_tokens=1000, output_tokens=1000)
    assert c >= 1


def test_plans_define_free_and_pro():
    assert PLANS["free"].credits_per_period > 0
    assert "pro" in PLANS["pro"].allowed_tiers
```

- [ ] **Step 3: 跑,预期失败**

Run: `uv run pytest tests/test_model_catalog.py -v`
Expected: FAIL（KeyError/AttributeError：embed-default / embed_dim 不存在）

- [ ] **Step 4: 改写 model_catalog.py**

把 `backend/src/app/services/model_catalog.py` 的常量、`ModelSpec`、`CATALOG` 部分改为:

```python
GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"


@dataclass(frozen=True)
class ModelSpec:
    id: str                       # logical id, e.g. "answer-pro"
    label: str
    tier: str                     # "free" | "pro"
    provider: str                 # "openai_compat"
    upstream_model: str           # actual model name sent upstream
    base_url: str
    key_env: str                  # settings attribute holding the platform key
    capabilities: tuple[str, ...] = ("text", "json")
    credits_per_1k_input: float = 1.0
    credits_per_1k_output: float = 3.0
    embed_dim: int = 0            # >0 only for embedding models
    fallbacks: tuple[str, ...] = ()   # logical ids tried if this one fails


@dataclass(frozen=True)
class Plan:
    id: str
    label: str
    credits_per_period: int
    period: str                   # "month" | "week"
    allowed_tiers: tuple[str, ...]


CATALOG: dict[str, ModelSpec] = {
    "answer-fast": ModelSpec(
        id="answer-fast", label="Fast", tier="free", provider="openai_compat",
        upstream_model="gemini-3.1-flash-lite", base_url=GEMINI_OPENAI_BASE, key_env="gemini_api_key",
        capabilities=("text", "json"), credits_per_1k_input=0.5, credits_per_1k_output=1.5,
        fallbacks=("answer-pro",),
    ),
    "answer-pro": ModelSpec(
        id="answer-pro", label="Pro", tier="pro", provider="openai_compat",
        upstream_model="gemini-3.1-pro-preview", base_url=GEMINI_OPENAI_BASE, key_env="gemini_api_key",
        capabilities=("text", "json", "vision"),
        credits_per_1k_input=5.0, credits_per_1k_output=15.0,
    ),
    "embed-default": ModelSpec(
        id="embed-default", label="Embeddings", tier="free", provider="openai_compat",
        upstream_model="text-embedding-004", base_url=GEMINI_OPENAI_BASE, key_env="gemini_api_key",
        capabilities=("embedding",), credits_per_1k_input=0.1, credits_per_1k_output=0.0,
        embed_dim=768,
    ),
}
```

（`PLANS`、`DEFAULT_PLAN`、`credits_for` 不变;删掉旧的 `NETMIND_BASE`/`OPENAI_BASE`/`GROQ_BASE` 常量与 `answer-netmind`。）

- [ ] **Step 5: 跑,预期通过**

Run: `uv run pytest tests/test_model_catalog.py -v`
Expected: PASS（6 passed）

- [ ] **Step 6: 提交**

```bash
git add backend/src/app/services/llm_types.py backend/src/app/services/model_catalog.py backend/tests/test_model_catalog.py
git commit -m "feat(llm): retarget catalog to Gemini and add embedding model spec"
```

---

## Task 2: Provider.embed()（OpenAI 兼容 /embeddings）

**Files:**
- Modify: `backend/src/app/services/providers/base.py`
- Modify: `backend/src/app/services/providers/openai_compat.py`
- Test: `backend/tests/test_openai_compat_provider.py`

**Interfaces:**
- Consumes: `EmbedResult`(Task 1)。
- Produces: `OpenAICompatProvider.embed(model: str, texts: list[str]) -> EmbedResult`;Provider Protocol 含 `embed`。

- [ ] **Step 1: Provider Protocol 加 embed**

`backend/src/app/services/providers/base.py`:import 加 `EmbedResult`,Protocol 末尾加方法。

```python
from ..llm_types import ChatDelta, ChatMessage, EmbedResult, GenResult
```
```python
    async def embed(
        self, model: str, texts: list[str]
    ) -> EmbedResult: ...
```

- [ ] **Step 2: 写失败测试**

在 `backend/tests/test_openai_compat_provider.py` 末尾追加:

```python
async def test_embed_returns_vectors_and_usage():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "data": [
                {"embedding": [0.1, 0.2, 0.3]},
                {"embedding": [0.4, 0.5, 0.6]},
            ],
            "usage": {"prompt_tokens": 9},
        })

    prov = OpenAICompatProvider(http=_make_client(handler), api_key="k", base_url="https://x/v1")
    res = await prov.embed("text-embedding-004", ["a", "b"])
    assert res.vectors == [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
    assert res.dim == 3
    assert res.usage.input_tokens == 9
```

- [ ] **Step 3: 跑,预期失败**

Run: `uv run pytest tests/test_openai_compat_provider.py::test_embed_returns_vectors_and_usage -v`
Expected: FAIL（AttributeError: 'OpenAICompatProvider' object has no attribute 'embed'）

- [ ] **Step 4: 写实现**

`backend/src/app/services/providers/openai_compat.py`:import 行加 `EmbedResult`,类末尾加方法。

```python
from ..llm_types import ChatDelta, ChatMessage, EmbedResult, GenResult, Usage
```
```python
    async def embed(self, model: str, texts: list[str]) -> EmbedResult:
        payload = {"model": model, "input": texts}
        resp = await self._http.post(
            f"{self._base}/embeddings", headers=self._headers, json=payload
        )
        resp.raise_for_status()
        obj = resp.json()
        vectors = [d["embedding"] for d in obj.get("data", [])]
        usage = obj.get("usage", {})
        dim = len(vectors[0]) if vectors else 0
        return EmbedResult(
            vectors=vectors, dim=dim,
            usage=Usage(input_tokens=usage.get("prompt_tokens", 0), output_tokens=0),
            model=model,
        )
```

- [ ] **Step 5: 跑,预期通过**

Run: `uv run pytest tests/test_openai_compat_provider.py -v`
Expected: PASS（4 passed）

- [ ] **Step 6: 提交**

```bash
git add backend/src/app/services/providers/base.py backend/src/app/services/providers/openai_compat.py backend/tests/test_openai_compat_provider.py
git commit -m "feat(llm): add embed() to provider protocol and openai-compat provider"
```

---

## Task 3: LLMGateway.embed()

**Files:**
- Modify: `backend/src/app/services/llm_gateway.py`
- Test: `backend/tests/test_llm_gateway.py`

**Interfaces:**
- Consumes: `EmbedResult`、`OpenAICompatProvider.embed`。
- Produces: `LLMGateway.embed(model_id: str, texts: list[str]) -> tuple[ModelSpec, EmbedResult]`。

- [ ] **Step 1: 写失败测试**

在 `backend/tests/test_llm_gateway.py` 顶部 import 加 `EmbedResult`:

```python
from app.services.llm_types import ChatDelta, ChatMessage, EmbedResult, GenResult, NoModelAvailable, Usage
```

给 `_OkProvider` 类加 embed 方法(在其 `generate_json` 之后):

```python
    async def embed(self, model, texts):
        return EmbedResult(vectors=[[0.1, 0.2]] * len(texts), dim=2,
                           usage=Usage(input_tokens=5, output_tokens=0), model=model)
```

文件末尾追加测试:

```python
async def test_embed_returns_spec_and_vectors():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    spec, res = await gw.embed("embed-default", ["hello", "world"])
    assert spec.id == "embed-default"
    assert spec.upstream_model == "text-embedding-004"
    assert res.dim == 2 and len(res.vectors) == 2


async def test_embed_unknown_model_raises():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    with pytest.raises(NoModelAvailable):
        await gw.embed("nope", ["x"])
```

- [ ] **Step 2: 跑,预期失败**

Run: `uv run pytest tests/test_llm_gateway.py -v`
Expected: FAIL（AttributeError: 'LLMGateway' object has no attribute 'embed'）

- [ ] **Step 3: 写实现**

`backend/src/app/services/llm_gateway.py`:import 行加 `EmbedResult`,类末尾加方法。

```python
from .llm_types import ChatDelta, ChatMessage, EmbedResult, GenResult, NoModelAvailable
```
```python
    async def embed(
        self, model_id: str, texts: list[str]
    ) -> tuple[ModelSpec, EmbedResult]:
        spec, prov = self.resolve(model_id)
        res = await prov.embed(spec.upstream_model, texts)
        return spec, res
```

- [ ] **Step 4: 跑,预期通过**

Run: `uv run pytest tests/test_llm_gateway.py -v`
Expected: PASS（7 passed）

- [ ] **Step 5: 提交**

```bash
git add backend/src/app/services/llm_gateway.py backend/tests/test_llm_gateway.py
git commit -m "feat(llm): add gateway.embed orchestration"
```

---

## Task 4: deps 装配 embed + conftest FakeProvider

**Files:**
- Modify: `backend/src/app/deps.py`
- Modify: `backend/tests/conftest.py`

**Interfaces:**
- Produces: `_OpenAICompatRouter.embed`(让线上网关能算向量);`FakeProvider.embed`(让 router 测试可用)。

- [ ] **Step 1: deps._OpenAICompatRouter 加 embed**

在 `backend/src/app/deps.py` 的 `_OpenAICompatRouter` 类里,`generate_json` 之后追加:

```python
    async def embed(self, model, texts):
        return await self._provider_for(model).embed(model, texts)
```

- [ ] **Step 2: conftest FakeProvider 加 embed**

`backend/tests/conftest.py`:import 行加 `EmbedResult`,`FakeProvider` 加方法。

```python
from app.services.llm_types import ChatDelta, EmbedResult, GenResult, Usage
```
在 `FakeProvider.generate_json` 之后追加:

```python
    async def embed(self, model, texts):
        if self.fail:
            raise RuntimeError("provider down")
        return EmbedResult(vectors=[[0.01, 0.02, 0.03]] * len(texts), dim=3,
                           usage=Usage(input_tokens=6, output_tokens=0), model=model)
```

- [ ] **Step 3: 验证后端能 import 启动**

Run: `PYTHONPATH=src uv run python -c "from app.main import app; print('ok')"`
Expected: 输出 `ok`

- [ ] **Step 4: 提交**

```bash
git add backend/src/app/deps.py backend/tests/conftest.py
git commit -m "feat(llm): wire embed through deps router and test fake provider"
```

---

## Task 5: POST /llm/embeddings + /llm/models 过滤 embedding

**Files:**
- Modify: `backend/src/app/routers/llm.py`
- Test: `backend/tests/test_llm_router_embeddings.py`（新增）
- Test: `backend/tests/test_llm_router_models_quota.py`（修改）

**Interfaces:**
- Consumes: `LLMGateway.embed`、`UsageMeter.record(kind="embeddings")`。
- Produces: `POST /llm/embeddings` → `{embeddings, dim, model}`;`GET /llm/models` 不再列纯 embedding 模型。

- [ ] **Step 1: 写失败测试(embeddings 路由)**

新增 `backend/tests/test_llm_router_embeddings.py`:

```python
async def test_embeddings_returns_vectors_and_records_usage(client, usage_repo):
    resp = client.post("/llm/embeddings", json={"texts": ["hi", "there"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["dim"] == 3
    assert len(data["embeddings"]) == 2
    assert data["model"] == "embed-default"
    used = await usage_repo.credits_used_since("u-test", "1970-01-01T00:00:00+00:00")
    assert used >= 1


async def test_embeddings_402_when_quota_exhausted(client, usage_repo):
    await usage_repo.record_event("u-test", kind="embeddings", model="embed-default",
                                  input_tokens=0, output_tokens=0, credits=1000)
    resp = client.post("/llm/embeddings", json={"texts": ["hi"]})
    assert resp.status_code == 402
    assert resp.json()["detail"]["error"] == "quota_exceeded"


def test_embeddings_unknown_model_returns_400(client):
    resp = client.post("/llm/embeddings", json={"texts": ["hi"], "model": "nope"})
    assert resp.status_code == 400
```

- [ ] **Step 2: 改 models 测试,断言不含 embedding**

`backend/tests/test_llm_router_models_quota.py` 的 `test_models_lists_catalog_with_availability` 末尾追加:

```python
    assert "embed-default" not in by_id
```

- [ ] **Step 3: 跑,预期失败**

Run: `uv run pytest tests/test_llm_router_embeddings.py tests/test_llm_router_models_quota.py -v`
Expected: FAIL（embeddings 路由 404;models 仍含 embed-default）

- [ ] **Step 4: 加 /llm/embeddings 端点 + 过滤 models**

在 `backend/src/app/routers/llm.py` 末尾追加端点:

```python
class EmbeddingsRequest(BaseModel):
    texts: list[str]
    model: str = "embed-default"


@router.post("/embeddings")
async def llm_embeddings(
    body: EmbeddingsRequest,
    user: Annotated[User, Depends(get_current_user)],
    gateway: Annotated[LLMGateway, Depends(get_llm_gateway)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> dict:
    try:
        await meter.check(user.id)
    except QuotaExceeded as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, _quota_detail(exc)) from exc
    try:
        spec, res = await gateway.embed(body.model, body.texts)
    except NoModelAvailable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    await meter.record(user.id, kind="embeddings", spec=spec, usage=res.usage)
    return {"embeddings": res.vectors, "dim": res.dim, "model": spec.id}
```

在 `llm_models` 的列表推导加过滤(只列可聊天的模型):

```python
    return [
        {
            "id": s.id, "label": s.label, "tier": s.tier,
            "capabilities": list(s.capabilities),
            "available": s.tier in allowed,
        }
        for s in CATALOG.values()
        if "text" in s.capabilities
    ]
```

- [ ] **Step 5: 跑,预期通过**

Run: `uv run pytest tests/test_llm_router_embeddings.py tests/test_llm_router_models_quota.py -v`
Expected: PASS（5 passed）

- [ ] **Step 6: 提交**

```bash
git add backend/src/app/routers/llm.py backend/tests/test_llm_router_embeddings.py backend/tests/test_llm_router_models_quota.py
git commit -m "feat(llm): add POST /llm/embeddings with metering; hide embedding model from /llm/models"
```

---

## Task 6: 后端全量回归 + lint

**Files:** 无（验证）

- [ ] **Step 1: 全部后端测试**

Run: `uv run pytest -q`
Expected: 全绿（约 30 passed）

- [ ] **Step 2: ruff（只看本阶段改动文件）**

Run: `uv run ruff check src/app/services/llm_types.py src/app/services/model_catalog.py src/app/services/providers/base.py src/app/services/providers/openai_compat.py src/app/services/llm_gateway.py src/app/routers/llm.py tests/conftest.py tests/test_model_catalog.py tests/test_openai_compat_provider.py tests/test_llm_gateway.py tests/test_llm_router_embeddings.py`
Expected: All checks passed（B008 在 deps.py,本任务不改 deps 的签名;如有 E501 自行折行修复后重跑）

- [ ] **Step 3: openapi 冒烟**

Run: `PYTHONPATH=src uv run python -c "from app.main import app; print(sorted(p for p in app.openapi()['paths'] if p.startswith('/llm')))"`
Expected: 含 `/llm/embeddings`、`/llm/chat`、`/llm/json`、`/llm/models`、`/llm/quota`

- [ ] **Step 4: 提交（如 ruff 有改动）**

```bash
git add -A backend && git commit -m "chore(llm): phase-2 backend embeddings regression green"
```

---

## Task 7: 客户端 CloudClient.llmEmbeddings()

**Files:**
- Modify: `electron/services/CloudClient.ts`

**Interfaces:**
- Produces: `CloudClient.llmEmbeddings(texts: string[], model?: string): Promise<{ embeddings: number[][]; dim: number; model: string }>`。

- [ ] **Step 1: 加方法**

在 `electron/services/CloudClient.ts` 现有 embeddings 相关方法附近(如 `searchSummaries` 之后)追加(复用现有私有 `post`):

```ts
  /** Compute embeddings on the backend (platform Gemini key, metered). */
  async llmEmbeddings(
    texts: string[],
    model?: string
  ): Promise<{ embeddings: number[][]; dim: number; model: string }> {
    return this.post(`/llm/embeddings`, model ? { texts, model } : { texts })
  }
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无新增类型错误（与改动前一致）

> 若仓库 tsc 基线本就有报错,只确认未引入与 `CloudClient.ts` / `llmEmbeddings` 相关的新错误。

- [ ] **Step 3: 提交**

```bash
git add electron/services/CloudClient.ts
git commit -m "feat(client): add CloudClient.llmEmbeddings calling POST /llm/embeddings"
```

---

## Task 8: CloudEmbeddingProvider + resolver 接入

**Files:**
- Create: `electron/rag/providers/CloudEmbeddingProvider.ts`
- Modify: `electron/rag/EmbeddingProviderResolver.ts`

**Interfaces:**
- Consumes: `CloudClient.getInstance().isAuthenticated()`、`CloudClient.llmEmbeddings`(Task 7)、`IEmbeddingProvider`。
- Produces: 登录后 RAG 走后端算向量(768 维)。

- [ ] **Step 1: 新增 CloudEmbeddingProvider**

`electron/rag/providers/CloudEmbeddingProvider.ts`:

```ts
import { IEmbeddingProvider } from './IEmbeddingProvider';
import { CloudClient } from '../../services/CloudClient';

/**
 * Computes embeddings via the backend /llm/embeddings gateway (platform Gemini key).
 * Selected first whenever the user is authenticated; replaces the old local OpenAI/
 * Gemini/Ollama providers.
 */
export class CloudEmbeddingProvider implements IEmbeddingProvider {
  readonly name = 'cloud';
  readonly dimensions = 768; // text-embedding-004 @ 768d

  async isAvailable(): Promise<boolean> {
    try {
      return CloudClient.getInstance().isAuthenticated();
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const out = await this.embedBatch([text]);
    return out[0];
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await CloudClient.getInstance().llmEmbeddings(texts);
    return res.embeddings;
  }
}
```

- [ ] **Step 2: resolver 首选 Cloud,移除本地 OpenAI/Gemini/Ollama**

把 `electron/rag/EmbeddingProviderResolver.ts` 整体替换为:

```ts
import { IEmbeddingProvider } from './providers/IEmbeddingProvider';
import { CloudEmbeddingProvider } from './providers/CloudEmbeddingProvider';
import { LocalEmbeddingProvider } from './providers/LocalEmbeddingProvider';

export interface AppAPIConfig {
  openaiKey?: string;
  geminiKey?: string;
  ollamaUrl?: string;
}

export class EmbeddingProviderResolver {
  /**
   * Returns the best available provider.
   * Cloud (backend gateway, platform Gemini key) is preferred when authenticated.
   * Local bundled model is the unconditional offline fallback — always last.
   */
  static async resolve(_config: AppAPIConfig): Promise<IEmbeddingProvider> {
    const candidates: IEmbeddingProvider[] = [
      new CloudEmbeddingProvider(),
      new LocalEmbeddingProvider(), // offline fallback, always works
    ];

    for (const provider of candidates) {
      const available = await provider.isAvailable();
      if (available) {
        console.log(`[EmbeddingProviderResolver] Selected provider: ${provider.name} (${provider.dimensions}d)`);
        return provider;
      }
      console.log(`[EmbeddingProviderResolver] Provider ${provider.name} unavailable, trying next...`);
    }

    throw new Error('No embedding provider available. The bundled model may be corrupted. Please reinstall.');
  }
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 无新增类型错误。`OpenAIEmbeddingProvider`/`GeminiEmbeddingProvider`/`OllamaEmbeddingProvider` 不再被 resolver 引用——保留文件即可(阶段4再删),不应产生未使用 import 报错(它们仍是独立模块)。

- [ ] **Step 4: 提交**

```bash
git add electron/rag/providers/CloudEmbeddingProvider.ts electron/rag/EmbeddingProviderResolver.ts
git commit -m "feat(client): route RAG embeddings through backend CloudEmbeddingProvider"
```

---

## Task 9: 联机冒烟验收（需平台 Gemini key）

**Files:** 无（验证）

- [ ] **Step 1: 确认 backend/.env 有 `GEMINI_API_KEY`**

Run: `grep -E '^GEMINI_API_KEY=.' backend/.env && echo present || echo MISSING`
Expected: `present`（缺则填入真实 key;无 key 时本任务跳过,后端单测已覆盖逻辑）

- [ ] **Step 2: 起后端,mint token,调 /llm/embeddings**

```bash
cd backend
uv run uvicorn app.main:app --app-dir src --port 8000 &
until curl -sf http://localhost:8000/health >/dev/null; do sleep 0.5; done
TOKEN=$(PYTHONPATH=src uv run python -c "from app.config import get_settings as g; from app.services.jwt_service import JwtService as J; s=g(); print(J(secret=s.jwt_secret,algorithm=s.jwt_algorithm,access_ttl=s.jwt_access_ttl_seconds,refresh_ttl=s.jwt_refresh_ttl_seconds).issue('f4e48046-3c71-438d-811e-2eeb5c1572af','13800138001').access_token)")
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"texts":["hello world","second text"]}' http://localhost:8000/llm/embeddings \
  | python -c "import sys,json; d=json.load(sys.stdin); print('vectors:',len(d['embeddings']),'dim:',d['dim'],'model:',d['model'])"
kill %1
```
Expected: `vectors: 2 dim: 768 model: embed-default`（真实 Gemini 768 维向量）

- [ ] **Step 3: 确认计量落库**

在 Supabase 查 `select kind, model, credits from usage_events where kind='embeddings' order by created_at desc limit 3;`
Expected: 有一条 `embeddings / embed-default / credits>=1`。

> 注:Step 2/3 需真实 key;CI/无 key 环境跳过——逻辑由后端单测(Task 5)用 MockTransport 全覆盖。

---

## Self-Review（计划自查结论）

- **Spec 覆盖**:spec §3.1 目录转 Gemini + embed spec → Task 1;§3.2 Provider.embed → Task 2;§3.3 Gateway.embed → Task 3;§3.4 `/llm/embeddings` 路由 → Task 5;§3.5 计量(kind=embeddings)→ Task 5 + meter 复用;§4.1 CloudClient.llmEmbeddings → Task 7;§4.2 CloudEmbeddingProvider + resolver → Task 8;§6 测试散落各任务;§5 鉴权沿用阶段1。deps 线上装配(spec 未显式列但实现必需)→ Task 4。
- **占位符**:无 TBD;每个代码步骤含完整代码与命令。
- **类型一致性**:`EmbedResult(vectors/dim/usage/model)`(Task 1)贯穿 provider(Task 2)、gateway(Task 3)、router(Task 5);`ModelSpec.embed_dim`、`CATALOG["embed-default"]`、`gateway.embed`、`provider.embed`、`_OpenAICompatRouter.embed`、`FakeProvider.embed`、`CloudClient.llmEmbeddings`、`CloudEmbeddingProvider` 命名在定义与使用处一致。
- **已知前提**:`text-embedding-004` 经 Gemini OpenAI 兼容端点可用且返回 768 维——单测用 MockTransport 不依赖此,真实性由 Task 9 联机验;若该模型名在兼容端点不可用,改用 `gemini-embedding-001` 并在请求体加 `"dimensions": 768`(只动 Task 1 的 upstream_model 与 Task 2 的 payload)。
- **回归影响**:阶段1测试中引用 `answer-netmind` 的仅 `test_llm_gateway::test_generate_json_falls_back_on_failure`,其断言为 `NoModelAvailable`,移除 netmind 后 answer-pro 无回退仍抛 `NoModelAvailable`,通过。
