# backend/src/app/services/model_catalog.py
"""Logical model catalog: maps client-facing model ids to upstream provider config,
pricing (credits) and the plan tier required to use them. Single source of truth for
both the gateway (which provider/model to call) and /llm/models (what to expose)."""
from __future__ import annotations

import math
from dataclasses import dataclass

NETMIND_BASE = "https://api.netmind.ai/inference-api/openai/v1"
OPENAI_BASE = "https://api.openai.com/v1"
GROQ_BASE = "https://api.groq.com/openai/v1"


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
        upstream_model="llama-3.3-70b-versatile", base_url=GROQ_BASE, key_env="groq_api_key",
        capabilities=("text", "json"), credits_per_1k_input=0.5, credits_per_1k_output=1.5,
        fallbacks=("answer-pro",),
    ),
    "answer-pro": ModelSpec(
        id="answer-pro", label="Pro", tier="pro", provider="openai_compat",
        upstream_model="gpt-4o", base_url=OPENAI_BASE, key_env="openai_api_key",
        capabilities=("text", "json", "vision"), credits_per_1k_input=5.0, credits_per_1k_output=15.0,
        fallbacks=("answer-netmind",),
    ),
    "answer-netmind": ModelSpec(
        id="answer-netmind", label="Netmind", tier="pro", provider="openai_compat",
        upstream_model="deepseek-ai/DeepSeek-V3", base_url=NETMIND_BASE, key_env="netmind_api_key",
        capabilities=("text", "json"), credits_per_1k_input=1.0, credits_per_1k_output=2.0,
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
