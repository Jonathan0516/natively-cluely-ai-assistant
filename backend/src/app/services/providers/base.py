from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from ..llm_types import ChatDelta, ChatMessage, GenResult


class Provider(Protocol):
    name: str

    def stream_chat(
        self, model: str, messages: list[ChatMessage], images: list[str], params: dict
    ) -> AsyncIterator[ChatDelta]: ...

    async def generate_json(
        self, model: str, messages: list[ChatMessage], params: dict
    ) -> GenResult: ...
