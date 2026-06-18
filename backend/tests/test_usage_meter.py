import pytest

from app.services.llm_types import QuotaExceeded, QuotaStatus, Usage
from app.services.model_catalog import CATALOG, PLANS
from app.services.usage_meter import UsageMeter
from app.services.usage_repo import InMemoryUsageRepo


def test_quota_remaining_and_exhausted():
    q = QuotaStatus(
        plan="free", period_start="a", period_end="b", credits_total=100, credits_used=30
    )
    assert q.credits_remaining == 70
    assert q.exhausted is False
    q2 = QuotaStatus(
        plan="free", period_start="a", period_end="b", credits_total=100, credits_used=100
    )
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


async def test_status_reflects_recorded_usage():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    spec = CATALOG["answer-fast"]
    await meter.record(
        "u1", kind="json", spec=spec, usage=Usage(input_tokens=1000, output_tokens=1000)
    )
    status = await meter.status("u1")
    assert status.plan == "free"
    assert status.credits_total == PLANS["free"].credits_per_period
    assert status.credits_used == 2   # 0.5*1 + 1.5*1 = 2 credits


async def test_check_raises_when_exhausted():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    # Free plan = 1000 credits. Burn it all via one big event.
    spec = CATALOG["answer-fast"]
    await repo.record_event("u1", kind="json", model=spec.id,
                            input_tokens=0, output_tokens=500_000, credits=1000)
    with pytest.raises(QuotaExceeded):
        await meter.check("u1")


async def test_check_passes_when_under_quota():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    status = await meter.check("u1")   # no usage yet
    assert status.credits_remaining == PLANS["free"].credits_per_period


async def test_stt_credits_by_audio_seconds():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    spec = CATALOG["stt-default"]
    credits = await meter.record("u1", kind="stt", spec=spec, usage=Usage(), audio_seconds=100.0)
    # 100s * credits_per_audio_second (0.1) = 10 credits
    assert credits == 10
    used = await repo.credits_used_since("u1", "1970-01-01T00:00:00+00:00")
    assert used == 10


async def test_stt_min_one_credit():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    credits = await meter.record("u1", kind="stt", spec=CATALOG["stt-default"], usage=Usage(),
                                 audio_seconds=0.5)
    assert credits == 1
