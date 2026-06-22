import json

import stripe


def test_packs_lists_three_tiers(client):
    resp = client.get("/billing/packs")
    assert resp.status_code == 200
    packs = {p["id"]: p for p in resp.json()}
    assert set(packs) == {"pack_s", "pack_m", "pack_l"}
    assert packs["pack_s"] == {"id": "pack_s", "currency": "cny", "amount": 5000, "credits": 5000}


def test_checkout_unknown_pack_is_400(client, monkeypatch):
    monkeypatch.setattr("app.config.Settings.stripe_enabled", property(lambda self: True))
    resp = client.post("/billing/checkout", json={"pack_id": "nope"})
    assert resp.status_code == 400


def test_checkout_returns_session_url(client, monkeypatch):
    monkeypatch.setattr("app.config.Settings.stripe_enabled", property(lambda self: True))

    class FakeSession:
        url = "https://checkout.stripe.com/c/pay/test_123"

    captured = {}

    def fake_create(**kwargs):
        captured.update(kwargs)
        return FakeSession()

    monkeypatch.setattr(stripe.checkout.Session, "create", staticmethod(fake_create))
    resp = client.post("/billing/checkout", json={"pack_id": "pack_m"})
    assert resp.status_code == 200
    assert resp.json()["url"].startswith("https://checkout.stripe.com/")
    assert captured["mode"] == "payment"
    assert captured["payment_method_types"] == ["card", "alipay", "wechat_pay"]
    # WeChat Pay on hosted Checkout requires client="web" — Stripe 400s without it.
    assert captured["payment_method_options"] == {"wechat_pay": {"client": "web"}}
    assert captured["metadata"]["credits"] == "10000"
    assert captured["metadata"]["user_id"] == "u-test"


def test_checkout_503_when_stripe_disabled(client, monkeypatch):
    # Force-disable regardless of ambient .env (a real STRIPE_SECRET_KEY may be configured).
    monkeypatch.setattr("app.config.Settings.stripe_enabled", property(lambda self: False))
    resp = client.post("/billing/checkout", json={"pack_id": "pack_m"})
    assert resp.status_code == 503


def test_webhook_rejects_bad_signature(client, monkeypatch):
    def boom(payload, sig, secret):
        raise stripe.error.SignatureVerificationError("bad", sig)

    monkeypatch.setattr(stripe.Webhook, "construct_event", staticmethod(boom))
    resp = client.post("/billing/webhook", content=b"{}",
                       headers={"stripe-signature": "t=1,v1=deadbeef"})
    assert resp.status_code == 400


def test_webhook_grants_credits_idempotently(client, billing_repo, monkeypatch):
    import asyncio

    before = asyncio.run(billing_repo.get_balance("u-test"))  # conftest seed
    event = {
        "id": "evt_777", "type": "checkout.session.completed",
        "data": {"object": {"payment_status": "paid",
                            "metadata": {"user_id": "u-test", "credits": "100"}}},
    }
    monkeypatch.setattr(stripe.Webhook, "construct_event",
                        staticmethod(lambda payload, sig, secret: event))
    for _ in range(2):  # duplicate delivery
        resp = client.post("/billing/webhook", content=json.dumps(event).encode(),
                           headers={"stripe-signature": "sig"})
        assert resp.status_code == 200
    assert asyncio.run(billing_repo.get_balance("u-test")) == before + 100  # credited once


def test_webhook_bad_credits_metadata_no_500_no_credit(client, billing_repo, monkeypatch):
    import asyncio

    before = asyncio.run(billing_repo.get_balance("u-test"))
    event = {
        "id": "evt_bad", "type": "checkout.session.completed",
        "data": {"object": {"payment_status": "paid",
                            "metadata": {"user_id": "u-test", "credits": "not-a-number"}}},
    }
    monkeypatch.setattr(stripe.Webhook, "construct_event",
                        staticmethod(lambda payload, sig, secret: event))
    resp = client.post("/billing/webhook", content=json.dumps(event).encode(),
                       headers={"stripe-signature": "sig"})
    # Malformed metadata must not 500 (a non-2xx triggers Stripe to retry the poison event).
    assert resp.status_code == 200
    assert asyncio.run(billing_repo.get_balance("u-test")) == before  # nothing credited
