from app.services.model_catalog import CATALOG, PLANS, credits_for


def test_catalog_has_free_and_pro_models():
    tiers = {m.tier for m in CATALOG.values()}
    assert "free" in tiers and "pro" in tiers


def test_llm_models_point_at_gemini():
    for m in CATALOG.values():
        if m.provider != "openai_compat":
            continue
        assert m.base_url.startswith("https://generativelanguage.googleapis.com")
        assert m.key_env == "gemini_api_key"


def test_stt_model_present():
    spec = CATALOG["stt-default"]
    assert spec.provider == "deepgram"
    assert spec.capabilities == ("stt",)
    assert spec.key_env == "deepgram_api_key"
    assert spec.credits_per_audio_second > 0


def test_chat_models_use_gemini_3_1():
    assert CATALOG["answer-fast"].upstream_model == "gemini-3.1-flash-lite"
    assert CATALOG["answer-pro"].upstream_model == "gemini-3.1-pro-preview"
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
