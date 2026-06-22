import httpx
import pytest

from app.services.supabase_retry import read_with_retry


def test_retries_transient_disconnect_then_succeeds():
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        if calls["n"] < 2:
            raise httpx.RemoteProtocolError("Server disconnected")
        return "ok"

    assert read_with_retry(fn, base_delay=0) == "ok"
    assert calls["n"] == 2


def test_gives_up_after_attempts_and_reraises_last():
    def fn():
        raise httpx.RemoteProtocolError("Server disconnected")

    with pytest.raises(httpx.RemoteProtocolError):
        read_with_retry(fn, attempts=3, base_delay=0)


def test_does_not_retry_non_transport_errors():
    calls = {"n": 0}

    def fn():
        calls["n"] += 1
        raise ValueError("boom")  # an application error, not a dead connection

    with pytest.raises(ValueError):
        read_with_retry(fn, base_delay=0)
    assert calls["n"] == 1  # not retried
