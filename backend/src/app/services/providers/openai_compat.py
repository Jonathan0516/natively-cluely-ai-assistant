# backend/src/app/services/providers/openai_compat.py
"""OpenAI-compatible chat completions provider. One class covers Netmind / OpenAI / Groq —
they share the same /chat/completions wire format. Streaming via SSE."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

from ..llm_types import ChatDelta, ChatMessage, EmbedResult, GenResult, Usage


def _to_wire(messages: list[ChatMessage], images: list[str]) -> list[dict]:
    out: list[dict] = [{"role": m.role, "content": m.content} for m in messages]
    if images and out:
        # attach images to the last user message as multimodal content parts
        last = out[-1]
        parts = [{"type": "text", "text": last["content"]}]
        for b64 in images:
            parts.append({"type": "image_url",
                          "image_url": {"url": f"data:image/png;base64,{b64}"}})
        last["content"] = parts
    return out


class OpenAICompatProvider:
    name = "openai_compat"

    def __init__(self, http: httpx.AsyncClient, api_key: str, base_url: str):
        self._http = http
        self._key = api_key
        self._base = base_url.rstrip("/")

    @property
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._key}", "content-type": "application/json"}

    async def stream_chat(
        self, model: str, messages: list[ChatMessage], images: list[str], params: dict
    ) -> AsyncIterator[ChatDelta]:
        payload = {
            "model": model,
            "messages": _to_wire(messages, images),
            "stream": True,
            "stream_options": {"include_usage": True},
            **params,
        }
        async with self._http.stream(
            "POST", f"{self._base}/chat/completions", headers=self._headers, json=payload
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data == "[DONE]":
                    break
                obj = json.loads(data)
                choices = obj.get("choices") or []
                if choices:
                    delta = choices[0].get("delta", {}) or {}
                    text = delta.get("content") or ""
                    if text:
                        yield ChatDelta(text=text)
                usage = obj.get("usage")
                if usage:
                    yield ChatDelta(usage=Usage(
                        input_tokens=usage.get("prompt_tokens", 0),
                        output_tokens=usage.get("completion_tokens", 0),
                    ))

    async def generate_json(
        self, model: str, messages: list[ChatMessage], params: dict
    ) -> GenResult:
        payload = {
            "model": model,
            "messages": _to_wire(messages, []),
            "response_format": {"type": "json_object"},
            **params,
        }
        resp = await self._http.post(
            f"{self._base}/chat/completions", headers=self._headers, json=payload
        )
        resp.raise_for_status()
        obj = resp.json()
        text = obj["choices"][0]["message"]["content"]
        usage = obj.get("usage", {})
        return GenResult(
            text=text,
            usage=Usage(input_tokens=usage.get("prompt_tokens", 0),
                        output_tokens=usage.get("completion_tokens", 0)),
            model=model,
        )

    async def embed(
        self, model: str, texts: list[str], dimensions: int | None = None
    ) -> EmbedResult:
        payload: dict = {"model": model, "input": texts}
        if dimensions:
            payload["dimensions"] = dimensions
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
