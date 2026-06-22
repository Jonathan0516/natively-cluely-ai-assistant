import math

import pytest

from app.services.billing_repo import InMemoryBillingRepo
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
    billing = InMemoryBillingRepo()
    await billing.grant_credits("u1", 500, "evt_seed")
    meter = UsageMeter(repo, CATALOG, PLANS, billing)
    status = await meter.check("u1")
    assert status.credits_remaining == 500  # allowance(0) + wallet(500)


async def test_stt_credits_by_audio_seconds():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    spec = CATALOG["stt-default"]
    # Derive the expectation from the catalog rate so this stays correct when the
    # cost-recovery rate is retuned. Use an hour so we're well above the 1-credit floor.
    secs = 3600.0
    expected = math.ceil(secs * spec.credits_per_audio_second)
    credits = await meter.record("u1", kind="stt", spec=spec, usage=Usage(), audio_seconds=secs)
    assert credits == expected
    used = await repo.credits_used_since("u1", "1970-01-01T00:00:00+00:00")
    assert used == expected


async def test_stt_min_one_credit():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    credits = await meter.record("u1", kind="stt", spec=CATALOG["stt-default"], usage=Usage(),
                                 audio_seconds=0.5)
    assert credits == 1


def _kinds_by_kind(container: dict) -> dict:
    return {k["kind"]: k for k in container["kinds"]}


async def test_meeting_usage_groups_by_kind_then_model():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    # Meeting m1 mixes all three categories: two LLM models (a mid-meeting switch),
    # embeddings, and STT. m2 is LLM only. One event has no meeting (must be excluded).
    await repo.record_event("u1", kind="chat", model="gemini-2.5-pro",
                            input_tokens=1000, output_tokens=1000, credits=20, meeting_id="m1")
    await repo.record_event("u1", kind="json", model="gemini-2.5-flash-lite",
                            input_tokens=500, output_tokens=500, credits=2, meeting_id="m1")
    await repo.record_event("u1", kind="embeddings", model="embed-default",
                            input_tokens=5000, output_tokens=0, credits=1, meeting_id="m1")
    await repo.record_event("u1", kind="stt", model="stt-default",
                            audio_seconds=100.0, credits=10, meeting_id="m1")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-flash-lite",
                            input_tokens=300, output_tokens=100, credits=1, meeting_id="m2")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-flash-lite",
                            input_tokens=100, output_tokens=0, credits=1)  # no meeting → excluded

    rows = await meter.meeting_usage("u1")
    assert len(rows) == 2
    by_id = {r["meeting_id"]: r for r in rows}

    m1 = by_id["m1"]
    assert m1["input_tokens"] == 6500       # 1000+500+5000
    assert m1["output_tokens"] == 1500
    assert m1["audio_seconds"] == 100.0
    assert m1["credits"] == 33              # 20+2+1+10

    kinds = _kinds_by_kind(m1)
    assert set(kinds) == {"llm", "embedding", "stt"}

    llm = kinds["llm"]
    assert llm["credits"] == 22
    assert {m["model"] for m in llm["models"]} == {"gemini-2.5-pro", "gemini-2.5-flash-lite"}
    pro = next(m for m in llm["models"] if m["model"] == "gemini-2.5-pro")
    assert pro["credits"] == 20
    assert pro["rate_input"] == CATALOG["gemini-2.5-pro"].credits_per_1k_input
    assert pro["rate_output"] == CATALOG["gemini-2.5-pro"].credits_per_1k_output

    emb = kinds["embedding"]
    assert emb["input_tokens"] == 5000
    assert emb["credits"] == 1
    assert emb["models"][0]["rate_input"] == CATALOG["embed-default"].credits_per_1k_input

    stt = kinds["stt"]
    assert stt["audio_seconds"] == 100.0
    assert stt["credits"] == 10
    assert stt["models"][0]["audio_seconds"] == 100.0
    assert stt["models"][0]["rate_audio"] == CATALOG["stt-default"].credits_per_audio_second

    assert by_id["m2"]["credits"] == 1


async def test_meeting_turn_usage_groups_by_turn_and_kind():
    repo = InMemoryUsageRepo()
    meter = UsageMeter(repo, CATALOG, PLANS)
    # Turn t1 spans two LLM calls (intent + answer); turn t2 one LLM call. STT and embeddings
    # are continuous/meeting-level (no turn_id) → they bucket under the null "system" turn.
    await repo.record_event("u1", kind="json", model="gemini-2.5-flash-lite",
                            input_tokens=300, output_tokens=20, credits=1,
                            meeting_id="m1", turn_id="t1")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-flash-lite",
                            input_tokens=5000, output_tokens=400, credits=3,
                            meeting_id="m1", turn_id="t1")
    await repo.record_event("u1", kind="chat", model="gemini-2.5-pro",
                            input_tokens=1000, output_tokens=1000, credits=20,
                            meeting_id="m1", turn_id="t2")
    await repo.record_event("u1", kind="embeddings", model="embed-default",
                            input_tokens=2000, output_tokens=0, credits=1, meeting_id="m1")
    await repo.record_event("u1", kind="stt", model="stt-default",
                            audio_seconds=50.0, credits=5, meeting_id="m1")

    res = await meter.meeting_turn_usage("u1", "m1")
    assert res["meeting_id"] == "m1"
    assert res["credits"] == 30            # 1+3+20+1+5
    assert res["input_tokens"] == 8300     # 300+5000+1000+2000
    assert res["audio_seconds"] == 50.0

    by_turn = {t["turn_id"]: t for t in res["turns"]}
    assert by_turn["t1"]["calls"] == 2
    assert by_turn["t1"]["input_tokens"] == 5300
    assert by_turn["t1"]["credits"] == 4
    t1_kinds = _kinds_by_kind(by_turn["t1"])
    assert set(t1_kinds) == {"llm"}
    assert by_turn["t2"]["credits"] == 20

    assert None in by_turn                  # STT + embeddings bucketed under the null turn
    sys_kinds = _kinds_by_kind(by_turn[None])
    assert set(sys_kinds) == {"stt", "embedding"}
    assert sys_kinds["stt"]["audio_seconds"] == 50.0
    assert sys_kinds["embedding"]["credits"] == 1


async def test_wallet_consumed_only_beyond_free_allowance():
    # free allowance is 0 → every credit hits the wallet.
    usage_repo = InMemoryUsageRepo()
    billing = InMemoryBillingRepo()
    await billing.grant_credits("u1", 100, "evt_seed")
    meter = UsageMeter(usage_repo, CATALOG, PLANS, billing)
    spec = CATALOG["gemini-2.5-flash-lite"]
    credits = await meter.record(
        "u1", kind="json", spec=spec, usage=Usage(input_tokens=1000, output_tokens=1000)
    )  # 0.5 + 1.5 = 2 credits
    assert credits == 2
    assert await billing.get_balance("u1") == 98  # wallet dropped by the 2 overflow credits


async def test_status_reports_wallet_balance_and_remaining():
    usage_repo = InMemoryUsageRepo()
    billing = InMemoryBillingRepo()
    await billing.grant_credits("u1", 100, "evt_seed")
    meter = UsageMeter(usage_repo, CATALOG, PLANS, billing)
    st = await meter.status("u1")
    assert st.wallet_balance == 100
    assert st.credits_remaining == 100  # allowance(0) + wallet(100)
    assert st.exhausted is False


async def test_check_blocks_when_allowance_zero_and_wallet_empty():
    usage_repo = InMemoryUsageRepo()
    meter = UsageMeter(usage_repo, CATALOG, PLANS, InMemoryBillingRepo())
    with pytest.raises(QuotaExceeded):
        await meter.check("u1")  # no free allowance, no wallet → blocked


async def test_check_passes_with_wallet_balance():
    usage_repo = InMemoryUsageRepo()
    billing = InMemoryBillingRepo()
    await billing.grant_credits("u1", 10, "evt_seed")
    meter = UsageMeter(usage_repo, CATALOG, PLANS, billing)
    st = await meter.check("u1")
    assert st.credits_remaining == 10
