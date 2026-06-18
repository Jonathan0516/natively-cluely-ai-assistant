import json


def _collect_sse(raw: str) -> tuple[str, bool]:
    text, done = "", False
    for line in raw.splitlines():
        if not line.startswith("data: "):
            continue
        data = line[6:]
        if data == "[DONE]":
            done = True
            continue
        obj = json.loads(data)
        text += obj.get("delta", "")
    return text, done


async def test_chat_streams_text_and_records_usage(client, usage_repo):
    with client.stream("POST", "/llm/chat", json={
        "model": "answer-pro",
        "messages": [{"role": "user", "content": "hi"}],
    }) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        body = "".join(resp.iter_text())
    text, done = _collect_sse(body)
    assert text == "Hello world"
    assert done is True
    used = await usage_repo.credits_used_since("u-test", "1970-01-01T00:00:00+00:00")
    assert used >= 1


def test_chat_unknown_model_400(client):
    resp = client.post("/llm/chat", json={
        "model": "nope", "messages": [{"role": "user", "content": "hi"}],
    })
    assert resp.status_code == 400
