# backend/src/app/services/usage_repo.py
"""Usage events + per-user plan assignment. Mirrors the data_repo dual-impl pattern:
InMemoryUsageRepo for dev/test, SupabaseUsageRepo for prod (service-role key)."""
from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Protocol

from .model_catalog import DEFAULT_PLAN

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class UsageRepo(Protocol):
    async def record_event(
        self, user_id: str, *, kind: str, model: str,
        input_tokens: int = 0, output_tokens: int = 0, audio_seconds: float = 0.0, credits: int = 0,
        meeting_id: str | None = None, turn_id: str | None = None,
    ) -> None: ...
    async def credits_used_since(self, user_id: str, since: str) -> int: ...
    async def list_events_since(self, user_id: str, since: str) -> list[dict]: ...
    async def events_for_meeting(self, user_id: str, meeting_id: str) -> list[dict]: ...
    async def get_subscription(self, user_id: str) -> tuple[str, str | None]: ...
    async def set_plan(self, user_id: str, plan_id: str) -> None: ...


class InMemoryUsageRepo:
    def __init__(self) -> None:
        self._events: list[dict] = []
        self._plans: dict[str, str] = {}
        self._period_start: dict[str, str] = {}

    async def record_event(self, user_id, *, kind, model, input_tokens=0, output_tokens=0,
                           audio_seconds=0.0, credits=0, meeting_id=None, turn_id=None) -> None:
        self._events.append({
            "user_id": user_id, "kind": kind, "model": model,
            "input_tokens": input_tokens, "output_tokens": output_tokens,
            "audio_seconds": audio_seconds, "credits": credits,
            "meeting_id": meeting_id, "turn_id": turn_id, "created_at": _now_iso(),
        })

    async def credits_used_since(self, user_id, since) -> int:
        return sum(
            e["credits"] for e in self._events
            if e["user_id"] == user_id and e["created_at"] >= since
        )

    async def list_events_since(self, user_id, since) -> list[dict]:
        return [
            e for e in self._events
            if e["user_id"] == user_id and e["created_at"] >= since
        ]

    async def events_for_meeting(self, user_id, meeting_id) -> list[dict]:
        return [
            e for e in self._events
            if e["user_id"] == user_id and e.get("meeting_id") == meeting_id
        ]

    async def get_subscription(self, user_id) -> tuple[str, str | None]:
        return self._plans.get(user_id, DEFAULT_PLAN), self._period_start.get(user_id)

    async def set_plan(self, user_id, plan_id) -> None:
        self._plans[user_id] = plan_id
        self._period_start.setdefault(user_id, _now_iso())


class SupabaseUsageRepo:
    """Prod impl. Uses the supabase service-role client like SupabaseUserRepo."""
    def __init__(self, url: str, service_role_key: str) -> None:
        from supabase import create_client
        self._db = create_client(url, service_role_key)
        # The sync client wraps one httpx (HTTP/2) connection that is not safe for concurrent
        # use, and its blocking .execute() must stay off the event loop. A dedicated single-worker
        # executor serializes calls on this client while keeping them off the loop. (Mirrors
        # SupabaseDataRepo — see data_repo.py.)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="supabase-usage")

    async def _run(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self._executor, fn, *args)

    async def record_event(self, user_id, *, kind, model, input_tokens=0, output_tokens=0,
                           audio_seconds=0.0, credits=0, meeting_id=None, turn_id=None) -> None:
        def _q():
            self._db.table("usage_events").insert({
                "user_id": user_id, "kind": kind, "model": model,
                "input_tokens": input_tokens, "output_tokens": output_tokens,
                "audio_seconds": audio_seconds, "credits": credits,
                "meeting_id": meeting_id, "turn_id": turn_id,
            }).execute()
        await self._run(_q)

    async def credits_used_since(self, user_id, since) -> int:
        def _q():
            res = (
                self._db.table("usage_events").select("credits")
                .eq("user_id", user_id).gte("created_at", since).execute()
            )
            return sum(int(r["credits"]) for r in (res.data or []))
        return await self._run(_q)

    async def list_events_since(self, user_id, since) -> list[dict]:
        def _q():
            res = (
                self._db.table("usage_events")
                .select("meeting_id, turn_id, kind, model, input_tokens, output_tokens, "
                        "audio_seconds, credits, created_at")
                .eq("user_id", user_id).gte("created_at", since)
                .order("created_at", desc=True).execute()
            )
            return res.data or []
        return await self._run(_q)

    async def events_for_meeting(self, user_id, meeting_id) -> list[dict]:
        def _q():
            res = (
                self._db.table("usage_events")
                .select("turn_id, kind, model, input_tokens, output_tokens, "
                        "audio_seconds, credits, created_at")
                .eq("user_id", user_id).eq("meeting_id", meeting_id)
                .order("created_at", desc=False).execute()
            )
            return res.data or []
        return await self._run(_q)

    async def get_subscription(self, user_id) -> tuple[str, str | None]:
        """Plan id + period anchor for the user in a single round-trip."""
        def _q():
            res = (
                self._db.table("user_subscriptions").select("plan_id, period_start")
                .eq("user_id", user_id).limit(1).execute()
            )
            rows = res.data or []
            if not rows:
                return DEFAULT_PLAN, None
            return rows[0].get("plan_id") or DEFAULT_PLAN, rows[0].get("period_start")
        return await self._run(_q)

    async def set_plan(self, user_id, plan_id) -> None:
        def _q():
            self._db.table("user_subscriptions").upsert(
                {"user_id": user_id, "plan_id": plan_id, "updated_at": _now_iso()}
            ).execute()
        await self._run(_q)
