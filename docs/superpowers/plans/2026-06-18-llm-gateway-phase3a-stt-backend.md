# LLM 网关 阶段3a：STT 后端 WS 反代 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 FastAPI 后端实现 `WS /llm/stt`——鉴权(JWT)+ 配额检查 + 反代 Deepgram 实时转写 + 按音频秒计量,作为客户端 STT 切换的地基。

**Architecture:** 新增 `stt_relay`(可注入的上游连接器 Protocol + 原生 `websockets` 实现 Deepgram)、`WS /llm/stt` 端点(双向中继 + 配额硬切 + 关闭时记账)。计量复用 `UsageMeter`,新增 `kind="stt"` 按音频秒换算 credits 的分支。上游连接器经 deps 注入,测试用假上游(无网络)。

**Tech Stack:** FastAPI WebSocket + 原生 `websockets`(上游)+ pytest(`TestClient.websocket_connect`)+ uv + ruff。命令在 `backend/`。

## Global Constraints

- WS 鉴权:`?token=<jwt>` 查询参数,复用 `JwtService.verify(token, expected_type="access")` + `UserRepo.get_by_id`。
- 平台 key:`settings.deepgram_api_key`(阶段1已加字段;key 已在 `.env`)。
- 关闭码:`4401` 鉴权失败、`4029` 配额耗尽、`1011` 上游故障、`1000` 正常。
- 音频秒:`total_bytes / (sample_rate * channels * 2)`(linear16=2 字节/采样)。
- STT credits:`max(1, ceil(audio_seconds * spec.credits_per_audio_second))`。
- 后端行长 ≤ 100;新代码 ruff-clean(`Depends` 默认值 B008 是仓库既有约定,豁免)。
- 本阶段**只含后端**;客户端改写(DeepgramStreamingSTT + 删除其余 STT provider)是阶段3b 独立 plan。

---

## File Structure

```
backend/
  pyproject.toml                      # 修改:加 websockets 依赖
  src/app/
    services/
      model_catalog.py                # 修改:加 stt-default spec + credits_per_audio_second 字段
      usage_meter.py                  # 修改:record() 加 STT 分支
      stt_relay.py                    # 新增:Upstream/DeepgramUpstream Protocol + WebsocketsDeepgramUpstream + audio_seconds_for
    deps.py                           # 修改:get_stt_upstream();_by_upstream 只索引 openai_compat
    routers/stt.py                    # 新增:WS /llm/stt
    main.py                           # 修改:include stt.router
  tests/
    conftest.py                       # 修改:FakeUpstream/FakeDeepgram + get_stt_upstream 覆盖 + get_user_repo/get_jwt_service 覆盖
    test_model_catalog.py             # 修改:stt-default 断言;Gemini 断言排除 stt
    test_usage_meter.py               # 修改:加 STT 计量用例
    test_stt_relay.py                 # 新增:audio_seconds_for + URL 构建
    test_stt_router.py                # 新增:WS 鉴权/配额/中继/计量
```

---

## Task 1: 模型目录 STT spec + 计量分支

**Files:**
- Modify: `backend/src/app/services/model_catalog.py`
- Modify: `backend/src/app/services/usage_meter.py`
- Test: `backend/tests/test_model_catalog.py`, `backend/tests/test_usage_meter.py`

**Interfaces:**
- Produces: `CATALOG["stt-default"]`(provider=`deepgram`, `credits_per_audio_second>0`);`ModelSpec.credits_per_audio_second: float`;`UsageMeter.record(kind="stt", …, audio_seconds=…)` 按秒计 credits。

- [ ] **Step 1: 改 model_catalog 测试**

`backend/tests/test_model_catalog.py` 的 `test_every_model_points_at_gemini` 改为只校验 LLM(openai_compat)模型,并加 stt 断言:

```python
def test_llm_models_point_at_gemini():
    for m in CATALOG.values():
        if m.provider != "openai_compat":
            continue
        assert m.base_url.startswith("https://generativelanguage.googleapis.com")
        assert m.key_env == "gemini_api_key"


def test_stt_model_present():
    spec = CATALOG["stt-default"]
    assert spec.provider == "deepgram"
    assert spec.capabilities == ("stt",)
    assert spec.key_env == "deepgram_api_key"
    assert spec.credits_per_audio_second > 0
```

(删除旧的 `test_every_model_points_at_gemini`。)

- [ ] **Step 2: 加 STT 计量测试**

`backend/tests/test_usage_meter.py` 末尾追加:

```python
async def test_stt_credits_by_audio_seconds():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    spec = CATALOG["stt-default"]
    credits = await meter.record("u1", kind="stt", spec=spec, usage=Usage(), audio_seconds=100.0)
    # 100s * credits_per_audio_second (0.1) = 10 credits
    assert credits == 10
    used = await repo.credits_used_since("u1", "1970-01-01T00:00:00+00:00")
    assert used == 10


async def test_stt_min_one_credit():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    credits = await meter.record("u1", kind="stt", spec=CATALOG["stt-default"], usage=Usage(),
                                 audio_seconds=0.5)
    assert credits == 1
```

- [ ] **Step 3: 跑,预期失败**

Run: `uv run pytest tests/test_model_catalog.py tests/test_usage_meter.py -v`
Expected: FAIL（KeyError stt-default / AttributeError credits_per_audio_second）

- [ ] **Step 4: 加 ModelSpec 字段 + stt-default spec**

`backend/src/app/services/model_catalog.py`:`ModelSpec` 的 `embed_dim` 行下方加字段:

```python
    credits_per_audio_second: float = 0.0   # >0 only for STT models
```

`CATALOG` 字典末尾(`embed-default` 之后)加:

```python
    "stt-default": ModelSpec(
        id="stt-default", label="Speech-to-Text", tier="free", provider="deepgram",
        upstream_model="nova-2", base_url="wss://api.deepgram.com/v1/listen",
        key_env="deepgram_api_key", capabilities=("stt",),
        credits_per_audio_second=0.1,
    ),
```

- [ ] **Step 5: usage_meter.record 加 STT 分支**

`backend/src/app/services/usage_meter.py`:顶部加 `import math`,改 `record` 的 credits 计算:

```python
        if kind == "stt":
            credits = max(1, math.ceil(audio_seconds * spec.credits_per_audio_second))
        else:
            credits = credits_for(spec, usage.input_tokens, usage.output_tokens)
            if audio_seconds:
                credits = max(credits, max(1, round(audio_seconds)))
```

(替换原来的 `credits = credits_for(...)` + `if audio_seconds:` 两行。)

- [ ] **Step 6: 跑,预期通过**

Run: `uv run pytest tests/test_model_catalog.py tests/test_usage_meter.py -v`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add backend/src/app/services/model_catalog.py backend/src/app/services/usage_meter.py backend/tests/test_model_catalog.py backend/tests/test_usage_meter.py
git commit -m "feat(stt): add stt-default catalog spec and per-audio-second metering"
```

---

## Task 2: stt_relay service（协议 + 上游实现 + 工具函数）

**Files:**
- Create: `backend/src/app/services/stt_relay.py`
- Test: `backend/tests/test_stt_relay.py`

**Interfaces:**
- Produces: `audio_seconds_for(total_bytes, sample_rate, channels, bytes_per_sample=2) -> float`;`Upstream` Protocol(`send(bytes)`, `__aiter__()->AsyncIterator[str]`, `close()`);`DeepgramUpstream` Protocol(`connect(params: dict) -> Upstream`);`WebsocketsDeepgramUpstream(api_key, base_url)`;`build_deepgram_url(base_url, params) -> str`。

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_stt_relay.py
from app.services.stt_relay import audio_seconds_for, build_deepgram_url


def test_audio_seconds_for_linear16_mono():
    # 32000 bytes @ 16000Hz mono 16-bit = 1.0s
    assert audio_seconds_for(32000, 16000, 1) == 1.0


def test_audio_seconds_for_zero_denominator_is_safe():
    assert audio_seconds_for(1000, 0, 1) == 0.0


def test_build_deepgram_url_encodes_params():
    url = build_deepgram_url("wss://api.deepgram.com/v1/listen",
                             {"encoding": "linear16", "sample_rate": "16000", "model": "nova-2"})
    assert url.startswith("wss://api.deepgram.com/v1/listen?")
    assert "encoding=linear16" in url
    assert "sample_rate=16000" in url
    assert "model=nova-2" in url
```

- [ ] **Step 2: 跑,预期失败**

Run: `uv run pytest tests/test_stt_relay.py -v`
Expected: FAIL（ModuleNotFoundError: stt_relay）

- [ ] **Step 3: 写实现**

```python
# backend/src/app/services/stt_relay.py
"""Backend reverse-proxy to Deepgram realtime STT. The upstream connector is a Protocol so
the WS endpoint can be tested against a fake (no network). Production impl uses raw websockets."""
from __future__ import annotations

import json
import logging
import urllib.parse
from collections.abc import AsyncIterator
from typing import Protocol

logger = logging.getLogger(__name__)


def audio_seconds_for(total_bytes: int, sample_rate: int, channels: int,
                      bytes_per_sample: int = 2) -> float:
    denom = sample_rate * channels * bytes_per_sample
    return total_bytes / denom if denom else 0.0


def build_deepgram_url(base_url: str, params: dict) -> str:
    return f"{base_url}?{urllib.parse.urlencode(params)}"


class Upstream(Protocol):
    async def send(self, data: bytes) -> None: ...
    def __aiter__(self) -> AsyncIterator[str]: ...
    async def close(self) -> None: ...


class DeepgramUpstream(Protocol):
    async def connect(self, params: dict) -> Upstream: ...


def _transcript_from_deepgram(raw: str) -> str | None:
    """Normalize a Deepgram message to our client JSON {text,isFinal,confidence}, or None."""
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return None
    alt = ((obj.get("channel") or {}).get("alternatives") or [{}])[0]
    text = alt.get("transcript")
    if not text:
        return None
    return json.dumps({
        "text": text,
        "isFinal": bool(obj.get("is_final", False)),
        "confidence": alt.get("confidence", 0.0),
    })


class _WsUpstream:
    def __init__(self, ws) -> None:
        self._ws = ws

    async def send(self, data: bytes) -> None:
        await self._ws.send(data)

    async def __aiter__(self) -> AsyncIterator[str]:
        async for raw in self._ws:
            text = _transcript_from_deepgram(raw)
            if text:
                yield text

    async def close(self) -> None:
        await self._ws.close()


class WebsocketsDeepgramUpstream:
    """Production upstream: connects to Deepgram listen WS with the platform key."""
    def __init__(self, api_key: str, base_url: str) -> None:
        self._key = api_key
        self._base = base_url

    async def connect(self, params: dict) -> Upstream:
        import websockets
        url = build_deepgram_url(self._base, params)
        ws = await websockets.connect(
            url, additional_headers={"Authorization": f"Token {self._key}"}
        )
        return _WsUpstream(ws)
```

> 注:`_WsUpstream.__aiter__` 写成 `async def ... yield` 的异步生成器方法,`async for x in upstream` 可直接用。

- [ ] **Step 4: 跑,预期通过**

Run: `uv run pytest tests/test_stt_relay.py -v`
Expected: PASS（3 passed）

- [ ] **Step 5: 加 websockets 依赖**

`backend/pyproject.toml` 的 `dependencies` 列表加一行:`"websockets>=13",`。然后:

Run: `uv sync`
Expected: 安装成功(websockets 通常已随 uvicorn[standard] 存在)。

- [ ] **Step 6: 提交**

```bash
git add backend/src/app/services/stt_relay.py backend/tests/test_stt_relay.py backend/pyproject.toml backend/uv.lock
git commit -m "feat(stt): add stt_relay (upstream protocol, deepgram impl, audio-seconds helper)"
```

---

## Task 3: deps 装配 + conftest 假上游

**Files:**
- Modify: `backend/src/app/deps.py`
- Modify: `backend/tests/conftest.py`

**Interfaces:**
- Produces: `get_stt_upstream() -> DeepgramUpstream`;conftest `FakeUpstream`/`FakeDeepgram` + `client` fixture 覆盖 `get_stt_upstream`、`get_user_repo`、`get_jwt_service`。

- [ ] **Step 1: deps 加 get_stt_upstream + 收紧 _by_upstream**

`backend/src/app/deps.py`:import 区加 `from .services.stt_relay import WebsocketsDeepgramUpstream`;`_OpenAICompatRouter.__init__` 里把 `_by_upstream` 改为只索引 openai_compat:

```python
        self._by_upstream = {
            s.upstream_model: s for s in CATALOG.values() if s.provider == "openai_compat"
        }
```

文件末尾加:

```python
@lru_cache
def get_stt_upstream() -> WebsocketsDeepgramUpstream:
    settings = get_settings()
    return WebsocketsDeepgramUpstream(
        api_key=settings.deepgram_api_key,
        base_url="wss://api.deepgram.com/v1/listen",
    )
```

- [ ] **Step 2: conftest 加假上游 + 覆盖**

`backend/tests/conftest.py`:顶部 import 加:

```python
import asyncio

from app.deps import get_jwt_service, get_stt_upstream, get_user_repo
from app.services.jwt_service import JwtService
from app.services.user_repo import InMemoryUserRepo
```

加假上游类(`TEST_USER` 定义之后):

```python
class FakeUpstream:
    def __init__(self, transcripts):
        self._transcripts = list(transcripts)
        self.sent: list[bytes] = []
        self._done = asyncio.Event()

    async def send(self, data):
        self.sent.append(data)

    async def __aiter__(self):
        for t in self._transcripts:
            yield t
        await self._done.wait()  # stay open until the endpoint closes us

    async def close(self):
        self._done.set()


class FakeDeepgram:
    def __init__(self, transcripts=None):
        self.transcripts = transcripts or ['{"channel": {"alternatives": [{"transcript": "hello world", "confidence": 0.9}]}, "is_final": true}']
        self.last: FakeUpstream | None = None

    async def connect(self, params):
        # transcripts here are already normalized client JSON for the fake path
        self.last = FakeUpstream(['{"text": "hello world", "isFinal": true, "confidence": 0.9}'])
        return self.last
```

加 fixtures + 在 `client` fixture 里追加覆盖:

```python
@pytest.fixture
def fake_stt():
    return FakeDeepgram()


@pytest.fixture
def jwt_svc():
    from app.config import get_settings
    s = get_settings()
    return JwtService(secret=s.jwt_secret, algorithm=s.jwt_algorithm,
                      access_ttl=s.jwt_access_ttl_seconds, refresh_ttl=s.jwt_refresh_ttl_seconds)


@pytest.fixture
def user_repo_with_test_user():
    repo = InMemoryUserRepo()
    repo._by_id[TEST_USER.id] = TEST_USER  # seed for WS token auth
    return repo
```

在现有 `client` fixture 的 override 块里追加(STT 用):

```python
    app.dependency_overrides[get_stt_upstream] = lambda: fake_stt
    app.dependency_overrides[get_user_repo] = lambda: user_repo_with_test_user
    app.dependency_overrides[get_jwt_service] = lambda: jwt_svc
```

并把 `client` fixture 签名改为 `def client(usage_repo, usage_meter, fake_gateway, fake_stt, user_repo_with_test_user, jwt_svc):`。

- [ ] **Step 3: 验证 import 启动**

Run: `PYTHONPATH=src uv run python -c "from app.main import app; print('ok')"`
Expected: `ok`

- [ ] **Step 4: 全量回归(确保没破坏现有 client fixture 用例)**

Run: `uv run pytest -q`
Expected: 全绿(STT 端点尚未加,但 fixture 改动不应破坏现有用例)

- [ ] **Step 5: 提交**

```bash
git add backend/src/app/deps.py backend/tests/conftest.py
git commit -m "feat(stt): wire get_stt_upstream and test fakes for stt relay"
```

---

## Task 4: WS /llm/stt 端点

**Files:**
- Create: `backend/src/app/routers/stt.py`
- Modify: `backend/src/app/main.py`
- Test: `backend/tests/test_stt_router.py`

**Interfaces:**
- Consumes: `get_jwt_service`, `get_user_repo`, `get_usage_meter`, `get_stt_upstream`, `audio_seconds_for`, `CATALOG["stt-default"]`, `Usage`。
- Produces: `WS /llm/stt`。

- [ ] **Step 1: 写失败测试**

```python
# backend/tests/test_stt_router.py
import json

import pytest
from starlette.websockets import WebSocketDisconnect


def test_stt_rejects_missing_token(client):
    # no override of auth here: bad/empty token must close with 4401
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect("/llm/stt") as ws:
            ws.receive_text()
    assert ei.value.code == 4401


def test_stt_rejects_bad_token(client):
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect("/llm/stt?token=garbage") as ws:
            ws.receive_text()
    assert ei.value.code == 4401


def test_stt_relays_transcripts_and_meters(client, jwt_svc, usage_repo):
    token = jwt_svc.issue(id_for(), "+10000000000").access_token
    url = f"/llm/stt?token={token}&sample_rate=16000&channels=1"
    with client.websocket_connect(url) as ws:
        msg = ws.receive_text()             # fake yields one transcript on connect
        assert json.loads(msg)["text"] == "hello world"
        ws.send_bytes(b"\x00" * 32000)      # 1.0s of linear16 mono audio
    # after disconnect the endpoint records stt usage
    # (poll briefly to avoid a close/record race)
    import time
    for _ in range(50):
        if any(e["kind"] == "stt" for e in usage_repo._events):
            break
        time.sleep(0.02)
    stt = [e for e in usage_repo._events if e["kind"] == "stt"]
    assert stt and stt[0]["credits"] >= 1


def id_for():
    from tests.conftest import TEST_USER
    return TEST_USER.id


def test_stt_quota_exhausted_closes_4029(client, jwt_svc, usage_repo):
    # burn the whole free quota first
    import anyio
    anyio.from_thread  # noqa: B018 — ensure anyio present
    token = jwt_svc.issue(id_for(), "+10000000000").access_token
    # pre-seed exhausted usage synchronously via the repo's event list
    usage_repo._events.append({
        "user_id": id_for(), "kind": "stt", "model": "stt-default",
        "input_tokens": 0, "output_tokens": 0, "audio_seconds": 0, "credits": 1000,
        "created_at": "1970-01-01T00:00:00+00:00",
    })
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect(f"/llm/stt?token={token}") as ws:
            ws.receive_text()
    assert ei.value.code == 4029
```

> 说明:`usage_repo` 与 `user_repo_with_test_user` 是不同 repo——usage 用 `usage_repo`(meter 走它),user 用 seed 了 TEST_USER 的那个。token 用真实 `jwt_svc` 签发,WS 鉴权用被覆盖的 `get_user_repo`(含 TEST_USER)+ `get_jwt_service`。配额预置直接塞 `usage_repo._events`(InMemory 内部结构)以保证同步。

- [ ] **Step 2: 跑,预期失败**

Run: `uv run pytest tests/test_stt_router.py -v`
Expected: FAIL（404 / 找不到 WS 路由）

- [ ] **Step 3: 写 router**

```python
# backend/src/app/routers/stt.py
"""Metered STT gateway: WS /llm/stt. Auth (JWT query param) → quota → reverse-proxy Deepgram."""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Annotated

import jwt as pyjwt
from fastapi import APIRouter, Depends, WebSocket

from ..deps import get_jwt_service, get_stt_upstream, get_usage_meter, get_user_repo
from ..services.jwt_service import JwtService
from ..services.llm_types import Usage
from ..services.model_catalog import CATALOG
from ..services.stt_relay import DeepgramUpstream, audio_seconds_for
from ..services.usage_meter import UsageMeter
from ..services.user_repo import User, UserRepo

logger = logging.getLogger(__name__)
router = APIRouter(tags=["stt"])

STT_SPEC_ID = "stt-default"
QUOTA_RECHECK_SECONDS = 30.0


async def _authenticate(websocket: WebSocket, jwt_svc: JwtService, repo: UserRepo) -> User | None:
    token = websocket.query_params.get("token")
    if not token:
        return None
    try:
        payload = jwt_svc.verify(token, expected_type="access")
    except pyjwt.PyJWTError:
        return None
    return await repo.get_by_id(payload["sub"])


@router.websocket("/llm/stt")
async def llm_stt(
    websocket: WebSocket,
    jwt_svc: Annotated[JwtService, Depends(get_jwt_service)],
    repo: Annotated[UserRepo, Depends(get_user_repo)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
    upstream_factory: Annotated[DeepgramUpstream, Depends(get_stt_upstream)],
) -> None:
    await websocket.accept()
    user = await _authenticate(websocket, jwt_svc, repo)
    if user is None:
        await websocket.close(code=4401)
        return
    if (await meter.status(user.id)).exhausted:
        await websocket.close(code=4029)
        return

    qp = websocket.query_params
    sample_rate = int(qp.get("sample_rate", "16000"))
    channels = int(qp.get("channels", "1"))
    params = {
        "encoding": qp.get("encoding", "linear16"),
        "sample_rate": str(sample_rate),
        "channels": str(channels),
        "model": qp.get("model", "nova-2"),
        "interim_results": qp.get("interim_results", "true"),
    }
    if qp.get("language"):
        params["language"] = qp["language"]

    upstream = await upstream_factory.connect(params)
    spec = CATALOG[STT_SPEC_ID]
    total_bytes = 0
    last_checked = 0.0

    async def pump_up() -> None:
        nonlocal total_bytes, last_checked
        with contextlib.suppress(Exception):
            while True:
                data = await websocket.receive_bytes()
                total_bytes += len(data)
                await upstream.send(data)
                secs = audio_seconds_for(total_bytes, sample_rate, channels)
                if secs - last_checked >= QUOTA_RECHECK_SECONDS:
                    last_checked = secs
                    if (await meter.status(user.id)).exhausted:
                        await websocket.close(code=4029)
                        return

    async def pump_down() -> None:
        with contextlib.suppress(Exception):
            async for transcript in upstream:
                await websocket.send_text(transcript)

    up_task = asyncio.create_task(pump_up())
    down_task = asyncio.create_task(pump_down())
    try:
        await asyncio.wait({up_task, down_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (up_task, down_task):
            t.cancel()
        with contextlib.suppress(Exception):
            await upstream.close()
        secs = audio_seconds_for(total_bytes, sample_rate, channels)
        if secs > 0:
            await meter.record(user.id, kind="stt", spec=spec, usage=Usage(), audio_seconds=secs)
        with contextlib.suppress(Exception):
            await websocket.close()
```

- [ ] **Step 4: main.py 注册**

`backend/src/app/main.py`:import 行 `from .routers import auth, embeddings, health, llm, meetings, modes, profile, stt, user_kv`;并加 `app.include_router(stt.router)`。

- [ ] **Step 5: 跑,预期通过**

Run: `uv run pytest tests/test_stt_router.py -v`
Expected: PASS（4 passed）

> 若 `test_stt_relays_transcripts_and_meters` 因 close/record 竞态偶发失败:已有 50×20ms 轮询;若仍不稳,把发送音频改到 `receive_text()` 之前。

- [ ] **Step 6: 提交**

```bash
git add backend/src/app/routers/stt.py backend/src/app/main.py backend/tests/test_stt_router.py
git commit -m "feat(stt): add WS /llm/stt reverse-proxy with auth, quota and metering"
```

---

## Task 5: 全量回归 + lint

**Files:** 无（验证）

- [ ] **Step 1: 全部后端测试**

Run: `uv run pytest -q`
Expected: 全绿(约 42 passed)

- [ ] **Step 2: ruff（改动文件）**

Run: `uv run ruff check src/app/services/stt_relay.py src/app/services/model_catalog.py src/app/services/usage_meter.py src/app/routers/stt.py tests/test_stt_relay.py tests/test_stt_router.py tests/test_model_catalog.py tests/test_usage_meter.py`
Expected: All checks passed（E501 自行折行修复后重跑）

- [ ] **Step 3: import 冒烟**

Run: `PYTHONPATH=src uv run python -c "from app.main import app; print([r.path for r in app.routes if 'stt' in getattr(r,'path','')])"`
Expected: 含 `/llm/stt`

- [ ] **Step 4: 提交（如 ruff 有改动）**

```bash
git add -A backend && git commit -m "chore(stt): phase-3a backend regression green"
```

---

## Task 6: 联机冒烟（有 DEEPGRAM_API_KEY）

**Files:** 无（验证）

- [ ] **Step 1: 确认 key**

Run: `grep -E '^DEEPGRAM_API_KEY=.' backend/.env && echo present || echo MISSING`
Expected: `present`

- [ ] **Step 2: 起后端,用 Python WS 客户端送 1 秒静音,收转写**

```bash
cd backend
uv run uvicorn app.main:app --app-dir src --port 8000 &
until curl -sf http://localhost:8000/health >/dev/null; do sleep 0.5; done
TOKEN=$(PYTHONPATH=src uv run python -c "from app.config import get_settings as g; from app.services.jwt_service import JwtService as J; s=g(); print(J(secret=s.jwt_secret,algorithm=s.jwt_algorithm,access_ttl=s.jwt_access_ttl_seconds,refresh_ttl=s.jwt_refresh_ttl_seconds).issue('f4e48046-3c71-438d-811e-2eeb5c1572af','13800138001').access_token)")
PYTHONPATH=src uv run python - <<PY
import asyncio, websockets
async def main():
    url = f"ws://localhost:8000/llm/stt?token=$TOKEN&sample_rate=16000&channels=1"
    async with websockets.connect(url) as ws:
        await ws.send(b"\x00" * 32000)  # 1s silence
        await asyncio.sleep(1.0)
        print("connected + sent 1s audio OK")
asyncio.run(main())
PY
kill %1
```
Expected: 连接成功、不被立刻 4401/4029 关闭(静音可能无转写,属正常);后端日志显示连上 `wss://api.deepgram.com`。

- [ ] **Step 3: 确认计量**

Supabase 查 `select kind, audio_seconds, credits from usage_events where kind='stt' order by created_at desc limit 3;`
Expected: 有 `stt` 记录,`audio_seconds≈1`、`credits>=1`。

> 注:Step 2/3 需真实 key;逻辑由 Task 4 单测(假上游)全覆盖。

---

## Self-Review（计划自查结论）

- **Spec 覆盖**:spec §3.1 STT spec + 计量 → Task 1;§3.2 stt_relay(协议+实现) → Task 2;§3.3 WS 端点(鉴权/配额/中继/音频秒/记账) → Task 4;§3.4 deps 注入 → Task 3;§3.5 依赖 websockets → Task 2;§6 测试散落各任务。客户端(§4)按声明属阶段3b,不在本 plan。
- **占位符**:无 TBD;每个代码步骤含完整代码与命令。
- **类型一致性**:`audio_seconds_for`、`build_deepgram_url`、`Upstream`/`DeepgramUpstream`、`WebsocketsDeepgramUpstream`、`get_stt_upstream`、`CATALOG["stt-default"]`、`ModelSpec.credits_per_audio_second`、`UsageMeter.record(kind="stt", …)`、关闭码(4401/4029)在定义与使用处一致。
- **回归影响**:`test_every_model_points_at_gemini` 因新增 deepgram-provider 的 stt-default 会断言失败 → Task 1 Step 1 已替换为 `test_llm_models_point_at_gemini`(只校验 openai_compat)。`/llm/models` 的 `if "text" in s.capabilities` 过滤会自动排除 stt-default(capabilities=("stt",)),无需改动且 `test_llm_router_models_quota` 仍通过。`client` fixture 新增 STT 覆盖与参数,现有用例不受影响(只增不改)。
- **已知风险**:WS close/record 竞态——测试用轮询缓解;真实 Deepgram 模型名 `nova-2` 与参数由 Task 6 联机验。
