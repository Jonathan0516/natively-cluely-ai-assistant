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
    await repo.record_event("u1", kind="json", model="gemini-2.5-pro",
                            input_tokens=1000, output_tokens=1000, credits=20)
    await repo.record_event("u1", kind="chat", model="gemini-2.5-pro",
                            input_tokens=500, output_tokens=500, credits=10)
    used = await repo.credits_used_since("u1", since="1970-01-01T00:00:00+00:00")
    assert used == 30


async def test_default_plan_is_free():
    repo = InMemoryUsageRepo()
    plan_id, anchor = await repo.get_subscription("nobody")
    assert plan_id == "free"
    assert anchor is None


async def test_set_and_get_plan():
    repo = InMemoryUsageRepo()
    await repo.set_plan("u1", "pro")
    plan_id, _ = await repo.get_subscription("u1")
    assert plan_id == "pro"


async def test_status_reflects_recorded_usage():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    spec = CATALOG["gemini-2.5-flash-lite"]
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
    spec = CATALOG["gemini-2.5-flash-lite"]
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


async def test_meeting_usage_groups_by_meeting_and_model():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    # Two models used in meeting m1 (a mid-meeting switch), one model in m2,
    # and one event with no meeting (must be excluded).
    await repo.record_event("u1", kind="chat", model="gemini-2.5-pro",
                            input_tokens=1000, output_tokens=1000, credits=20, meeting_id="m1")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-flash-lite",
                            input_tokens=500, output_tokens=500, credits=2, meeting_id="m1")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-flash-lite",
                            input_tokens=300, output_tokens=100, credits=1, meeting_id="m2")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-flash-lite",
                            input_tokens=100, output_tokens=0, credits=1)  # no meeting → excluded

    rows = await meter.meeting_usage("u1")
    assert len(rows) == 2
    by_id = {r["meeting_id"]: r for r in rows}

    m1 = by_id["m1"]
    assert m1["input_tokens"] == 1500
    assert m1["output_tokens"] == 1500
    assert m1["credits"] == 22
    assert {m["model"] for m in m1["models"]} == {"gemini-2.5-pro", "gemini-2.5-flash-lite"}
    pro = next(m for m in m1["models"] if m["model"] == "gemini-2.5-pro")
    assert pro["credits"] == 20
    assert pro["rate_input"] == CATALOG["gemini-2.5-pro"].credits_per_1k_input
    assert pro["rate_output"] == CATALOG["gemini-2.5-pro"].credits_per_1k_output

    assert by_id["m2"]["credits"] == 1


async def test_meeting_turn_usage_groups_by_turn():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    # Turn t1 spans two calls (intent + answer); turn t2 one call; one untied call (no turn).
    await repo.record_event("u1", kind="json", model="gemini-2.5-flash-lite",
                            input_tokens=300, output_tokens=20, credits=1,
                            meeting_id="m1", turn_id="t1")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-flash-lite",
                            input_tokens=5000, output_tokens=400, credits=3,
                            meeting_id="m1", turn_id="t1")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-pro",
                            input_tokens=1000, output_tokens=1000, credits=20,
                            meeting_id="m1", turn_id="t2")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-flash-lite",
                            input_tokens=200, output_tokens=10, credits=1,
                            meeting_id="m1")  # no turn → system bucket

    res = await meter.meeting_turn_usage("u1", "m1")
    assert res["meeting_id"] == "m1"
    assert res["credits"] == 25            # 1+3+20+1
    assert res["input_tokens"] == 6500     # 300+5000+1000+200
    by_turn = {t["turn_id"]: t for t in res["turns"]}
    assert by_turn["t1"]["calls"] == 2
    assert by_turn["t1"]["input_tokens"] == 5300
    assert by_turn["t1"]["credits"] == 4
    assert by_turn["t2"]["credits"] == 20
    assert by_turn["t2"]["models"][0]["rate_output"] == CATALOG["gemini-2.5-pro"].credits_per_1k_output
    assert None in by_turn                  # untied calls bucketed under null turn
    assert by_turn[None]["credits"] == 1
