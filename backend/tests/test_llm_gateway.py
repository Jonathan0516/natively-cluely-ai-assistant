import pytest

from app.services.llm_gateway import LLMGateway
from app.services.llm_types import (
    ChatDelta,
    ChatMessage,
    EmbedResult,
    GenResult,
    NoModelAvailable,
    Usage,
)
from app.services.model_catalog import CATALOG


class _OkProvider:
    name = "openai_compat"
    async def stream_chat(self, model, messages, images, params):
        yield ChatDelta(text="hi")
        yield ChatDelta(usage=Usage(input_tokens=3, output_tokens=1))
    async def generate_json(self, model, messages, params):
        return GenResult(text="{}", usage=Usage(input_tokens=3, output_tokens=1), model=model)
    async def embed(self, model, texts, dimensions=None):
        return EmbedResult(vectors=[[0.1, 0.2]] * len(texts), dim=2,
                           usage=Usage(input_tokens=5, output_tokens=0), model=model)


class _FailProvider:
    name = "openai_compat"
    async def stream_chat(self, model, messages, images, params):
        raise RuntimeError("down")
        yield  # pragma: no cover
    async def generate_json(self, model, messages, params):
        raise RuntimeError("down")
    async def embed(self, model, texts):
        raise RuntimeError("down")


def test_resolve_returns_spec_and_provider():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    spec, prov = gw.resolve("gemini-2.5-pro")
    assert spec.id == "gemini-2.5-pro"
    assert prov.name == "openai_compat"


def test_resolve_unknown_model_raises():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    with pytest.raises(NoModelAvailable):
        gw.resolve("does-not-exist")


async def test_generate_json_returns_spec_used():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    spec, res = await gw.generate_json("gemini-2.5-pro", [ChatMessage("user", "hi")], {})
    assert spec.id == "gemini-2.5-pro"
    assert res.text == "{}"


async def test_generate_json_falls_back_on_failure():
    # gemini-2.5-pro fails and has no fallback chain → the gateway surfaces NoModelAvailable.
    gw = LLMGateway(CATALOG, {"openai_compat": _FailProvider()})
    with pytest.raises(NoModelAvailable):
        await gw.generate_json("gemini-2.5-pro", [ChatMessage("user", "hi")], {})


async def test_stream_chat_yields_text():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    spec_holder = {}
    chunks = []
    async for spec, delta in gw.stream_chat("gemini-2.5-pro", [ChatMessage("user", "hi")], [], {}):
        spec_holder["spec"] = spec
        chunks.append(delta)
    assert spec_holder["spec"].id == "gemini-2.5-pro"
    assert any(c.text == "hi" for c in chunks)
    assert any(c.usage for c in chunks)


async def test_embed_returns_spec_and_vectors():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    spec, res = await gw.embed("embed-default", ["hello", "world"])
    assert spec.id == "embed-default"
    assert spec.upstream_model == "gemini-embedding-001"
    assert res.dim == 2 and len(res.vectors) == 2


async def test_embed_unknown_model_raises():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    with pytest.raises(NoModelAvailable):
        await gw.embed("nope", ["x"])


async def test_embed_provider_failure_raises_no_model_available():
    # A provider/upstream failure must surface as NoModelAvailable (→ router 400), not bubble up.
    gw = LLMGateway(CATALOG, {"openai_compat": _FailProvider()})
    with pytest.raises(NoModelAvailable):
        await gw.embed("embed-default", ["x"])
