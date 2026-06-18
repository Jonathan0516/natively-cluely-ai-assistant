import pytest

from app.services.llm_gateway import LLMGateway
from app.services.llm_types import ChatDelta, ChatMessage, GenResult, NoModelAvailable, Usage
from app.services.model_catalog import CATALOG


class _OkProvider:
    name = "openai_compat"
    async def stream_chat(self, model, messages, images, params):
        yield ChatDelta(text="hi")
        yield ChatDelta(usage=Usage(input_tokens=3, output_tokens=1))
    async def generate_json(self, model, messages, params):
        return GenResult(text="{}", usage=Usage(input_tokens=3, output_tokens=1), model=model)


class _FailProvider:
    name = "openai_compat"
    async def stream_chat(self, model, messages, images, params):
        raise RuntimeError("down")
        yield  # pragma: no cover
    async def generate_json(self, model, messages, params):
        raise RuntimeError("down")


def test_resolve_returns_spec_and_provider():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    spec, prov = gw.resolve("answer-pro")
    assert spec.id == "answer-pro"
    assert prov.name == "openai_compat"


def test_resolve_unknown_model_raises():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    with pytest.raises(NoModelAvailable):
        gw.resolve("does-not-exist")


async def test_generate_json_returns_spec_used():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    spec, res = await gw.generate_json("answer-pro", [ChatMessage("user", "hi")], {})
    assert spec.id == "answer-pro"
    assert res.text == "{}"


async def test_generate_json_falls_back_on_failure():
    # answer-pro fails → its fallback answer-netmind (same provider key) is tried.
    gw = LLMGateway(CATALOG, {"openai_compat": _FailProvider()})
    with pytest.raises(NoModelAvailable):
        await gw.generate_json("answer-pro", [ChatMessage("user", "hi")], {})


async def test_stream_chat_yields_text():
    gw = LLMGateway(CATALOG, {"openai_compat": _OkProvider()})
    spec_holder = {}
    chunks = []
    async for spec, delta in gw.stream_chat("answer-pro", [ChatMessage("user", "hi")], [], {}):
        spec_holder["spec"] = spec
        chunks.append(delta)
    assert spec_holder["spec"].id == "answer-pro"
    assert any(c.text == "hi" for c in chunks)
    assert any(c.usage for c in chunks)
