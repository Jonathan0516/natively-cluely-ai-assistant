import pytest

from app.services.llm_types import QuotaStatus
from app.services.usage_repo import InMemoryUsageRepo


def test_quota_remaining_and_exhausted():
    q = QuotaStatus(plan="free", period_start="a", period_end="b", credits_total=100, credits_used=30)
    assert q.credits_remaining == 70
    assert q.exhausted is False
    q2 = QuotaStatus(plan="free", period_start="a", period_end="b", credits_total=100, credits_used=100)
    assert q2.credits_remaining == 0
    assert q2.exhausted is True


async def test_record_and_sum_credits_in_period():
    repo = InMemoryUsageRepo()
    await repo.record_event("u1", kind="json", model="answer-pro",
                            input_tokens=1000, output_tokens=1000, credits=20)
    await repo.record_event("u1", kind="chat", model="answer-pro",
                            input_tokens=500, output_tokens=500, credits=10)
    used = await repo.credits_used_since("u1", since="1970-01-01T00:00:00+00:00")
    assert used == 30


async def test_default_plan_is_free():
    repo = InMemoryUsageRepo()
    assert await repo.get_plan_id("nobody") == "free"


async def test_set_and_get_plan():
    repo = InMemoryUsageRepo()
    await repo.set_plan("u1", "pro")
    assert await repo.get_plan_id("u1") == "pro"
