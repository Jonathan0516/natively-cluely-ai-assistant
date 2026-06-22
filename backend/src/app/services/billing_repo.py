"""Persistent purchased-credit wallet + ledger. Mirrors usage_repo's dual-impl pattern:
InMemoryBillingRepo for dev/test, SupabaseBillingRepo (service-role RPC) for prod.

The wallet is the sole credit source (plan free allowance is 0). `grant_credits` is the
webhook entry point (idempotent by Stripe event id); `consume_credits` is called by the
usage meter for per-call overflow beyond the free allowance."""
from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

logger = logging.getLogger(__name__)


class BillingRepo(Protocol):
    async def grant_credits(self, user_id: str, credits: int, event_id: str) -> bool: ...
    async def consume_credits(self, user_id: str, amount: int) -> None: ...
    async def get_balance(self, user_id: str) -> int: ...


class InMemoryBillingRepo:
    def __init__(self) -> None:
        self._balance: dict[str, int] = {}
        self._seen_events: set[str] = set()

    async def grant_credits(self, user_id: str, credits: int, event_id: str) -> bool:
        if event_id in self._seen_events:
            return False
        self._seen_events.add(event_id)
        self._balance[user_id] = self._balance.get(user_id, 0) + credits
        return True

    async def consume_credits(self, user_id: str, amount: int) -> None:
        self._balance[user_id] = max(0, self._balance.get(user_id, 0) - amount)

    async def get_balance(self, user_id: str) -> int:
        return self._balance.get(user_id, 0)


class SupabaseBillingRepo:
    """Prod impl. Atomic wallet mutation runs in Postgres functions (grant_credits /
    consume_credits) so concurrent webhook + usage paths can't lose updates."""
    def __init__(self, url: str, service_role_key: str) -> None:
        from supabase import create_client
        self._db = create_client(url, service_role_key)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="supabase-billing")

    async def _run(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self._executor, fn, *args)

    async def grant_credits(self, user_id: str, credits: int, event_id: str) -> bool:
        def _q():
            res = self._db.rpc(
                "grant_credits",
                {"p_user": user_id, "p_credits": credits, "p_event": event_id},
            ).execute()
            return bool(res.data)
        return await self._run(_q)

    async def consume_credits(self, user_id: str, amount: int) -> None:
        def _q():
            self._db.rpc(
                "consume_credits", {"p_user": user_id, "p_amount": amount}
            ).execute()
        await self._run(_q)

    async def get_balance(self, user_id: str) -> int:
        def _q():
            res = (
                self._db.table("credit_wallets").select("balance")
                .eq("user_id", user_id).limit(1).execute()
            )
            rows = res.data or []
            return int(rows[0]["balance"]) if rows else 0
        return await self._run(_q)
