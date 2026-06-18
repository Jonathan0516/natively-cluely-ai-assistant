async def test_embeddings_returns_vectors_and_records_usage(client, usage_repo):
    resp = client.post("/llm/embeddings", json={"texts": ["hi", "there"]})
    assert resp.status_code == 200
    data = resp.json()
    assert data["dim"] == 3
    assert len(data["embeddings"]) == 2
    assert data["model"] == "embed-default"
    used = await usage_repo.credits_used_since("u-test", "1970-01-01T00:00:00+00:00")
    assert used >= 1


async def test_embeddings_402_when_quota_exhausted(client, usage_repo):
    await usage_repo.record_event("u-test", kind="embeddings", model="embed-default",
                                  input_tokens=0, output_tokens=0, credits=1000)
    resp = client.post("/llm/embeddings", json={"texts": ["hi"]})
    assert resp.status_code == 402
    assert resp.json()["detail"]["error"] == "quota_exceeded"


def test_embeddings_unknown_model_returns_400(client):
    resp = client.post("/llm/embeddings", json={"texts": ["hi"], "model": "nope"})
    assert resp.status_code == 400
