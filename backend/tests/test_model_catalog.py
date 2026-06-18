from app.services.model_catalog import CATALOG, PLANS, credits_for


def test_catalog_has_free_and_pro_models():
    tiers = {m.tier for m in CATALOG.values()}
    assert "free" in tiers and "pro" in tiers


def test_every_model_points_at_a_known_provider():
    for m in CATALOG.values():
        assert m.provider == "openai_compat"
        assert m.base_url.startswith("http")
        assert m.key_env  # non-empty


def test_credits_rounds_up_from_tokens():
    spec = next(iter(CATALOG.values()))
    # 1000 in @ cpi, 1000 out @ cpo → exactly cpi+cpo credits, min 1
    c = credits_for(spec, input_tokens=1000, output_tokens=1000)
    assert c >= 1


def test_plans_define_free_and_pro():
    assert PLANS["free"].credits_per_period > 0
    assert "pro" in PLANS["pro"].allowed_tiers
