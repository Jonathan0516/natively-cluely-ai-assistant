# backend/src/app/services/model_catalog.py
"""Logical model catalog: maps client-facing model ids to upstream provider config,
pricing (credits) and the plan tier required to use them. Single source of truth for
both the gateway (which provider/model to call) and /llm/models (what to expose)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
GROQ_OPENAI_BASE = "https://api.groq.com/openai/v1"
NETMIND_OPENAI_BASE = "https://api.netmind.ai/inference-api/openai/v1"


@dataclass(frozen=True)
class ModelSpec:
    id: str                       # logical id, e.g. "gemini-2.5-pro"
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
    # How this model's "thinking" is controlled, so the client toggle can adapt per model:
    #   "graded" — Gemini: reasoning_effort none|low|high (3-state button)
    #   "binary" — Netmind DeepSeek/MiMo: thinking on/off (2-state button)
    #   "none"   — no reasoning knob (button hidden). The gateway translates the generic
    #              client `reasoning_effort` into the right per-provider field; see
    #              apply_reasoning_param().
    reasoning_style: str = "none"
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
    "gemini-2.5-flash-lite": ModelSpec(
        id="gemini-2.5-flash-lite", label="Gemini 2.5 Flash Lite", tier="free", provider="openai_compat",
        # GA model: stable ~0.6s TTFB. The 3.1-*-preview models are capacity-throttled
        # on Google's side (measured 0.7s–70s erratic), which was the real TTFT culprit.
        upstream_model="gemini-2.5-flash-lite", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json"), credits_per_1k_input=50.0, credits_per_1k_output=150.0,
        fallbacks=("gemini-2.5-flash", "gemini-2.5-pro"), latency_hint="~1s", reasoning_style="graded",
        # Disable Gemini "thinking" before the first token: the live overlay wants speed.
        extra_params={"reasoning_effort": "none"},
    ),
    "gemini-2.5-flash": ModelSpec(
        id="gemini-2.5-flash", label="Gemini 2.5 Flash", tier="free", provider="openai_compat",
        upstream_model="gemini-2.5-flash", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json"), credits_per_1k_input=100.0, credits_per_1k_output=300.0,
        fallbacks=("gemini-2.5-flash-lite",), latency_hint="~2s", reasoning_style="graded",
        extra_params={"reasoning_effort": "none"},
    ),
    "gemini-2.5-pro": ModelSpec(
        id="gemini-2.5-pro", label="Gemini 2.5 Pro", tier="pro", provider="openai_compat",
        upstream_model="gemini-2.5-pro", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json", "vision"),
        credits_per_1k_input=500.0, credits_per_1k_output=1500.0,
        extra_params={"reasoning_effort": "none"}, latency_hint="~3–5s",
        reasoning_style="graded",
    ),
    # --- Gemini 3.x (preview): kept selectable on request; TTFT is erratic (0.7s–70s) as
    # Google throttles preview capacity, hence the "varies" hint. ---
    "gemini-31-flash": ModelSpec(
        id="gemini-31-flash", label="Gemini 3.1 Flash", tier="free", provider="openai_compat",
        upstream_model="gemini-3.1-flash-lite", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json"), credits_per_1k_input=50.0, credits_per_1k_output=150.0,
        fallbacks=("gemini-2.5-flash-lite",), latency_hint="~varies", reasoning_style="graded",
    ),
    "gemini-31-pro": ModelSpec(
        id="gemini-31-pro", label="Gemini 3.1 Pro", tier="pro", provider="openai_compat",
        upstream_model="gemini-3.1-pro-preview", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("text", "json", "vision"),
        credits_per_1k_input=500.0, credits_per_1k_output=1500.0,
        fallbacks=("gemini-2.5-pro",), latency_hint="~varies", reasoning_style="graded",
    ),
    # --- Groq (OpenAI-compatible). GROQ_API_KEY is configured; measured ~0.15s TTFT. ---
    "groq-llama": ModelSpec(
        id="groq-llama", label="Groq Llama 3.3", tier="free", provider="openai_compat",
        upstream_model="llama-3.3-70b-versatile", base_url=GROQ_OPENAI_BASE,
        key_env="groq_api_key",
        capabilities=("text", "json"), credits_per_1k_input=50.0, credits_per_1k_output=100.0,
        fallbacks=("gemini-2.5-flash-lite",), latency_hint="~0.2s",
    ),
    # --- Netmind (OpenAI-compatible). NETMIND_API_KEY held by the platform; the gateway's
    # _OpenAICompatRouter dispatches by base_url+key per upstream model, so no router change
    # is needed. These are *additional* selectable options — Gemini stays the default; each
    # carries a Gemini fallback so a Netmind outage degrades gracefully rather than erroring. ---
    # Netmind credits are cost-recovery at 2× Netmind's listed PAYG price (not a profit
    # center): credits_per_1k = usd_per_1M_tokens * 2 * 7.2(FX) / 1000 * 100 = usd_per_1M * 1.44,
    # with 1 credit == ¥0.01 (100 credits per CNY). Source: https://www.netmind.ai/pricing
    "deepseek-v4-pro": ModelSpec(
        id="deepseek-v4-pro", label="DeepSeek V4 Pro", tier="pro", provider="openai_compat",
        upstream_model="deepseek-ai/DeepSeek-V4-Pro", base_url=NETMIND_OPENAI_BASE,
        key_env="netmind_api_key",
        # Netmind: $0.435 in / $0.87 out per 1M
        capabilities=("text", "json"), credits_per_1k_input=0.626, credits_per_1k_output=1.253,
        fallbacks=("gemini-2.5-pro",), latency_hint="~1.7s", reasoning_style="binary",
    ),
    "deepseek-v4-flash": ModelSpec(
        id="deepseek-v4-flash", label="DeepSeek V4 Flash", tier="free", provider="openai_compat",
        upstream_model="deepseek-ai/DeepSeek-V4-Flash", base_url=NETMIND_OPENAI_BASE,
        key_env="netmind_api_key",
        # Netmind: $0.14 in / $0.28 out per 1M
        capabilities=("text", "json"), credits_per_1k_input=0.202, credits_per_1k_output=0.403,
        fallbacks=("gemini-2.5-flash-lite",), latency_hint="~1.5s", reasoning_style="binary",
    ),
    "mimo-v25": ModelSpec(
        id="mimo-v25", label="MiMo V2.5", tier="free", provider="openai_compat",
        upstream_model="XiaomiMiMo/MiMo-V2.5", base_url=NETMIND_OPENAI_BASE,
        key_env="netmind_api_key",
        # Netmind: $0.14 in / $0.28 out per 1M
        capabilities=("text", "json"), credits_per_1k_input=0.202, credits_per_1k_output=0.403,
        fallbacks=("gemini-2.5-flash-lite",), latency_hint="~2.5s", reasoning_style="binary",
    ),
    "mimo-v25-pro": ModelSpec(
        id="mimo-v25-pro", label="MiMo V2.5 Pro", tier="pro", provider="openai_compat",
        upstream_model="XiaomiMiMo/MiMo-V2.5-Pro", base_url=NETMIND_OPENAI_BASE,
        key_env="netmind_api_key",
        # Netmind: $0.435 in / $0.87 out per 1M
        capabilities=("text", "json"), credits_per_1k_input=0.626, credits_per_1k_output=1.253,
        fallbacks=("gemini-2.5-pro",), latency_hint="~2.5s", reasoning_style="binary",
    ),
    "embed-default": ModelSpec(
        id="embed-default", label="Embeddings", tier="free", provider="openai_compat",
        upstream_model="gemini-embedding-001", base_url=GEMINI_OPENAI_BASE,
        key_env="gemini_api_key",
        capabilities=("embedding",), credits_per_1k_input=10.0, credits_per_1k_output=0.0,
        embed_dim=768,
    ),
    # Netmind embedding option (additional only — NOT the default). NV-Embed-v2 emits 4096d,
    # which is incompatible with the existing 768d corpus under pgvector's `<=>` (dimensions
    # must match), so switching embed-default here would require re-embedding all stored
    # vectors. Kept selectable for new/separate corpora; embed-default stays Gemini @768d.
    "embed-netmind": ModelSpec(
        id="embed-netmind", label="Embeddings (Netmind NV-Embed v2)", tier="free",
        provider="openai_compat", upstream_model="nvidia/NV-Embed-v2",
        base_url=NETMIND_OPENAI_BASE, key_env="netmind_api_key",
        capabilities=("embedding",), credits_per_1k_input=10.0, credits_per_1k_output=0.0,
        embed_dim=4096,
    ),
    "stt-default": ModelSpec(
        id="stt-default", label="Speech-to-Text", tier="free", provider="deepgram",
        upstream_model="nova-2", base_url="wss://api.deepgram.com/v1/listen",
        key_env="deepgram_api_key", capabilities=("stt",),
        # Cost-recovery only (not a profit center): charge 2× Deepgram's actual price.
        # Deepgram Nova realtime/streaming PAYG = $0.0077/min; 1 credit == ¥0.01; FX 7.2.
        #   (0.0077 * 2 * 7.2) / 60 * 100 ≈ 0.1848 credits/audio-second  (≈ 666 credits/hour)
        credits_per_audio_second=0.185,
    ),
}

PLANS: dict[str, Plan] = {
    # Both tiers are unlocked on every plan for now: pro-tier models (Gemini 2.5 Pro, 3.1 Pro,
    # DeepSeek V4 Pro) are selectable and callable regardless of plan. Re-narrow free's
    # allowed_tiers to ("free",) to reinstate the pro paywall.
    # The wallet (persistent purchased credits) is now the sole credit source: both plans get
    # a 0 free allowance.
    "free": Plan("free", "Free", 0, "month", ("free", "pro")),
    "pro": Plan("pro", "Pro", 0, "month", ("free", "pro")),
}

DEFAULT_PLAN = "free"


def credits_for(spec: ModelSpec, input_tokens: int, output_tokens: int) -> int:
    raw = (input_tokens / 1000.0) * spec.credits_per_1k_input + (
        output_tokens / 1000.0
    ) * spec.credits_per_1k_output
    return max(1, math.ceil(raw))


def apply_reasoning_param(spec: ModelSpec, params: dict) -> dict:
    """Translate the client's generic `reasoning_effort` toggle into the per-provider
    thinking knob for `spec`, returning a new params dict. The client always sends one
    vocabulary (none|low|high); each provider expects a different field:

    - "graded" (Gemini): pass `reasoning_effort` (none|low|high) through unchanged.
    - "binary" (Netmind DeepSeek/MiMo): the model has no graded control and 400s on
      `reasoning_effort`, so always drop it; `none` → `thinking={"type":"disabled"}` (off),
      any other value (low|high, the button's "on") → leave thinking unset so the model reasons.
    - "none" (e.g. Groq Llama): no reasoning knob at all — just drop `reasoning_effort`.

    Missing/`none` effort on a binary model defaults to thinking OFF (the live overlay wants
    the lowest TTFT), matching the Gemini default of reasoning_effort="none".
    """
    p = dict(params)
    effort = p.pop("reasoning_effort", None)
    if spec.reasoning_style == "graded":
        if effort is not None:
            p["reasoning_effort"] = effort
    elif spec.reasoning_style == "binary":
        if effort in (None, "none"):
            p["thinking"] = {"type": "disabled"}
        # else: reasoning ON — omit the knob entirely
    # "none": nothing to add; `reasoning_effort` already stripped.
    return p
