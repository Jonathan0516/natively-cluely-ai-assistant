# backend/src/app/services/usage_meter.py
"""Quota enforcement + usage recording. Stateless over UsageRepo + catalog/plans."""
from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

from .llm_types import QuotaExceeded, QuotaStatus, Usage
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
        plan_id = await self._repo.get_plan_id(user_id)
        plan = self._plans.get(plan_id, self._plans["free"])
        anchor = await self._repo.get_period_start(user_id)
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
                     audio_seconds: float = 0.0) -> int:
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
        )
        return credits

    def plan_allowed_tiers(self, plan_id: str) -> tuple[str, ...]:
        plan = self._plans.get(plan_id, self._plans["free"])
        return plan.allowed_tiers
