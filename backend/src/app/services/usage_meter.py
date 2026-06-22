# backend/src/app/services/usage_meter.py
"""Quota enforcement + usage recording. Stateless over UsageRepo + catalog/plans."""
from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from .llm_types import QuotaExceeded, QuotaStatus, TierNotAllowed, Usage
from .model_catalog import ModelSpec, Plan, credits_for
from .usage_repo import UsageRepo

if TYPE_CHECKING:
    from .billing_repo import BillingRepo


def _kind_category(kind: str) -> str:
    """Collapse the stored event `kind` into the user-facing usage category. chat/json are
    both interactive LLM calls and share one "llm" bucket; STT and embeddings are their own."""
    if kind == "stt":
        return "stt"
    if kind == "embeddings":
        return "embedding"
    return "llm"


def _period_bounds(period: str, anchor_iso: str | None) -> tuple[str, str]:
    """Return (start, end) ISO strings for the current period. Calendar-month aligned
    to UTC when no explicit anchor; weekly is a rolling 7-day window from anchor/now."""
    now = datetime.now(UTC)
    if period == "week":
        start = datetime.fromisoformat(anchor_iso) if anchor_iso else now
        while now - start >= timedelta(days=7):
            start += timedelta(days=7)
        return start.isoformat(), (start + timedelta(days=7)).isoformat()
    # month (default): first of this month → first of next month, UTC
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if start.month == 12:
        end = start.replace(year=start.year + 1, month=1)
    else:
        end = start.replace(month=start.month + 1)
    return start.isoformat(), end.isoformat()


class UsageMeter:
    def __init__(self, repo: UsageRepo, catalog: dict[str, ModelSpec], plans: dict[str, Plan],
                 billing_repo: BillingRepo | None = None):
        from .billing_repo import InMemoryBillingRepo
        self._repo = repo
        self._catalog = catalog
        self._plans = plans
        self._billing = billing_repo or InMemoryBillingRepo()

    async def status(self, user_id: str) -> QuotaStatus:
        plan_id, anchor = await self._repo.get_subscription(user_id)
        plan = self._plans.get(plan_id, self._plans["free"])
        start, end = _period_bounds(plan.period, anchor)
        used = await self._repo.credits_used_since(user_id, start)
        balance = await self._billing.get_balance(user_id)
        return QuotaStatus(
            plan=plan.id, period_start=start, period_end=end,
            credits_total=plan.credits_per_period, credits_used=used,
            wallet_balance=balance,
        )

    async def check(self, user_id: str) -> QuotaStatus:
        st = await self.status(user_id)
        if st.exhausted:
            raise QuotaExceeded(st)
        return st

    async def record(self, user_id: str, *, kind: str, spec: ModelSpec, usage: Usage,
                     audio_seconds: float = 0.0, meeting_id: str | None = None,
                     turn_id: str | None = None) -> int:
        if kind == "stt":
            credits = max(1, math.ceil(audio_seconds * spec.credits_per_audio_second))
        else:
            credits = credits_for(spec, usage.input_tokens, usage.output_tokens)
            if audio_seconds:
                credits = max(credits, max(1, round(audio_seconds)))
        await self._repo.record_event(
            user_id, kind=kind, model=spec.id,
            input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
            audio_seconds=audio_seconds, credits=credits,
            meeting_id=meeting_id, turn_id=turn_id,
        )
        # Deduct the portion of this call beyond the plan's free allowance from the
        # persistent wallet. With allowance 0 this is the full credit cost.
        plan_id, anchor = await self._repo.get_subscription(user_id)
        plan = self._plans.get(plan_id, self._plans["free"])
        start, _ = _period_bounds(plan.period, anchor)
        used_after = await self._repo.credits_used_since(user_id, start)  # includes this event
        used_before = used_after - credits
        allowance = plan.credits_per_period
        overflow = max(0, used_after - allowance) - max(0, used_before - allowance)
        if overflow > 0:
            await self._billing.consume_credits(user_id, overflow)
        return credits

    def _aggregate_kinds(self, events: list[dict]) -> dict:
        """Roll a flat list of usage events into category → model breakdowns plus grand totals.

        Events are bucketed into "llm" (chat/json), "stt", and "embedding" categories; within
        each, usage is summed per model. Stored (billed) `credits` are summed as-is; catalog
        rates (`rate_input`/`rate_output` per 1k tokens, `rate_audio` per audio second) are
        attached so the UI can explain how credits were derived. STT rows carry `audio_seconds`
        and zero tokens; embedding rows carry input tokens. Returns a dict with grand totals
        (`input_tokens`/`output_tokens`/`audio_seconds`/`credits`) and a `kinds` list, each
        `{kind, input_tokens, output_tokens, audio_seconds, credits, models: [...]}`."""
        cats: dict[str, dict[str, dict]] = {}
        t_in = t_out = t_cr = 0
        t_audio = 0.0
        for e in events:
            cat = _kind_category(e.get("kind") or "")
            inp = int(e.get("input_tokens") or 0)
            outp = int(e.get("output_tokens") or 0)
            cr = int(e.get("credits") or 0)
            aud = float(e.get("audio_seconds") or 0.0)
            ml = cats.setdefault(cat, {}).setdefault(
                e["model"],
                {"input_tokens": 0, "output_tokens": 0, "audio_seconds": 0.0, "credits": 0},
            )
            ml["input_tokens"] += inp
            ml["output_tokens"] += outp
            ml["audio_seconds"] += aud
            ml["credits"] += cr
            t_in += inp
            t_out += outp
            t_audio += aud
            t_cr += cr

        kinds: list[dict] = []
        for cat, models in cats.items():
            model_lines, k_in, k_out, k_cr = [], 0, 0, 0
            k_audio = 0.0
            for model_id, ml in models.items():
                spec = self._catalog.get(model_id)
                model_lines.append({
                    "model": model_id,
                    "label": spec.label if spec else model_id,
                    "input_tokens": ml["input_tokens"],
                    "output_tokens": ml["output_tokens"],
                    "audio_seconds": ml["audio_seconds"],
                    "credits": ml["credits"],
                    "rate_input": spec.credits_per_1k_input if spec else 0.0,
                    "rate_output": spec.credits_per_1k_output if spec else 0.0,
                    "rate_audio": spec.credits_per_audio_second if spec else 0.0,
                })
                k_in += ml["input_tokens"]
                k_out += ml["output_tokens"]
                k_audio += ml["audio_seconds"]
                k_cr += ml["credits"]
            model_lines.sort(key=lambda x: x["credits"], reverse=True)
            kinds.append({
                "kind": cat, "input_tokens": k_in, "output_tokens": k_out,
                "audio_seconds": k_audio, "credits": k_cr, "models": model_lines,
            })
        kinds.sort(key=lambda x: x["credits"], reverse=True)
        return {
            "input_tokens": t_in, "output_tokens": t_out, "audio_seconds": t_audio,
            "credits": t_cr, "kinds": kinds,
        }

    async def meeting_usage(self, user_id: str) -> list[dict]:
        """Per-meeting usage for the current billing period, broken down by category (LLM /
        STT / embedding) then model. Events not tied to a meeting (meeting_id is null) are
        excluded. Sorted by most-recent activity."""
        st = await self.status(user_id)
        events = await self._repo.list_events_since(user_id, st.period_start)

        by_meeting: dict[str, dict] = {}
        for e in events:
            mid = e.get("meeting_id")
            if not mid:
                continue
            created = e.get("created_at") or ""
            m = by_meeting.setdefault(mid, {"last_used": created, "events": []})
            m["events"].append(e)
            if created > m["last_used"]:
                m["last_used"] = created

        out: list[dict] = []
        for mid, m in by_meeting.items():
            agg = self._aggregate_kinds(m["events"])
            out.append({"meeting_id": mid, "last_used": m["last_used"], **agg})
        out.sort(key=lambda x: x["last_used"], reverse=True)
        return out

    async def meeting_turn_usage(self, user_id: str, meeting_id: str) -> dict:
        """One meeting's usage broken down per turn (one "turn" = one Q&A; a turn may span
        several calls, e.g. intent classification + answer generation), then by category and
        model. Turns are keyed by `turn_id`; calls not tied to a turn (post-meeting summary,
        STT, embeddings) land under turn_id=null so the UI can surface them as a "system/other"
        bucket. Also returns meeting grand totals."""
        events = await self._repo.events_for_meeting(user_id, meeting_id)

        by_turn: dict[str | None, list[dict]] = {}
        for e in events:
            by_turn.setdefault(e.get("turn_id"), []).append(e)

        turn_list: list[dict] = []
        for tid, turn_events in by_turn.items():
            agg = self._aggregate_kinds(turn_events)
            turn_list.append({"turn_id": tid, "calls": len(turn_events), **agg})

        grand = self._aggregate_kinds(events)
        return {
            "meeting_id": meeting_id,
            "input_tokens": grand["input_tokens"], "output_tokens": grand["output_tokens"],
            "audio_seconds": grand["audio_seconds"], "credits": grand["credits"],
            "turns": turn_list,
        }

    def plan_allowed_tiers(self, plan_id: str) -> tuple[str, ...]:
        plan = self._plans.get(plan_id, self._plans["free"])
        return plan.allowed_tiers

    def authorize_model(self, plan_id: str, spec: ModelSpec) -> None:
        """Raise TierNotAllowed if the plan does not unlock the model's tier. Takes the plan id
        from an already-fetched QuotaStatus so no extra round-trip is needed."""
        if spec.tier not in self.plan_allowed_tiers(plan_id):
            raise TierNotAllowed(spec.tier, plan_id)
