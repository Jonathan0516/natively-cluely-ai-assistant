# backend/src/app/services/usage_repo.py
"""Usage events + per-user plan assignment. Mirrors the data_repo dual-impl pattern:
InMemoryUsageRepo for dev/test, SupabaseUsageRepo for prod (service-role key)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Protocol

from .model_catalog import DEFAULT_PLAN

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class UsageRepo(Protocol):
    async def record_event(
        self, user_id: str, *, kind: str, model: str,
        input_tokens: int = 0, output_tokens: int = 0, audio_seconds: float = 0.0, credits: int = 0,
    ) -> None: ...
    async def credits_used_since(self, user_id: str, since: str) -> int: ...
    async def get_plan_id(self, user_id: str) -> str: ...
    async def set_plan(self, user_id: str, plan_id: str) -> None: ...
    async def get_period_start(self, user_id: str) -> str | None: ...


class InMemoryUsageRepo:
    def __init__(self) -> None:
        self._events: list[dict] = []
        self._plans: dict[str, str] = {}
        self._period_start: dict[str, str] = {}

    async def record_event(self, user_id, *, kind, model, input_tokens=0, output_tokens=0,
                           audio_seconds=0.0, credits=0) -> None:
        self._events.append({
            "user_id": user_id, "kind": kind, "model": model,
            "input_tokens": input_tokens, "output_tokens": output_tokens,
            "audio_seconds": audio_seconds, "credits": credits, "created_at": _now_iso(),
        })

    async def credits_used_since(self, user_id, since) -> int:
        return sum(
            e["credits"] for e in self._events
            if e["user_id"] == user_id and e["created_at"] >= since
        )

    async def get_plan_id(self, user_id) -> str:
        return self._plans.get(user_id, DEFAULT_PLAN)

    async def set_plan(self, user_id, plan_id) -> None:
        self._plans[user_id] = plan_id
        self._period_start.setdefault(user_id, _now_iso())

    async def get_period_start(self, user_id) -> str | None:
        return self._period_start.get(user_id)


class SupabaseUsageRepo:
    """Prod impl. Uses the supabase service-role client like SupabaseUserRepo."""
    def __init__(self, url: str, service_role_key: str) -> None:
        from supabase import create_client
        self._db = create_client(url, service_role_key)

    async def record_event(self, user_id, *, kind, model, input_tokens=0, output_tokens=0,
                           audio_seconds=0.0, credits=0) -> None:
        self._db.table("usage_events").insert({
            "user_id": user_id, "kind": kind, "model": model,
            "input_tokens": input_tokens, "output_tokens": output_tokens,
            "audio_seconds": audio_seconds, "credits": credits,
        }).execute()

    async def credits_used_since(self, user_id, since) -> int:
        res = (
            self._db.table("usage_events").select("credits")
            .eq("user_id", user_id).gte("created_at", since).execute()
        )
        return sum(int(r["credits"]) for r in (res.data or []))

    async def get_plan_id(self, user_id) -> str:
        res = (
            self._db.table("user_subscriptions").select("plan_id")
            .eq("user_id", user_id).limit(1).execute()
        )
        rows = res.data or []
        return rows[0]["plan_id"] if rows else DEFAULT_PLAN

    async def set_plan(self, user_id, plan_id) -> None:
        self._db.table("user_subscriptions").upsert(
            {"user_id": user_id, "plan_id": plan_id, "updated_at": _now_iso()}
        ).execute()

    async def get_period_start(self, user_id) -> str | None:
        res = (
            self._db.table("user_subscriptions").select("period_start")
            .eq("user_id", user_id).limit(1).execute()
        )
        rows = res.data or []
        return rows[0]["period_start"] if rows else None
