# backend/src/app/services/llm_types.py
"""Provider-agnostic value types shared by the gateway, meter and routers."""
from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol


@dataclass
class ChatMessage:
    role: str          # "system" | "user" | "assistant"
    content: str


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class ChatDelta:
    """One streamed piece. `usage` is set only on the final bookkeeping chunk."""
    text: str = ""
    usage: Usage | None = None


@dataclass
class GenResult:
    text: str
    usage: Usage
    model: str         # actual upstream model used


@dataclass
class QuotaStatus:
    plan: str
    period_start: str
    period_end: str
    credits_total: int
    credits_used: int

    @property
    def credits_remaining(self) -> int:
        return max(0, self.credits_total - self.credits_used)

    @property
    def exhausted(self) -> bool:
        return self.credits_used >= self.credits_total


class QuotaExceeded(Exception):
    def __init__(self, status: QuotaStatus):
        self.status = status
        super().__init__("quota exceeded")


class NoModelAvailable(Exception):
    """Raised by the gateway when no provider in the fallback chain succeeded."""


class ChatStream(Protocol):
    def __aiter__(self) -> AsyncIterator[ChatDelta]: ...
