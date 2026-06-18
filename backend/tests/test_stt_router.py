import json
import time

import pytest
from starlette.websockets import WebSocketDisconnect


def test_stt_rejects_missing_token(client):
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect("/llm/stt") as ws:
            ws.receive_text()
    assert ei.value.code == 4401


def test_stt_rejects_bad_token(client):
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect("/llm/stt?token=garbage") as ws:
            ws.receive_text()
    assert ei.value.code == 4401


def test_stt_relays_transcripts_and_meters(client, jwt_svc, usage_repo, test_user):
    token = jwt_svc.issue(test_user.id, test_user.phone).access_token
    url = f"/llm/stt?token={token}&sample_rate=16000&channels=1"
    with client.websocket_connect(url) as ws:
        msg = ws.receive_text()             # fake yields one transcript on connect
        assert json.loads(msg)["text"] == "hello world"
        ws.send_bytes(b"\x00" * 32000)      # 1.0s of linear16 mono audio
    # after disconnect the endpoint records stt usage (poll to avoid close/record race)
    for _ in range(50):
        if any(e["kind"] == "stt" for e in usage_repo._events):
            break
        time.sleep(0.02)
    stt = [e for e in usage_repo._events if e["kind"] == "stt"]
    assert stt and stt[0]["credits"] >= 1


def test_stt_quota_exhausted_closes_4029(client, jwt_svc, usage_repo, test_user):
    token = jwt_svc.issue(test_user.id, test_user.phone).access_token
    # pre-seed exhausted usage within the current period (future ts so credits_used_since counts it)
    usage_repo._events.append({
        "user_id": test_user.id, "kind": "stt", "model": "stt-default",
        "input_tokens": 0, "output_tokens": 0, "audio_seconds": 0, "credits": 1000,
        "created_at": "2099-01-01T00:00:00+00:00",
    })
    with pytest.raises(WebSocketDisconnect) as ei:
        with client.websocket_connect(f"/llm/stt?token={token}") as ws:
            ws.receive_text()
    assert ei.value.code == 4029
