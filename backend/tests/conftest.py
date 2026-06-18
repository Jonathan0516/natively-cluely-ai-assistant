# backend/tests/conftest.py
"""Shared fixtures for backend tests. No real network or Supabase — everything in-memory."""
import pytest
from fastapi.testclient import TestClient

from app.deps import get_current_user, get_llm_gateway, get_usage_meter, get_usage_repo
from app.main import app
from app.services.llm_types import ChatDelta, EmbedResult, GenResult, Usage
from app.services.model_catalog import CATALOG, PLANS
from app.services.usage_meter import UsageMeter
from app.services.usage_repo import InMemoryUsageRepo
from app.services.user_repo import User

TEST_USER = User(
    id="u-test", phone="+10000000000", created_at="2026-01-01", last_login_at="2026-01-01"
)


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

    async def embed(self, model, texts):
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
def client(usage_repo, usage_meter, fake_gateway):
    app.dependency_overrides[get_current_user] = lambda: TEST_USER
    app.dependency_overrides[get_usage_repo] = lambda: usage_repo
    app.dependency_overrides[get_usage_meter] = lambda: usage_meter
    app.dependency_overrides[get_llm_gateway] = lambda: fake_gateway
    yield TestClient(app)
    app.dependency_overrides.clear()
