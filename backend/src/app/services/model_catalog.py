# backend/src/app/services/model_catalog.py
"""Logical model catalog: maps client-facing model ids to upstream provider config,
pricing (credits) and the plan tier required to use them. Single source of truth for
both the gateway (which provider/model to call) and /llm/models (what to expose)."""
from __future__ import annotations

import math
from dataclasses import dataclass

GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"


@dataclass(frozen=True)
class ModelSpec:
    id: str                       # logical id, e.g. "answer-pro"
    label: str
    tier: str                     # "free" | "pro"
    provider: str                 # "openai_compat"
    upstream_model: str           # actual model name sent upstream
    base_url: str
    key_env: str                  # settings attribute holding the platform key
    capabilities: tuple[str, ...] = ("text", "json")
    credits_per_1k_input: float = 1.0
    credits_per_1k_output: float = 3.0
    embed_dim: int = 0            # >0 only for embedding models
    fallbacks: tuple[str, ...] = ()   # logical ids tried if this one fails


@dataclass(frozen=True)
class Plan:
    id: str
    label: str
    credits_per_period: int
    period: str                   # "month" | "week"
    allowed_tiers: tuple[str, ...]


CATALOG: dict[str, ModelSpec] = {
    "answer-fast": ModelSpec(
        id="answer-fast", label="Fast", tier="free", provider="openai_compat",
        upstream_model="gemini-3.1-flash-lite", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json"), credits_per_1k_input=0.5, credits_per_1k_output=1.5,
        fallbacks=("answer-pro",),
    ),
    "answer-pro": ModelSpec(
        id="answer-pro", label="Pro", tier="pro", provider="openai_compat",
        upstream_model="gemini-3.1-pro-preview", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json", "vision"),
        credits_per_1k_input=5.0, credits_per_1k_output=15.0,
    ),
    "embed-default": ModelSpec(
        id="embed-default", label="Embeddings", tier="free", provider="openai_compat",
        upstream_model="gemini-embedding-001", base_url=GEMINI_OPENAI_BASE, key_env="gemini_api_key",
        capabilities=("embedding",), credits_per_1k_input=0.1, credits_per_1k_output=0.0,
        embed_dim=768,
    ),
}

PLANS: dict[str, Plan] = {
    "free": Plan("free", "Free", 1000, "month", ("free",)),
    "pro": Plan("pro", "Pro", 100000, "month", ("free", "pro")),
}

DEFAULT_PLAN = "free"


def credits_for(spec: ModelSpec, input_tokens: int, output_tokens: int) -> int:
    raw = (input_tokens / 1000.0) * spec.credits_per_1k_input + (
        output_tokens / 1000.0
    ) * spec.credits_per_1k_output
    return max(1, math.ceil(raw))
