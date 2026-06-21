# backend/src/app/services/providers/openai_compat.py
"""OpenAI-compatible chat completions provider. One class covers Netmind / OpenAI / Groq —
they share the same /chat/completions wire format. Streaming via SSE."""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator

import httpx

from ..llm_types import ChatDelta, ChatMessage, EmbedResult, GenResult, Usage

logger = logging.getLogger(__name__)


def _to_wire(messages: list[ChatMessage], images: list[str]) -> list[dict]:
    out: list[dict] = [{"role": m.role, "content": m.content} for m in messages]
    if images and out:
        # attach images to the last user message as multimodal content parts
        last = out[-1]
        parts = [{"type": "text", "text": last["content"]}]
        for img in images:
            # The client sends a full data URL ("data:image/jpeg;base64,...") so the
            # real mime type survives. Tolerate a bare base64 string for back-compat.
            url = img if img.startswith("data:") else f"data:image/png;base64,{img}"
            parts.append({"type": "image_url", "image_url": {"url": url}})
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
        # DIAGNOSTIC: confirm what we actually send (reasoning knob) + prompt size, so we can
        # tell "model is thinking" from "prompt is huge" in the TTFT breakdown.
        prompt_chars = sum(len(m.content or "") for m in messages)
        logger.info(
            "gemini req model=%s reasoning_effort=%s prompt_chars=%d msgs=%d images=%d",
            model, params.get("reasoning_effort"), prompt_chars, len(messages), len(images),
        )
        async with self._http.stream(
            "POST", f"{self._base}/chat/completions", headers=self._headers, json=payload
        ) as resp:
            if resp.status_code >= 400:
                # raise_for_status() would hide the upstream body, which is the only thing
                # that says *why* (bad field, empty content, unsupported image, ...).
                body = (await resp.aread()).decode("utf-8", "replace")
                raise httpx.HTTPStatusError(
                    f"{resp.status_code} from {self.name} ({model}): {body[:2000]}",
                    request=resp.request,
                    response=resp,
                )
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
                    # DIAGNOSTIC: full usage incl. completion_tokens_details.reasoning_tokens —
                    # if reasoning_tokens > 0 despite reasoning_effort=none, the knob is ignored.
                    logger.info("gemini usage model=%s %s", model, usage)
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
