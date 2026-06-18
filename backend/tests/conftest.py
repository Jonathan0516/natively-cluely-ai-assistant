# backend/tests/conftest.py
"""Shared fixtures for backend tests. No real network or Supabase — everything in-memory."""
import asyncio

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.deps import (
    get_current_user,
    get_jwt_service,
    get_llm_gateway,
    get_stt_upstream,
    get_usage_meter,
    get_usage_repo,
    get_user_repo,
)
from app.main import app
from app.services.jwt_service import JwtService
from app.services.llm_types import ChatDelta, EmbedResult, GenResult, Usage
from app.services.model_catalog import CATALOG, PLANS
from app.services.usage_meter import UsageMeter
from app.services.usage_repo import InMemoryUsageRepo
from app.services.user_repo import InMemoryUserRepo, User

TEST_USER = User(
    id="u-test", phone="+10000000000", created_at="2026-01-01", last_login_at="2026-01-01"
)


class FakeUpstream:
    """Fake Deepgram upstream: yields canned (already-normalized) transcripts, then stays
    open until closed by the endpoint. No network."""
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
    def __init__(self):
        self.last: FakeUpstream | None = None

    async def connect(self, params):
        self.last = FakeUpstream(['{"text": "hello world", "isFinal": true, "confidence": 0.9}'])
        return self.last


class FakeProvider:
    """Deterministic provider for gateway/router tests. No network."""
    name = "fake"

    def __init__(self, fail: bool = False):
        self.fail = fail

    async def stream_chat(self, model, messages, images, params):
        if self.fail:
            raise RuntimeError("provider down")
        for piece in ["Hello", " world"]:
            yield ChatDelta(text=piece)
        yield ChatDelta(usage=Usage(input_tokens=10, output_tokens=2))

    async def generate_json(self, model, messages, params):
        if self.fail:
            raise RuntimeError("provider down")
        return GenResult(
            text='{"ok": true}', usage=Usage(input_tokens=8, output_tokens=4), model=model
        )

    async def embed(self, model, texts, dimensions=None):
        if self.fail:
            raise RuntimeError("provider down")
        return EmbedResult(vectors=[[0.01, 0.02, 0.03]] * len(texts), dim=3,
                           usage=Usage(input_tokens=6, output_tokens=0), model=model)


@pytest.fixture
def usage_repo():
    return InMemoryUsageRepo()


@pytest.fixture
def usage_meter(usage_repo):
    return UsageMeter(usage_repo, CATALOG, PLANS)


@pytest.fixture
def fake_gateway():
    from app.services.llm_gateway import LLMGateway
    return LLMGateway(catalog=CATALOG, providers={"openai_compat": FakeProvider()})


@pytest.fixture
def fake_stt():
    return FakeDeepgram()


@pytest.fixture
def jwt_svc():
    s = get_settings()
    return JwtService(secret=s.jwt_secret, algorithm=s.jwt_algorithm,
                      access_ttl=s.jwt_access_ttl_seconds, refresh_ttl=s.jwt_refresh_ttl_seconds)


@pytest.fixture
def user_repo_with_test_user():
    repo = InMemoryUserRepo()
    repo._by_id[TEST_USER.id] = TEST_USER  # seed for WS token auth
    return repo


@pytest.fixture
def client(usage_repo, usage_meter, fake_gateway, fake_stt, user_repo_with_test_user, jwt_svc):
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[get_usage_repo] = lambda: usage_repo
    app.dependency_overrides[get_usage_meter] = lambda: usage_meter
    app.dependency_overrides[get_llm_gateway] = lambda: fake_gateway
    app.dependency_overrides[get_stt_upstream] = lambda: fake_stt
    app.dependency_overrides[get_user_repo] = lambda: user_repo_with_test_user
    app.dependency_overrides[get_jwt_service] = lambda: jwt_svc
    yield TestClient(app)
    app.dependency_overrides.clear()
