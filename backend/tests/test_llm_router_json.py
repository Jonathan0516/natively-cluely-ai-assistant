async def test_json_returns_text_and_records_usage(client, usage_repo):
    resp = client.post("/llm/json", json={
        "model": "gemini-2.5-flash-lite",
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert resp.status_code == 200
    assert resp.json()["text"] == '{"ok": true}'
    # one usage event recorded for the test user
    used = await usage_repo.credits_used_since("u-test", "1970-01-01T00:00:00+00:00")
    assert used >= 1


async def test_json_402_when_quota_exhausted(client, usage_repo, billing_repo):
    # Free allowance is 0; the wallet is the sole credit source, so drain it (conftest seeds
    # TEST_WALLET) to simulate quota exhaustion.
    await billing_repo.consume_credits("u-test", await billing_repo.get_balance("u-test"))
    resp = client.post("/llm/json", json={
        "model": "gemini-2.5-flash-lite",
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert resp.status_code == 402
    assert resp.json()["detail"]["error"] == "quota_exceeded"


def test_json_unknown_model_returns_400(client):
    resp = client.post("/llm/json", json={
        "model": "nope", "messages": [{"role": "user", "content": "hi"}],
    })
    assert resp.status_code == 400


def test_json_pro_model_allowed_on_free_plan(client):
    # Both tiers are unlocked on every plan now — a pro-tier model is accepted, not 403'd.
    resp = client.post("/llm/json", json={
        "model": "gemini-2.5-pro", "messages": [{"role": "user", "content": "hi"}],
    })
    assert resp.status_code == 200
    assert resp.json()["text"] == '{"ok": true}'
