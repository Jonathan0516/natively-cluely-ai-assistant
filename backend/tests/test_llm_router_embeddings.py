async def test_embeddings_returns_vectors_and_records_usage(client, usage_repo):
    resp = client.post("/llm/embeddings", json={"texts": ["hi", "there"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["dim"] == 3
    assert len(data["embeddings"]) == 2
    assert data["model"] == "embed-default"
    used = await usage_repo.credits_used_since("u-test", "1970-01-01T00:00:00+00:00")
    assert used >= 1


async def test_embeddings_402_when_quota_exhausted(client, usage_repo, billing_repo):
    # Free allowance is 0; the wallet is the sole credit source, so quota is only exhausted
    # once the wallet itself is drained (conftest seeds TEST_WALLET).
    await billing_repo.consume_credits("u-test", await billing_repo.get_balance("u-test"))
    resp = client.post("/llm/embeddings", json={"texts": ["hi"]})
    assert resp.status_code == 402
    assert resp.json()["detail"]["error"] == "quota_exceeded"


def test_embeddings_unknown_model_returns_400(client):
    resp = client.post("/llm/embeddings", json={"texts": ["hi"], "model": "nope"})
    assert resp.status_code == 400


def test_embeddings_attributes_usage_to_meeting(client, usage_repo):
    resp = client.post("/llm/embeddings", json={"texts": ["hi"], "meeting_id": "m-emb"})
    assert resp.status_code == 200
    emb = [e for e in usage_repo._events if e["kind"] == "embeddings"]
    assert emb and emb[-1]["meeting_id"] == "m-emb"
