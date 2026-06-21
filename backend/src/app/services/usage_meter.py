# backend/src/app/services/usage_meter.py
"""Quota enforcement + usage recording. Stateless over UsageRepo + catalog/plans."""
from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

from .llm_types import QuotaExceeded, QuotaStatus, TierNotAllowed, Usage
from .model_catalog import ModelSpec, Plan, credits_for
from .usage_repo import UsageRepo


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
    def __init__(self, repo: UsageRepo, catalog: dict[str, ModelSpec], plans: dict[str, Plan]):
        self._repo = repo
        self._catalog = catalog
        self._plans = plans

    async def status(self, user_id: str) -> QuotaStatus:
        plan_id, anchor = await self._repo.get_subscription(user_id)
        plan = self._plans.get(plan_id, self._plans["free"])
        start, end = _period_bounds(plan.period, anchor)
        used = await self._repo.credits_used_since(user_id, start)
        return QuotaStatus(
            plan=plan.id, period_start=start, period_end=end,
            credits_total=plan.credits_per_period, credits_used=used,
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
        return credits

    async def meeting_usage(self, user_id: str) -> list[dict]:
        """Per-meeting usage for the current billing period, broken down by model.
        Events not tied to a meeting (meeting_id is null) are excluded. Per-model `credits`
        sum the stored (billed) credits; `rate_input`/`rate_output` come from the catalog so
        the UI can explain how credits were derived. Sorted by most-recent activity."""
        st = await self.status(user_id)
        events = await self._repo.list_events_since(user_id, st.period_start)

        meetings: dict[str, dict] = {}
        for e in events:
            mid = e.get("meeting_id")
            if not mid:
                continue
            created = e.get("created_at") or ""
            m = meetings.setdefault(mid, {"meeting_id": mid, "last_used": created, "models": {}})
            if created > m["last_used"]:
                m["last_used"] = created
            ml = m["models"].setdefault(
                e["model"], {"input_tokens": 0, "output_tokens": 0, "credits": 0}
            )
            ml["input_tokens"] += int(e.get("input_tokens") or 0)
            ml["output_tokens"] += int(e.get("output_tokens") or 0)
            ml["credits"] += int(e.get("credits") or 0)

        out: list[dict] = []
        for m in meetings.values():
            models, t_in, t_out, t_cr = [], 0, 0, 0
            for model_id, ml in m["models"].items():
                spec = self._catalog.get(model_id)
                models.append({
                    "model": model_id,
                    "label": spec.label if spec else model_id,
                    "input_tokens": ml["input_tokens"],
                    "output_tokens": ml["output_tokens"],
                    "credits": ml["credits"],
                    "rate_input": spec.credits_per_1k_input if spec else 0.0,
                    "rate_output": spec.credits_per_1k_output if spec else 0.0,
                })
                t_in += ml["input_tokens"]
                t_out += ml["output_tokens"]
                t_cr += ml["credits"]
            models.sort(key=lambda x: x["credits"], reverse=True)
            out.append({
                "meeting_id": m["meeting_id"], "last_used": m["last_used"],
                "input_tokens": t_in, "output_tokens": t_out, "credits": t_cr, "models": models,
            })
        out.sort(key=lambda x: x["last_used"], reverse=True)
        return out

    async def meeting_turn_usage(self, user_id: str, meeting_id: str) -> dict:
        """One meeting's usage broken down per turn (one "turn" = one Q&A; a turn may span
        several calls, e.g. intent classification + answer generation). Turns are keyed by
        `turn_id`; calls not tied to a turn (e.g. post-meeting summary) land under turn_id=null
        so the UI can surface them as a "system/other" bucket. Also returns meeting grand totals."""
        events = await self._repo.events_for_meeting(user_id, meeting_id)

        turns: dict[str | None, dict] = {}
        t_in = t_out = t_cr = 0
        for e in events:
            tid = e.get("turn_id")
            tr = turns.setdefault(tid, {"turn_id": tid, "calls": 0, "models": {}})
            tr["calls"] += 1
            ml = tr["models"].setdefault(
                e["model"], {"input_tokens": 0, "output_tokens": 0, "credits": 0}
            )
            inp = int(e.get("input_tokens") or 0)
            out = int(e.get("output_tokens") or 0)
            cr = int(e.get("credits") or 0)
            ml["input_tokens"] += inp
            ml["output_tokens"] += out
            ml["credits"] += cr
            t_in += inp
            t_out += out
            t_cr += cr

        turn_list: list[dict] = []
        for tr in turns.values():
            models, ti, to, tc = [], 0, 0, 0
            for model_id, ml in tr["models"].items():
                spec = self._catalog.get(model_id)
                models.append({
                    "model": model_id,
                    "label": spec.label if spec else model_id,
                    "input_tokens": ml["input_tokens"],
                    "output_tokens": ml["output_tokens"],
                    "credits": ml["credits"],
                    "rate_input": spec.credits_per_1k_input if spec else 0.0,
                    "rate_output": spec.credits_per_1k_output if spec else 0.0,
                })
                ti += ml["input_tokens"]
                to += ml["output_tokens"]
                tc += ml["credits"]
            models.sort(key=lambda x: x["credits"], reverse=True)
            turn_list.append({
                "turn_id": tr["turn_id"], "calls": tr["calls"],
                "input_tokens": ti, "output_tokens": to, "credits": tc, "models": models,
            })

        return {
            "meeting_id": meeting_id,
            "input_tokens": t_in, "output_tokens": t_out, "credits": t_cr,
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
