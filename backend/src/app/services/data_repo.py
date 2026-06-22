"""Per-account cloud data store.

Backend-mediated replacement for the Electron app's local SQLite (`DatabaseManager`) and
sqlite-vec storage. Every method takes a `user_id` (derived server-side from the JWT) and
scopes its query to that user — this is where per-account isolation is enforced.

Two implementations:
- `SupabaseDataRepo` — production, backed by Supabase Postgres via the service-role key
  (bypasses RLS), mirroring `SupabaseUserRepo`.
- `InMemoryDataRepo` — dev/test fallback when Supabase is not configured. State lives in
  process and resets on restart. Vector search returns empty (RAG needs Supabase).

Rows are stored close to the original SQLite shape (e.g. `summary_json` as jsonb); the
Electron facade keeps its row→Meeting reshaping logic, so this layer stays mostly CRUD.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Protocol

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _vec_literal(embedding: list[float]) -> str:
    """pgvector text literal: [0.1,0.2,...]. Used for both inserts and RPC params."""
    return "[" + ",".join(repr(float(x)) for x in embedding) + "]"


# Default "General" mode + note sections, seeded lazily per user on first read.
_DEFAULT_MODE_ID = "mode_general_default"
_DEFAULT_NOTE_SECTIONS = [
    {"title": "Summary", "description": "High-level summary of the conversation."},
    {"title": "Action items", "description": "Tasks and follow-ups identified."},
    {"title": "Key points", "description": "Important points discussed."},
]


class DataRepo(Protocol):
    # meetings
    async def list_meetings(self, user_id: str, limit: int) -> list[dict]: ...
    async def list_unprocessed(self, user_id: str) -> list[dict]: ...
    async def get_meeting(self, user_id: str, meeting_id: str) -> dict | None: ...
    async def get_transcripts(self, user_id: str, meeting_id: str) -> list[dict]: ...
    async def get_ai_interactions(self, user_id: str, meeting_id: str) -> list[dict]: ...
    async def save_meeting(
        self, user_id: str, meeting: dict, transcripts: list[dict], ai_interactions: list[dict]
    ) -> None: ...
    async def update_meeting_title(self, user_id: str, meeting_id: str, title: str) -> bool: ...
    async def update_meeting_summary(self, user_id: str, meeting_id: str, updates: dict) -> bool: ...
    async def delete_meeting(self, user_id: str, meeting_id: str) -> bool: ...

    # embeddings
    async def upsert_chunks(self, user_id: str, meeting_id: str, chunks: list[dict]) -> None: ...
    async def chunks_exist(self, user_id: str, meeting_id: str) -> bool: ...
    async def upsert_summary(
        self, user_id: str, meeting_id: str, summary_text: str, dim: int | None, embedding: list[float] | None
    ) -> None: ...
    async def search_chunks(
        self, user_id: str, embedding: list[float], dim: int | None, meeting_id: str | None, limit: int, min_similarity: float
    ) -> list[dict]: ...
    async def search_summaries(
        self, user_id: str, embedding: list[float], dim: int | None, limit: int, min_similarity: float
    ) -> list[dict]: ...
    async def delete_embeddings(self, user_id: str, meeting_id: str) -> None: ...

    # modes
    async def get_modes(self, user_id: str) -> list[dict]: ...
    async def upsert_mode(self, user_id: str, mode: dict) -> None: ...
    async def update_mode(self, user_id: str, mode_id: str, updates: dict) -> None: ...
    async def delete_mode(self, user_id: str, mode_id: str) -> None: ...
    async def set_active_mode(self, user_id: str, mode_id: str | None) -> None: ...
    async def get_reference_files(self, user_id: str, mode_id: str) -> list[dict]: ...
    async def add_reference_file(self, user_id: str, file: dict) -> None: ...
    async def delete_reference_file(self, user_id: str, file_id: str) -> None: ...
    async def get_note_sections(self, user_id: str, mode_id: str) -> list[dict]: ...
    async def add_note_section(self, user_id: str, section: dict) -> None: ...
    async def update_note_section(self, user_id: str, section_id: str, updates: dict) -> None: ...
    async def delete_note_section(self, user_id: str, section_id: str) -> None: ...
    async def delete_all_note_sections(self, user_id: str, mode_id: str) -> None: ...

    # profile
    async def get_profile(self, user_id: str) -> dict | None: ...
    async def put_profile(self, user_id: str, fields: dict) -> dict: ...
    async def get_resume_nodes(self, user_id: str) -> list[dict]: ...
    async def replace_resume_nodes(self, user_id: str, nodes: list[dict]) -> None: ...

    # key/value
    async def get_settings(self, user_id: str) -> dict: ...
    async def put_settings(self, user_id: str, data: dict) -> dict: ...
    async def get_keybinds(self, user_id: str) -> list: ...
    async def put_keybinds(self, user_id: str, data: list) -> list: ...
    async def get_app_state(self, user_id: str, key: str) -> str | None: ...
    async def set_app_state(self, user_id: str, key: str, value: str) -> None: ...
    async def delete_app_state(self, user_id: str, key: str) -> None: ...


# --------------------------------------------------------------------------- #
# Supabase-backed implementation                                              #
# --------------------------------------------------------------------------- #


class SupabaseDataRepo:
    """Backed by Supabase Postgres. Uses the service_role key to bypass RLS."""

    def __init__(self, url: str, service_role_key: str):
        from supabase import create_client

        self._client = create_client(url, service_role_key)
        # The supabase sync client wraps a single httpx (HTTP/2) connection that is NOT safe for
        # concurrent use across threads — two in-flight requests on the same connection corrupt it
        # ("Server disconnected"). A dedicated single-worker executor serializes all calls on this
        # client while still keeping them off the event loop.
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="supabase-data")

    async def _run(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self._executor, fn, *args)

    async def _read(self, fn):
        """Like _run, but retries the stale-connection transport drops that postgrest's own
        retry misses (see supabase_retry). Reads only — never wrap writes."""
        from .supabase_retry import read_with_retry
        return await asyncio.get_running_loop().run_in_executor(
            self._executor, lambda: read_with_retry(fn)
        )

    # ---- meetings ---- #

    async def list_meetings(self, user_id: str, limit: int) -> list[dict]:
        def _q():
            res = (
                self._client.table("meetings")
                .select("*")
                .eq("user_id", user_id)
                .order("created_at", desc=True)
                .limit(limit)
                .execute()
            )
            return res.data or []

        return await self._read(_q)

    async def list_unprocessed(self, user_id: str) -> list[dict]:
        def _q():
            res = (
                self._client.table("meetings")
                .select("*")
                .eq("user_id", user_id)
                .eq("is_processed", False)
                .order("created_at", desc=True)
                .execute()
            )
            return res.data or []

        return await self._read(_q)

    async def get_meeting(self, user_id: str, meeting_id: str) -> dict | None:
        def _q():
            res = (
                self._client.table("meetings")
                .select("*")
                .eq("user_id", user_id)
                .eq("id", meeting_id)
                .limit(1)
                .execute()
            )
            return res.data[0] if res.data else None

        return await self._read(_q)

    async def get_transcripts(self, user_id: str, meeting_id: str) -> list[dict]:
        def _q():
            res = (
                self._client.table("transcripts")
                .select("*")
                .eq("user_id", user_id)
                .eq("meeting_id", meeting_id)
                .order("timestamp_ms")
                .execute()
            )
            return res.data or []

        return await self._read(_q)

    async def get_ai_interactions(self, user_id: str, meeting_id: str) -> list[dict]:
        def _q():
            res = (
                self._client.table("ai_interactions")
                .select("*")
                .eq("user_id", user_id)
                .eq("meeting_id", meeting_id)
                .order("timestamp")
                .execute()
            )
            return res.data or []

        return await self._read(_q)

    async def save_meeting(
        self, user_id: str, meeting: dict, transcripts: list[dict], ai_interactions: list[dict]
    ) -> None:
        def _save():
            row = {**meeting, "user_id": user_id}
            if row.get("created_at") is None:
                row.pop("created_at", None)  # let the column default (now()) apply
            self._client.table("meetings").upsert(row, on_conflict="id").execute()
            # Replace children for idempotency (re-save / reprocess shouldn't duplicate).
            mid = meeting["id"]
            self._client.table("transcripts").delete().eq("user_id", user_id).eq("meeting_id", mid).execute()
            self._client.table("ai_interactions").delete().eq("user_id", user_id).eq("meeting_id", mid).execute()
            if transcripts:
                self._client.table("transcripts").insert(
                    [{**t, "user_id": user_id, "meeting_id": mid} for t in transcripts]
                ).execute()
            if ai_interactions:
                self._client.table("ai_interactions").insert(
                    [{**a, "user_id": user_id, "meeting_id": mid} for a in ai_interactions]
                ).execute()

        await self._run(_save)

    async def update_meeting_title(self, user_id: str, meeting_id: str, title: str) -> bool:
        def _u():
            res = (
                self._client.table("meetings")
                .update({"title": title})
                .eq("user_id", user_id)
                .eq("id", meeting_id)
                .execute()
            )
            return bool(res.data)

        return await self._run(_u)

    async def update_meeting_summary(self, user_id: str, meeting_id: str, updates: dict) -> bool:
        def _u():
            res = (
                self._client.table("meetings")
                .select("summary_json")
                .eq("user_id", user_id)
                .eq("id", meeting_id)
                .limit(1)
                .execute()
            )
            if not res.data:
                return False
            existing = res.data[0].get("summary_json") or {}
            detailed = {**(existing.get("detailedSummary") or {}), **updates}
            new_summary = {**existing, "detailedSummary": detailed}
            upd = (
                self._client.table("meetings")
                .update({"summary_json": new_summary})
                .eq("user_id", user_id)
                .eq("id", meeting_id)
                .execute()
            )
            return bool(upd.data)

        return await self._run(_u)

    async def delete_meeting(self, user_id: str, meeting_id: str) -> bool:
        def _d():
            res = (
                self._client.table("meetings")
                .delete()
                .eq("user_id", user_id)
                .eq("id", meeting_id)
                .execute()
            )
            return bool(res.data)

        return await self._run(_d)

    # ---- embeddings ---- #

    async def upsert_chunks(self, user_id: str, meeting_id: str, chunks: list[dict]) -> None:
        def _u():
            # Append semantics: the client embeds and ships chunks incrementally (per-chunk for
            # live indexing). Clearing for re-index is explicit via delete_embeddings().
            if not chunks:
                return
            rows = []
            for c in chunks:
                row = {
                    "user_id": user_id,
                    "meeting_id": meeting_id,
                    "chunk_index": c["chunk_index"],
                    "speaker": c.get("speaker"),
                    "start_timestamp_ms": c.get("start_timestamp_ms"),
                    "end_timestamp_ms": c.get("end_timestamp_ms"),
                    "cleaned_text": c["cleaned_text"],
                    "token_count": c["token_count"],
                    "dim": c.get("dim"),
                    "embedding": _vec_literal(c["embedding"]) if c.get("embedding") else None,
                }
                rows.append(row)
            self._client.table("chunks").insert(rows).execute()

        await self._run(_u)

    async def upsert_summary(
        self, user_id: str, meeting_id: str, summary_text: str, dim: int | None, embedding: list[float] | None
    ) -> None:
        def _u():
            row = {
                "user_id": user_id,
                "meeting_id": meeting_id,
                "summary_text": summary_text,
                "dim": dim,
                "embedding": _vec_literal(embedding) if embedding else None,
            }
            self._client.table("chunk_summaries").upsert(row, on_conflict="user_id,meeting_id").execute()

        await self._run(_u)

    async def chunks_exist(self, user_id: str, meeting_id: str) -> bool:
        def _q():
            res = (
                self._client.table("chunks")
                .select("id")
                .eq("user_id", user_id)
                .eq("meeting_id", meeting_id)
                .not_.is_("embedding", "null")
                .limit(1)
                .execute()
            )
            return bool(res.data)

        return await self._read(_q)

    async def search_chunks(
        self, user_id: str, embedding: list[float], dim: int | None, meeting_id: str | None, limit: int, min_similarity: float
    ) -> list[dict]:
        def _s():
            res = self._client.rpc(
                "match_chunks",
                {
                    "p_user_id": user_id,
                    "p_query_embedding": _vec_literal(embedding),
                    "p_dim": dim,
                    "p_meeting_id": meeting_id,
                    "p_limit": limit,
                    "p_min_similarity": min_similarity,
                },
            ).execute()
            return res.data or []

        return await self._read(_s)

    async def search_summaries(
        self, user_id: str, embedding: list[float], dim: int | None, limit: int, min_similarity: float
    ) -> list[dict]:
        def _s():
            res = self._client.rpc(
                "match_chunk_summaries",
                {
                    "p_user_id": user_id,
                    "p_query_embedding": _vec_literal(embedding),
                    "p_dim": dim,
                    "p_limit": limit,
                    "p_min_similarity": min_similarity,
                },
            ).execute()
            return res.data or []

        return await self._read(_s)

    async def delete_embeddings(self, user_id: str, meeting_id: str) -> None:
        def _d():
            self._client.table("chunks").delete().eq("user_id", user_id).eq("meeting_id", meeting_id).execute()
            self._client.table("chunk_summaries").delete().eq("user_id", user_id).eq("meeting_id", meeting_id).execute()

        await self._run(_d)

    # ---- modes ---- #

    async def _seed_default_mode_if_empty(self, user_id: str) -> None:
        def _seed():
            existing = self._client.table("modes").select("id").eq("user_id", user_id).limit(1).execute()
            if existing.data:
                return
            self._client.table("modes").insert(
                {
                    "id": _DEFAULT_MODE_ID,
                    "user_id": user_id,
                    "name": "General",
                    "template_type": "general",
                    "custom_context": "",
                    "is_active": True,
                }
            ).execute()
            self._client.table("mode_note_sections").insert(
                [
                    {
                        "id": f"ns_general_{i}",
                        "user_id": user_id,
                        "mode_id": _DEFAULT_MODE_ID,
                        "title": s["title"],
                        "description": s["description"],
                        "sort_order": i,
                    }
                    for i, s in enumerate(_DEFAULT_NOTE_SECTIONS)
                ]
            ).execute()

        await self._run(_seed)

    async def get_modes(self, user_id: str) -> list[dict]:
        await self._seed_default_mode_if_empty(user_id)

        def _q():
            res = self._client.table("modes").select("*").eq("user_id", user_id).order("created_at").execute()
            return res.data or []

        return await self._read(_q)

    async def upsert_mode(self, user_id: str, mode: dict) -> None:
        def _u():
            self._client.table("modes").upsert({**mode, "user_id": user_id}, on_conflict="user_id,id").execute()

        await self._run(_u)

    async def update_mode(self, user_id: str, mode_id: str, updates: dict) -> None:
        def _u():
            self._client.table("modes").update(updates).eq("user_id", user_id).eq("id", mode_id).execute()

        await self._run(_u)

    async def delete_mode(self, user_id: str, mode_id: str) -> None:
        def _d():
            self._client.table("modes").delete().eq("user_id", user_id).eq("id", mode_id).execute()

        await self._run(_d)

    async def set_active_mode(self, user_id: str, mode_id: str | None) -> None:
        def _s():
            self._client.table("modes").update({"is_active": False}).eq("user_id", user_id).execute()
            if mode_id:
                self._client.table("modes").update({"is_active": True}).eq("user_id", user_id).eq("id", mode_id).execute()

        await self._run(_s)

    async def get_reference_files(self, user_id: str, mode_id: str) -> list[dict]:
        def _q():
            res = (
                self._client.table("mode_reference_files")
                .select("*")
                .eq("user_id", user_id)
                .eq("mode_id", mode_id)
                .order("created_at")
                .execute()
            )
            return res.data or []

        return await self._read(_q)

    async def add_reference_file(self, user_id: str, file: dict) -> None:
        def _a():
            self._client.table("mode_reference_files").insert({**file, "user_id": user_id}).execute()

        await self._run(_a)

    async def delete_reference_file(self, user_id: str, file_id: str) -> None:
        def _d():
            self._client.table("mode_reference_files").delete().eq("user_id", user_id).eq("id", file_id).execute()

        await self._run(_d)

    async def get_note_sections(self, user_id: str, mode_id: str) -> list[dict]:
        def _q():
            res = (
                self._client.table("mode_note_sections")
                .select("*")
                .eq("user_id", user_id)
                .eq("mode_id", mode_id)
                .order("sort_order")
                .execute()
            )
            return res.data or []

        return await self._read(_q)

    async def add_note_section(self, user_id: str, section: dict) -> None:
        def _a():
            self._client.table("mode_note_sections").insert({**section, "user_id": user_id}).execute()

        await self._run(_a)

    async def update_note_section(self, user_id: str, section_id: str, updates: dict) -> None:
        def _u():
            self._client.table("mode_note_sections").update(updates).eq("user_id", user_id).eq("id", section_id).execute()

        await self._run(_u)

    async def delete_note_section(self, user_id: str, section_id: str) -> None:
        def _d():
            self._client.table("mode_note_sections").delete().eq("user_id", user_id).eq("id", section_id).execute()

        await self._run(_d)

    async def delete_all_note_sections(self, user_id: str, mode_id: str) -> None:
        def _d():
            self._client.table("mode_note_sections").delete().eq("user_id", user_id).eq("mode_id", mode_id).execute()

        await self._run(_d)

    # ---- profile ---- #

    async def get_profile(self, user_id: str) -> dict | None:
        def _q():
            res = self._client.table("user_profile").select("*").eq("user_id", user_id).limit(1).execute()
            return res.data[0] if res.data else None

        return await self._read(_q)

    async def put_profile(self, user_id: str, fields: dict) -> dict:
        def _u():
            row = {**fields, "user_id": user_id, "updated_at": _now_iso()}
            res = self._client.table("user_profile").upsert(row, on_conflict="user_id").execute()
            return res.data[0] if res.data else row

        return await self._run(_u)

    async def get_resume_nodes(self, user_id: str) -> list[dict]:
        def _q():
            res = self._client.table("resume_nodes").select("*").eq("user_id", user_id).order("id").execute()
            return res.data or []

        return await self._read(_q)

    async def replace_resume_nodes(self, user_id: str, nodes: list[dict]) -> None:
        def _r():
            self._client.table("resume_nodes").delete().eq("user_id", user_id).execute()
            if nodes:
                rows = []
                for n in nodes:
                    row = {k: v for k, v in n.items() if k != "embedding"}
                    row["user_id"] = user_id
                    if n.get("embedding"):
                        row["embedding"] = _vec_literal(n["embedding"])
                    rows.append(row)
                self._client.table("resume_nodes").insert(rows).execute()

        await self._run(_r)

    # ---- key/value ---- #

    async def get_settings(self, user_id: str) -> dict:
        def _q():
            res = self._client.table("user_settings").select("data").eq("user_id", user_id).limit(1).execute()
            return res.data[0]["data"] if res.data else {}

        return await self._read(_q)

    async def put_settings(self, user_id: str, data: dict) -> dict:
        def _u():
            self._client.table("user_settings").upsert(
                {"user_id": user_id, "data": data, "updated_at": _now_iso()}, on_conflict="user_id"
            ).execute()
            return data

        return await self._run(_u)

    async def get_keybinds(self, user_id: str) -> list:
        def _q():
            res = self._client.table("user_keybinds").select("data").eq("user_id", user_id).limit(1).execute()
            return res.data[0]["data"] if res.data else []

        return await self._read(_q)

    async def put_keybinds(self, user_id: str, data: list) -> list:
        def _u():
            self._client.table("user_keybinds").upsert(
                {"user_id": user_id, "data": data, "updated_at": _now_iso()}, on_conflict="user_id"
            ).execute()
            return data

        return await self._run(_u)

    async def get_app_state(self, user_id: str, key: str) -> str | None:
        def _q():
            res = (
                self._client.table("user_app_state")
                .select("value")
                .eq("user_id", user_id)
                .eq("key", key)
                .limit(1)
                .execute()
            )
            return res.data[0]["value"] if res.data else None

        return await self._read(_q)

    async def set_app_state(self, user_id: str, key: str, value: str) -> None:
        def _s():
            self._client.table("user_app_state").upsert(
                {"user_id": user_id, "key": key, "value": value}, on_conflict="user_id,key"
            ).execute()

        await self._run(_s)

    async def delete_app_state(self, user_id: str, key: str) -> None:
        def _d():
            self._client.table("user_app_state").delete().eq("user_id", user_id).eq("key", key).execute()

        await self._run(_d)


# --------------------------------------------------------------------------- #
# In-memory implementation (dev / tests, no Supabase)                          #
# --------------------------------------------------------------------------- #


class InMemoryDataRepo:
    """Process-local store for dev when Supabase is not configured. Vector search is a no-op."""

    def __init__(self) -> None:
        self._meetings: dict[str, dict[str, dict]] = {}          # user -> id -> meeting row
        self._chunks: dict[str, dict[str, list[dict]]] = {}       # user -> meeting_id -> chunk rows
        self._transcripts: dict[str, dict[str, list[dict]]] = {}  # user -> meeting_id -> rows
        self._interactions: dict[str, dict[str, list[dict]]] = {}
        self._modes: dict[str, dict[str, dict]] = {}
        self._ref_files: dict[str, list[dict]] = {}
        self._note_sections: dict[str, list[dict]] = {}
        self._profile: dict[str, dict] = {}
        self._resume: dict[str, list[dict]] = {}
        self._settings: dict[str, dict] = {}
        self._keybinds: dict[str, list] = {}
        self._app_state: dict[str, dict[str, str]] = {}

    # meetings
    async def list_meetings(self, user_id: str, limit: int) -> list[dict]:
        rows = list(self._meetings.get(user_id, {}).values())
        rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
        return copy.deepcopy(rows[:limit])

    async def list_unprocessed(self, user_id: str) -> list[dict]:
        rows = [r for r in self._meetings.get(user_id, {}).values() if not r.get("is_processed", True)]
        rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
        return copy.deepcopy(rows)

    async def get_meeting(self, user_id: str, meeting_id: str) -> dict | None:
        return copy.deepcopy(self._meetings.get(user_id, {}).get(meeting_id))

    async def get_transcripts(self, user_id: str, meeting_id: str) -> list[dict]:
        return copy.deepcopy(self._transcripts.get(user_id, {}).get(meeting_id, []))

    async def get_ai_interactions(self, user_id: str, meeting_id: str) -> list[dict]:
        return copy.deepcopy(self._interactions.get(user_id, {}).get(meeting_id, []))

    async def save_meeting(self, user_id: str, meeting: dict, transcripts: list[dict], ai_interactions: list[dict]) -> None:
        mid = meeting["id"]
        self._meetings.setdefault(user_id, {})[mid] = {**meeting, "user_id": user_id}
        self._transcripts.setdefault(user_id, {})[mid] = [dict(t) for t in transcripts]
        self._interactions.setdefault(user_id, {})[mid] = [dict(a) for a in ai_interactions]

    async def update_meeting_title(self, user_id: str, meeting_id: str, title: str) -> bool:
        m = self._meetings.get(user_id, {}).get(meeting_id)
        if not m:
            return False
        m["title"] = title
        return True

    async def update_meeting_summary(self, user_id: str, meeting_id: str, updates: dict) -> bool:
        m = self._meetings.get(user_id, {}).get(meeting_id)
        if not m:
            return False
        existing = m.get("summary_json") or {}
        detailed = {**(existing.get("detailedSummary") or {}), **updates}
        m["summary_json"] = {**existing, "detailedSummary": detailed}
        return True

    async def delete_meeting(self, user_id: str, meeting_id: str) -> bool:
        removed = self._meetings.get(user_id, {}).pop(meeting_id, None)
        self._transcripts.get(user_id, {}).pop(meeting_id, None)
        self._interactions.get(user_id, {}).pop(meeting_id, None)
        return removed is not None

    # embeddings (no real vector search in dev; tracks presence for chunks_exist)
    async def upsert_chunks(self, user_id: str, meeting_id: str, chunks: list[dict]) -> None:
        bucket = self._chunks.setdefault(user_id, {}).setdefault(meeting_id, [])
        bucket.extend(chunks)

    async def chunks_exist(self, user_id: str, meeting_id: str) -> bool:
        return any(c.get("embedding") for c in self._chunks.get(user_id, {}).get(meeting_id, []))

    async def upsert_summary(self, user_id, meeting_id, summary_text, dim, embedding) -> None:
        return None

    async def search_chunks(self, user_id, embedding, dim, meeting_id, limit, min_similarity) -> list[dict]:
        return []

    async def search_summaries(self, user_id, embedding, dim, limit, min_similarity) -> list[dict]:
        return []

    async def delete_embeddings(self, user_id: str, meeting_id: str) -> None:
        self._chunks.get(user_id, {}).pop(meeting_id, None)

    # modes
    def _ensure_default_mode(self, user_id: str) -> None:
        if self._modes.get(user_id):
            return
        self._modes.setdefault(user_id, {})[_DEFAULT_MODE_ID] = {
            "id": _DEFAULT_MODE_ID,
            "user_id": user_id,
            "name": "General",
            "template_type": "general",
            "custom_context": "",
            "is_active": True,
            "created_at": _now_iso(),
        }
        self._note_sections.setdefault(user_id, [])
        for i, s in enumerate(_DEFAULT_NOTE_SECTIONS):
            self._note_sections[user_id].append(
                {
                    "id": f"ns_general_{i}",
                    "user_id": user_id,
                    "mode_id": _DEFAULT_MODE_ID,
                    "title": s["title"],
                    "description": s["description"],
                    "sort_order": i,
                }
            )

    async def get_modes(self, user_id: str) -> list[dict]:
        self._ensure_default_mode(user_id)
        return copy.deepcopy(list(self._modes.get(user_id, {}).values()))

    async def upsert_mode(self, user_id: str, mode: dict) -> None:
        self._modes.setdefault(user_id, {})[mode["id"]] = {**mode, "user_id": user_id, "created_at": _now_iso()}

    async def update_mode(self, user_id: str, mode_id: str, updates: dict) -> None:
        m = self._modes.get(user_id, {}).get(mode_id)
        if m:
            m.update(updates)

    async def delete_mode(self, user_id: str, mode_id: str) -> None:
        self._modes.get(user_id, {}).pop(mode_id, None)

    async def set_active_mode(self, user_id: str, mode_id: str | None) -> None:
        for m in self._modes.get(user_id, {}).values():
            m["is_active"] = m["id"] == mode_id

    async def get_reference_files(self, user_id: str, mode_id: str) -> list[dict]:
        return [f for f in self._ref_files.get(user_id, []) if f["mode_id"] == mode_id]

    async def add_reference_file(self, user_id: str, file: dict) -> None:
        self._ref_files.setdefault(user_id, []).append({**file, "user_id": user_id})

    async def delete_reference_file(self, user_id: str, file_id: str) -> None:
        self._ref_files[user_id] = [f for f in self._ref_files.get(user_id, []) if f["id"] != file_id]

    async def get_note_sections(self, user_id: str, mode_id: str) -> list[dict]:
        rows = [s for s in self._note_sections.get(user_id, []) if s["mode_id"] == mode_id]
        rows.sort(key=lambda s: s.get("sort_order", 0))
        return copy.deepcopy(rows)

    async def add_note_section(self, user_id: str, section: dict) -> None:
        self._note_sections.setdefault(user_id, []).append({**section, "user_id": user_id})

    async def update_note_section(self, user_id: str, section_id: str, updates: dict) -> None:
        for s in self._note_sections.get(user_id, []):
            if s["id"] == section_id:
                s.update(updates)

    async def delete_note_section(self, user_id: str, section_id: str) -> None:
        self._note_sections[user_id] = [s for s in self._note_sections.get(user_id, []) if s["id"] != section_id]

    async def delete_all_note_sections(self, user_id: str, mode_id: str) -> None:
        self._note_sections[user_id] = [s for s in self._note_sections.get(user_id, []) if s["mode_id"] != mode_id]

    # profile
    async def get_profile(self, user_id: str) -> dict | None:
        return copy.deepcopy(self._profile.get(user_id))

    async def put_profile(self, user_id: str, fields: dict) -> dict:
        cur = self._profile.get(user_id, {})
        cur.update({**fields, "user_id": user_id, "updated_at": _now_iso()})
        self._profile[user_id] = cur
        return copy.deepcopy(cur)

    async def get_resume_nodes(self, user_id: str) -> list[dict]:
        return copy.deepcopy(self._resume.get(user_id, []))

    async def replace_resume_nodes(self, user_id: str, nodes: list[dict]) -> None:
        self._resume[user_id] = [dict(n) for n in nodes]

    # key/value
    async def get_settings(self, user_id: str) -> dict:
        return copy.deepcopy(self._settings.get(user_id, {}))

    async def put_settings(self, user_id: str, data: dict) -> dict:
        self._settings[user_id] = dict(data)
        return data

    async def get_keybinds(self, user_id: str) -> list:
        return copy.deepcopy(self._keybinds.get(user_id, []))

    async def put_keybinds(self, user_id: str, data: list) -> list:
        self._keybinds[user_id] = list(data)
        return data

    async def get_app_state(self, user_id: str, key: str) -> str | None:
        return self._app_state.get(user_id, {}).get(key)

    async def set_app_state(self, user_id: str, key: str, value: str) -> None:
        self._app_state.setdefault(user_id, {})[key] = value

    async def delete_app_state(self, user_id: str, key: str) -> None:
        self._app_state.get(user_id, {}).pop(key, None)
