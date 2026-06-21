from app.services.model_catalog import CATALOG, PLANS, credits_for


def test_catalog_has_free_and_pro_models():
    tiers = {m.tier for m in CATALOG.values()}
    assert "free" in tiers and "pro" in tiers


def test_openai_compat_models_have_consistent_base_and_key():
    # Each OpenAI-compatible model must pair its base_url with the matching key_env so the
    # gateway router picks the right credential. Gemini + Groq are both supported.
    expected = {
        "https://generativelanguage.googleapis.com": "gemini_api_key",
        "https://api.groq.com": "groq_api_key",
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
    assert CATALOG["answer-fast"].upstream_model == "gemini-2.5-flash-lite"
    assert CATALOG["answer-pro"].upstream_model == "gemini-2.5-pro"
    assert "answer-netmind" not in CATALOG


def test_embedding_model_present_768d():
    spec = CATALOG["embed-default"]
    assert spec.capabilities == ("embedding",)
    assert spec.embed_dim == 768
    assert spec.upstream_model == "gemini-embedding-001"


def test_credits_rounds_up_from_tokens():
    spec = CATALOG["answer-pro"]
    c = credits_for(spec, input_tokens=1000, output_tokens=1000)
    assert c >= 1


def test_plans_define_free_and_pro():
    assert PLANS["free"].credits_per_period > 0
    assert "pro" in PLANS["pro"].allowed_tiers
