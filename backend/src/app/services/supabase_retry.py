"""Retry helper for the Supabase sync client's long-lived HTTP/2 connection.

The sync supabase/postgrest client keeps one keep-alive connection per repo. When that
connection goes stale (server/Cloudflare closes it on idle, or it hits its max requests), the
next ``.execute()`` reuses the dead socket and httpx raises a *transport* error before any
response arrives. Postgrest's own ``send_with_retry`` only covers 503/520 *responses*, so it
does not help here and the error surfaces as a 500. httpx evicts the failed connection from the
pool, so an immediate retry runs on a fresh one and succeeds.

Use this for READ calls only. Retrying a write could double-apply a non-idempotent insert
(e.g. a ``usage_events`` row → double-billed credits)."""
from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import TypeVar

import httpx

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Transport-level failures that mean the connection died before the server answered. Safe to
# retry for reads because the query never produced a result.
_TRANSIENT = (
    httpx.RemoteProtocolError,
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadError,
    httpx.WriteError,
    httpx.PoolTimeout,
)


def read_with_retry(fn: Callable[[], T], *, attempts: int = 3, base_delay: float = 0.05) -> T:
    """Call ``fn`` (a blocking supabase read), retrying transient transport disconnects with
    exponential backoff. The dead connection is dropped from the pool after a failure, so the
    next attempt gets a fresh one. Non-transport errors (e.g. APIError) propagate immediately."""
    last: BaseException | None = None
    for attempt in range(attempts):
        try:
            return fn()
        except _TRANSIENT as exc:
            last = exc
            logger.warning(
                "supabase read transport error (attempt %d/%d): %s", attempt + 1, attempts, exc
            )
            if attempt < attempts - 1:
                time.sleep(base_delay * (2 ** attempt))
    assert last is not None  # loop runs at least once; only reached after exhausting attempts
    raise last
