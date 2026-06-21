# backend/src/app/services/model_catalog.py
"""Logical model catalog: maps client-facing model ids to upstream provider config,
pricing (credits) and the plan tier required to use them. Single source of truth for
both the gateway (which provider/model to call) and /llm/models (what to expose)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
GROQ_OPENAI_BASE = "https://api.groq.com/openai/v1"


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
    credits_per_audio_second: float = 0.0   # >0 only for STT models
    fallbacks: tuple[str, ...] = ()   # logical ids tried if this one fails
    latency_hint: str = ""            # human-facing expected TTFT, shown in the model picker
    # Extra fields merged into the upstream request body (caller params win on conflict).
    # Used to pin provider-specific knobs per model, e.g. disabling Gemini 3.x "thinking"
    # to cut time-to-first-token on the interactive chat path.
    extra_params: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Plan:
    id: str
    label: str
    credits_per_period: int
    period: str                   # "month" | "week"
    allowed_tiers: tuple[str, ...]


CATALOG: dict[str, ModelSpec] = {
    "answer-fast": ModelSpec(
        id="answer-fast", label="Gemini 2.5 Flash Lite", tier="free", provider="openai_compat",
        # GA model: stable ~0.6s TTFB. The 3.1-*-preview models are capacity-throttled
        # on Google's side (measured 0.7s–70s erratic), which was the real TTFT culprit.
        upstream_model="gemini-2.5-flash-lite", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json"), credits_per_1k_input=0.5, credits_per_1k_output=1.5,
        fallbacks=("answer-flash", "answer-pro"), latency_hint="~1s",
        # Disable Gemini "thinking" before the first token: the live overlay wants speed.
        extra_params={"reasoning_effort": "none"},
    ),
    "answer-flash": ModelSpec(
        id="answer-flash", label="Gemini 2.5 Flash", tier="free", provider="openai_compat",
        upstream_model="gemini-2.5-flash", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json"), credits_per_1k_input=1.0, credits_per_1k_output=3.0,
        fallbacks=("answer-fast",), latency_hint="~2s",
        extra_params={"reasoning_effort": "none"},
    ),
    "answer-pro": ModelSpec(
        id="answer-pro", label="Gemini 2.5 Pro", tier="pro", provider="openai_compat",
        upstream_model="gemini-2.5-pro", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json", "vision"),
        credits_per_1k_input=5.0, credits_per_1k_output=15.0,
        extra_params={"reasoning_effort": "none"}, latency_hint="~3–5s",
    ),
    # --- Gemini 3.x (preview): kept selectable on request; TTFT is erratic (0.7s–70s) as
    # Google throttles preview capacity, hence the "varies" hint. ---
    "gemini-31-flash": ModelSpec(
        id="gemini-31-flash", label="Gemini 3.1 Flash", tier="free", provider="openai_compat",
        upstream_model="gemini-3.1-flash-lite", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json"), credits_per_1k_input=0.5, credits_per_1k_output=1.5,
        fallbacks=("answer-fast",), latency_hint="~varies",
    ),
    "gemini-31-pro": ModelSpec(
        id="gemini-31-pro", label="Gemini 3.1 Pro", tier="pro", provider="openai_compat",
        upstream_model="gemini-3.1-pro-preview", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json", "vision"),
        credits_per_1k_input=5.0, credits_per_1k_output=15.0,
        fallbacks=("answer-pro",), latency_hint="~varies",
    ),
    # --- Groq (OpenAI-compatible). GROQ_API_KEY is configured; measured ~0.15s TTFT. ---
    "groq-llama": ModelSpec(
        id="groq-llama", label="Groq Llama 3.3", tier="free", provider="openai_compat",
        upstream_model="llama-3.3-70b-versatile", base_url=GROQ_OPENAI_BASE,
        key_env="groq_api_key",
        capabilities=("text", "json"), credits_per_1k_input=0.5, credits_per_1k_output=1.0,
        fallbacks=("answer-fast",), latency_hint="~0.2s",
    ),
    "embed-default": ModelSpec(
        id="embed-default", label="Embeddings", tier="free", provider="openai_compat",
        upstream_model="gemini-embedding-001", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("embedding",), credits_per_1k_input=0.1, credits_per_1k_output=0.0,
        embed_dim=768,
    ),
    "stt-default": ModelSpec(
        id="stt-default", label="Speech-to-Text", tier="free", provider="deepgram",
        upstream_model="nova-2", base_url="wss://api.deepgram.com/v1/listen",
        key_env="deepgram_api_key", capabilities=("stt",),
        credits_per_audio_second=0.1,
    ),
}

PLANS: dict[str, Plan] = {
    "free": Plan("free", "Free", 1000, "month", ("free",)),
    "pro": Plan("pro", "Pro", 9999, "month", ("free", "pro")),
}

DEFAULT_PLAN = "free"


def credits_for(spec: ModelSpec, input_tokens: int, output_tokens: int) -> int:
    raw = (input_tokens / 1000.0) * spec.credits_per_1k_input + (
        output_tokens / 1000.0
    ) * spec.credits_per_1k_output
    return max(1, math.ceil(raw))
