from app.services.model_catalog import CATALOG, PLANS, apply_reasoning_param, credits_for


def test_catalog_has_free_and_pro_models():
    tiers = {m.tier for m in CATALOG.values()}
    assert "free" in tiers and "pro" in tiers


def test_openai_compat_models_have_consistent_base_and_key():
    # Each OpenAI-compatible model must pair its base_url with the matching key_env so the
    # gateway router picks the right credential. Gemini + Groq + Netmind are supported.
    expected = {
        "https://generativelanguage.googleapis.com": "gemini_api_key",
        "https://api.groq.com": "groq_api_key",
        "https://api.netmind.ai": "netmind_api_key",
    }
    for m in CATALOG.values():
        if m.provider != "openai_compat":
            continue
        match = next((k for p, k in expected.items() if m.base_url.startswith(p)), None)
        assert match is not None, f"{m.id}: unknown base_url {m.base_url}"
        assert m.key_env == match, f"{m.id}: key_env {m.key_env} != {match}"


def test_stt_model_present():
    spec = CATALOG["stt-default"]
    assert spec.provider == "deepgram"
    assert spec.capabilities == ("stt",)
    assert spec.key_env == "deepgram_api_key"
    assert spec.credits_per_audio_second > 0


def test_chat_models_use_gemini_ga():
    # GA models: the 3.1-*-preview models were capacity-throttled (erratic 0.7s–70s TTFB).
    assert CATALOG["gemini-2.5-flash-lite"].upstream_model == "gemini-2.5-flash-lite"
    assert CATALOG["gemini-2.5-pro"].upstream_model == "gemini-2.5-pro"
    assert "answer-netmind" not in CATALOG


def test_embedding_model_present_768d():
    spec = CATALOG["embed-default"]
    assert spec.capabilities == ("embedding",)
    assert spec.embed_dim == 768
    assert spec.upstream_model == "gemini-embedding-001"


def test_netmind_models_are_additional_options():
    # Netmind chat models are additional selectable options; Gemini stays the default
    # (gemini-2.5-flash-lite/gemini-2.5-pro), and each Netmind model carries a Gemini fallback.
    for cid, upstream in {
        "deepseek-v4-pro": "deepseek-ai/DeepSeek-V4-Pro",
        "deepseek-v4-flash": "deepseek-ai/DeepSeek-V4-Flash",
        "mimo-v25": "XiaomiMiMo/MiMo-V2.5",
        "mimo-v25-pro": "XiaomiMiMo/MiMo-V2.5-Pro",
    }.items():
        spec = CATALOG[cid]
        assert spec.upstream_model == upstream
        assert spec.key_env == "netmind_api_key"
        assert spec.base_url.startswith("https://api.netmind.ai")
        assert "text" in spec.capabilities
        assert spec.fallbacks  # degrades to Gemini on a Netmind outage


def test_netmind_embedding_is_optional_not_default():
    # embed-default must remain Gemini @768d (existing corpus); NV-Embed-v2 is 4096d and
    # only added as a separate selectable option.
    assert CATALOG["embed-default"].upstream_model == "gemini-embedding-001"
    spec = CATALOG["embed-netmind"]
    assert spec.upstream_model == "nvidia/NV-Embed-v2"
    assert spec.embed_dim == 4096
    assert spec.capabilities == ("embedding",)


def test_reasoning_style_classification():
    # Gemini = graded (none/low/high), Netmind reasoners = binary (on/off), Groq = none.
    assert CATALOG["gemini-2.5-pro"].reasoning_style == "graded"
    assert CATALOG["gemini-31-pro"].reasoning_style == "graded"
    assert CATALOG["deepseek-v4-pro"].reasoning_style == "binary"
    assert CATALOG["deepseek-v4-flash"].reasoning_style == "binary"
    assert CATALOG["mimo-v25"].reasoning_style == "binary"
    assert CATALOG["mimo-v25-pro"].reasoning_style == "binary"
    assert CATALOG["groq-llama"].reasoning_style == "none"


def test_apply_reasoning_graded_passes_effort_through():
    spec = CATALOG["gemini-2.5-pro"]
    assert apply_reasoning_param(spec, {"reasoning_effort": "high"}) == {"reasoning_effort": "high"}
    assert apply_reasoning_param(spec, {"reasoning_effort": "none"}) == {"reasoning_effort": "none"}


def test_apply_reasoning_binary_off_sets_thinking_disabled():
    spec = CATALOG["deepseek-v4-flash"]
    # "none"/missing → thinking off, and reasoning_effort never leaks upstream (Netmind 400s on it)
    assert apply_reasoning_param(spec, {"reasoning_effort": "none"}) == {"thinking": {"type": "disabled"}}
    assert apply_reasoning_param(spec, {}) == {"thinking": {"type": "disabled"}}


def test_apply_reasoning_binary_on_omits_knob():
    spec = CATALOG["deepseek-v4-flash"]
    # button "on" (low/high) → reasoning enabled: no thinking field, no reasoning_effort
    assert apply_reasoning_param(spec, {"reasoning_effort": "high"}) == {}
    assert apply_reasoning_param(spec, {"reasoning_effort": "low"}) == {}


def test_apply_reasoning_none_strips_effort():
    spec = CATALOG["groq-llama"]
    assert apply_reasoning_param(spec, {"reasoning_effort": "high", "temperature": 0.5}) == {"temperature": 0.5}


def test_apply_reasoning_preserves_other_params():
    spec = CATALOG["gemini-2.5-pro"]
    out = apply_reasoning_param(spec, {"reasoning_effort": "low", "max_tokens": 100})
    assert out == {"reasoning_effort": "low", "max_tokens": 100}


def test_credits_rounds_up_from_tokens():
    spec = CATALOG["gemini-2.5-pro"]
    c = credits_for(spec, input_tokens=1000, output_tokens=1000)
    assert c >= 1


def test_plans_define_free_and_pro():
    assert PLANS["free"].credits_per_period > 0
    assert "pro" in PLANS["pro"].allowed_tiers
