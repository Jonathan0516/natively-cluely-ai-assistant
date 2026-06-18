def test_models_lists_catalog_with_availability(client):
    resp = client.get("/llm/models")
    assert resp.status_code == 200
    items = resp.json()
    by_id = {m["id"]: m for m in items}
    # free plan (default for test user): free-tier model available, pro-tier not
    assert by_id["answer-fast"]["available"] is True
    assert by_id["answer-pro"]["available"] is False


def test_quota_returns_status_without_raising(client):
    resp = client.get("/llm/quota")
    assert resp.status_code == 200
    data = resp.json()
    assert data["plan"] == "free"
    assert data["credits_remaining"] == data["credits_total"]
    assert "period_end" in data
