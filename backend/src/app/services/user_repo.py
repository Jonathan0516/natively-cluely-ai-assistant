import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

logger = logging.getLogger(__name__)


@dataclass
class User:
    id: str
    phone: str
    created_at: str
    last_login_at: str


class UserRepo(Protocol):
    async def upsert_by_phone(self, phone: str) -> User: ...
    async def get_by_id(self, user_id: str) -> User | None: ...


class InMemoryUserRepo:
    """Used when Supabase is not configured. State lives in process — resets on restart."""

    def __init__(self) -> None:
        self._by_phone: dict[str, User] = {}
        self._by_id: dict[str, User] = {}

    async def upsert_by_phone(self, phone: str) -> User:
        now = datetime.now(timezone.utc).isoformat()
        existing = self._by_phone.get(phone)
        if existing:
            updated = User(
                id=existing.id,
                phone=existing.phone,
                created_at=existing.created_at,
                last_login_at=now,
            )
        else:
            updated = User(id=str(uuid.uuid4()), phone=phone, created_at=now, last_login_at=now)
        self._by_phone[phone] = updated
        self._by_id[updated.id] = updated
        logger.info("InMemoryUserRepo upsert phone=%s id=%s", phone, updated.id)
        return updated

    async def get_by_id(self, user_id: str) -> User | None:
        return self._by_id.get(user_id)


class SupabaseUserRepo:
    """Backed by Supabase Postgres. Uses the service_role key to bypass RLS."""

    def __init__(self, url: str, service_role_key: str):
        from concurrent.futures import ThreadPoolExecutor

        from supabase import create_client

        self._client = create_client(url, service_role_key)
        # Serialize calls on this client — the sync supabase/httpx HTTP/2 connection is not safe
        # for concurrent cross-thread use (corrupts → "Server disconnected").
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="supabase-user")

    async def upsert_by_phone(self, phone: str) -> User:
        import asyncio

        def _upsert() -> dict:
            now = datetime.now(timezone.utc).isoformat()
            # Try insert; on conflict, update last_login_at.
            res = (
                self._client.table("users")
                .upsert({"phone": phone, "last_login_at": now}, on_conflict="phone")
                .execute()
            )
            return res.data[0]

        row = await asyncio.get_running_loop().run_in_executor(self._executor, _upsert)
        return User(
            id=row["id"],
            phone=row["phone"],
            created_at=row["created_at"],
            last_login_at=row["last_login_at"],
        )

    async def get_by_id(self, user_id: str) -> User | None:
        import asyncio

        from .supabase_retry import read_with_retry

        def _query() -> dict | None:
            res = self._client.table("users").select("*").eq("id", user_id).limit(1).execute()
            return res.data[0] if res.data else None

        row = await asyncio.get_running_loop().run_in_executor(
            self._executor, lambda: read_with_retry(_query)
        )
        if not row:
            return None
        return User(
            id=row["id"],
            phone=row["phone"],
            created_at=row["created_at"],
            last_login_at=row["last_login_at"],
        )
