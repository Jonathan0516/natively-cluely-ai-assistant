def test_models_lists_catalog_with_availability(client):
    resp = client.get("/llm/models")
    assert resp.status_code == 200
    items = resp.json()
    by_id = {m["id"]: m for m in items}
    # Both tiers are unlocked on every plan now: free- and pro-tier models both available.
    assert by_id["gemini-2.5-flash-lite"]["available"] is True
    assert by_id["gemini-2.5-pro"]["available"] is True
    assert "embed-default" not in by_id
    # Pricing is surfaced for the Model Library: credits per 1k input/output tokens.
    assert by_id["gemini-2.5-pro"]["price_in"] == 500.0
    assert by_id["gemini-2.5-pro"]["price_out"] == 1500.0


def test_quota_returns_status_without_raising(client):
    resp = client.get("/llm/quota")
    assert resp.status_code == 200
    data = resp.json()
    assert data["plan"] == "free"
    # /quota returns a combined credits_total: periodic free allowance (0) + wallet
    # balance (conftest seeds TEST_WALLET = 100_000).
    assert data["credits_total"] == 100_000          # allowance(0) + wallet(TEST_WALLET)
    assert data["credits_remaining"] == data["credits_total"]
    assert "period_end" in data


def test_quota_includes_wallet_balance(client):
    # conftest seeds TEST_USER's wallet with TEST_WALLET (100_000) credits.
    resp = client.get("/llm/quota")
    assert resp.status_code == 200
    data = resp.json()
    assert data["wallet_balance"] == 100_000
    # combined view: allowance(0) + wallet(100_000); remaining = max(0, 0-0) + 100_000
    assert data["credits_total"] == 100_000
    assert data["credits_remaining"] == 100_000


def test_usage_groups_events_by_meeting(client, usage_repo):
    import asyncio

    # Seed the shared in-memory repo: two models in one meeting + an untied event.
    asyncio.run(usage_repo.record_event(
        "u-test", kind="chat", model="gemini-2.5-pro",
        input_tokens=1000, output_tokens=1000, credits=20, meeting_id="mtg-1"))
    asyncio.run(usage_repo.record_event(
        "u-test", kind="chat", model="gemini-2.5-flash-lite",
        input_tokens=2000, output_tokens=500, credits=3, meeting_id="mtg-1"))
    asyncio.run(usage_repo.record_event(
        "u-test", kind="chat", model="gemini-2.5-flash-lite",
        input_tokens=100, output_tokens=100, credits=1))  # no meeting → excluded

    resp = client.get("/llm/usage")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    m = data[0]
    assert m["meeting_id"] == "mtg-1"
    assert m["input_tokens"] == 3000
    assert m["output_tokens"] == 1500
    assert m["credits"] == 23
    by_kind = {k["kind"]: k for k in m["kinds"]}
    assert set(by_kind) == {"llm"}
    by_model = {x["model"]: x for x in by_kind["llm"]["models"]}
    assert set(by_model) == {"gemini-2.5-pro", "gemini-2.5-flash-lite"}
    assert by_model["gemini-2.5-pro"]["rate_input"] == 500.0


def test_usage_meeting_breaks_down_by_turn(client, usage_repo):
    import asyncio

    asyncio.run(usage_repo.record_event(
        "u-test", kind="json", model="gemini-2.5-flash-lite",
        input_tokens=300, output_tokens=20, credits=1, meeting_id="mtg-1", turn_id="t1"))
    asyncio.run(usage_repo.record_event(
        "u-test", kind="chat", model="gemini-2.5-flash-lite",
        input_tokens=5000, output_tokens=400, credits=3, meeting_id="mtg-1", turn_id="t1"))
    asyncio.run(usage_repo.record_event(
        "u-test", kind="chat", model="gemini-2.5-pro",
        input_tokens=1000, output_tokens=1000, credits=20, meeting_id="mtg-1", turn_id="t2"))

    resp = client.get("/llm/usage/meeting/mtg-1")
    assert resp.status_code == 200
    data = resp.json()
    assert data["meeting_id"] == "mtg-1"
    assert data["credits"] == 24
    by_turn = {t["turn_id"]: t for t in data["turns"]}
    assert by_turn["t1"]["calls"] == 2
    assert by_turn["t1"]["input_tokens"] == 5300
    assert by_turn["t2"]["credits"] == 20
