import json

import httpx
import pytest

from app.services.llm_types import ChatMessage
from app.services.providers.openai_compat import OpenAICompatProvider


def _sse(lines: list[str]) -> bytes:
    return ("".join(f"data: {ln}\n\n" for ln in lines)).encode()


def _make_client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_stream_chat_yields_deltas_and_usage():
    def handler(req: httpx.Request) -> httpx.Response:
        body = _sse([
            json.dumps({"choices": [{"delta": {"content": "Hel"}}]}),
            json.dumps({"choices": [{"delta": {"content": "lo"}}]}),
            json.dumps({
                "choices": [{"delta": {}}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 2},
            }),
            "[DONE]",
        ])
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    prov = OpenAICompatProvider(http=_make_client(handler), api_key="k", base_url="https://x/v1")
    texts, usage = [], None
    async for d in prov.stream_chat("m", [ChatMessage("user", "hi")], [], {}):
        if d.text:
            texts.append(d.text)
        if d.usage:
            usage = d.usage
    assert "".join(texts) == "Hello"
    assert usage.input_tokens == 7 and usage.output_tokens == 2


async def test_generate_json_returns_text_and_usage():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "{\"ok\": true}"}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3},
        })

    prov = OpenAICompatProvider(http=_make_client(handler), api_key="k", base_url="https://x/v1")
    res = await prov.generate_json("m", [ChatMessage("user", "hi")], {})
    assert res.text == '{"ok": true}'
    assert res.usage.input_tokens == 5 and res.usage.output_tokens == 3


async def test_upstream_error_raises():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"})

    prov = OpenAICompatProvider(http=_make_client(handler), api_key="k", base_url="https://x/v1")
    with pytest.raises(httpx.HTTPStatusError):
        await prov.generate_json("m", [ChatMessage("user", "hi")], {})


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
