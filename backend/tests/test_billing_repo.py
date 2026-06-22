from app.services.billing_repo import InMemoryBillingRepo


async def test_grant_is_idempotent_by_event_id():
    repo = InMemoryBillingRepo()
    assert await repo.grant_credits("u1", 50, "evt_1") is True
    assert await repo.grant_credits("u1", 50, "evt_1") is False  # same event → no double credit
    assert await repo.get_balance("u1") == 50


async def test_grant_accumulates_distinct_events():
    repo = InMemoryBillingRepo()
    await repo.grant_credits("u1", 50, "evt_1")
    await repo.grant_credits("u1", 100, "evt_2")
    assert await repo.get_balance("u1") == 150


async def test_consume_decrements_and_clamps_at_zero():
    repo = InMemoryBillingRepo()
    await repo.grant_credits("u1", 50, "evt_1")
    await repo.consume_credits("u1", 20)
    assert await repo.get_balance("u1") == 30
    await repo.consume_credits("u1", 999)  # over-spend clamps, never negative
    assert await repo.get_balance("u1") == 0


async def test_balance_zero_for_unknown_user():
    repo = InMemoryBillingRepo()
    assert await repo.get_balance("nobody") == 0
