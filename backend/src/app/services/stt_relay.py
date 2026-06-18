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
