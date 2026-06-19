async def test_json_returns_text_and_records_usage(client, usage_repo):
    resp = client.post("/llm/json", json={
        "model": "answer-fast",
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert resp.status_code == 200
    assert resp.json()["text"] == '{"ok": true}'
    # one usage event recorded for the test user
    used = await usage_repo.credits_used_since("u-test", "1970-01-01T00:00:00+00:00")
    assert used >= 1


async def test_json_402_when_quota_exhausted(client, usage_repo):
    # pre-burn the entire free quota (1000 credits) so the next call is rejected
    await usage_repo.record_event("u-test", kind="json", model="answer-fast",
                                  input_tokens=0, output_tokens=0, credits=1000)
    resp = client.post("/llm/json", json={
        "model": "answer-fast",
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert resp.status_code == 402
    assert resp.json()["detail"]["error"] == "quota_exceeded"


def test_json_unknown_model_returns_400(client):
    resp = client.post("/llm/json", json={
        "model": "nope", "messages": [{"role": "user", "content": "hi"}],
    })
    assert resp.status_code == 400


def test_json_403_when_model_tier_not_in_plan(client):
    # free-plan test user requesting a pro-tier model is rejected before generation
    resp = client.post("/llm/json", json={
        "model": "answer-pro", "messages": [{"role": "user", "content": "hi"}],
    })
    assert resp.status_code == 403
    assert resp.json()["detail"]["error"] == "tier_not_allowed"
