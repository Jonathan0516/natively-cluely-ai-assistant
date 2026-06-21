"""Measure real TTFT (time-to-first-token) for each text model in the catalog.

Streams a short completion straight to each provider's OpenAI-compat endpoint using the
platform keys from backend/.env (bypasses the gateway/auth so we measure raw upstream TTFT,
which is exactly what ModelSpec.latency_hint advertises). Runs each model a few times and
reports the best (min) TTFT to cut cold-connection noise.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time

sys.path.insert(0, "src")

import httpx

from app.config import get_settings
from app.services.model_catalog import CATALOG

RUNS = 2
PROMPT = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Reply with a single short sentence."},
]


async def measure_one(client: httpx.AsyncClient, spec, key: str) -> tuple[float, float, float]:
    """Returns (t_first_any, t_first_content, total) in seconds.

    For plain models t_first_any == t_first_content. For reasoning models (DeepSeek-V4)
    t_first_any is the first `reasoning_content` token and t_first_content is the first real
    `content` token — the latter is what the user perceives today, since the gateway provider
    forwards only `content`. max_tokens is high enough that reasoning models reach content.
    Retries once on 429 with a short backoff.
    """
    body = {
        "model": spec.upstream_model,
        "messages": PROMPT,
        "max_tokens": 256,
        "stream": True,
        **spec.extra_params,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    for attempt in range(2):
        t0 = time.perf_counter()
        t_any = t_content = None
        async with client.stream(
            "POST", f"{spec.base_url}/chat/completions", json=body, headers=headers
        ) as resp:
            if resp.status_code == 429 and attempt == 0:
                await resp.aclose()
                await asyncio.sleep(3.0)
                continue
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0].get("delta", {}) or {}
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                now = time.perf_counter() - t0
                if t_any is None and (delta.get("content") or delta.get("reasoning_content")):
                    t_any = now
                if t_content is None and delta.get("content"):
                    t_content = now
                    break  # content has started; that's all we need
        total = time.perf_counter() - t0
        if t_content is None:
            raise RuntimeError("no content delta within max_tokens")
        return t_any if t_any is not None else t_content, t_content, total
    raise RuntimeError("429 after retry")


async def main() -> None:
    settings = get_settings()
    specs = [s for s in CATALOG.values() if "text" in s.capabilities]
    rows: list[tuple] = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(90.0, connect=10.0)) as client:
        for spec in specs:
            key = getattr(settings, spec.key_env, "")
            if not key:
                rows.append((spec, None, None, f"SKIP (no {spec.key_env})"))
                print(f"  {spec.id:20s} SKIP — {spec.key_env} not set")
                continue
            anys: list[float] = []
            contents: list[float] = []
            note = ""
            for _ in range(RUNS):
                try:
                    t_any, t_content, _total = await measure_one(client, spec, key)
                    anys.append(t_any)
                    contents.append(t_content)
                except Exception as exc:  # noqa: BLE001 — report, keep going
                    note = f"{type(exc).__name__}: {str(exc)[:60]}"
                    break
            if contents:
                ba, bc = min(anys), min(contents)
                reasoner = bc - ba > 0.05
                tag = f"  (reasoning: 1st token {ba:.2f}s → content {bc:.2f}s)" if reasoner else ""
                rows.append((spec, ba, bc, note))
                print(f"  {spec.id:20s} content-TTFT {bc:.2f}s{tag}")
            else:
                rows.append((spec, None, None, note))
                print(f"  {spec.id:20s} ERROR — {note}")

    print("\n" + "=" * 86)
    print(f"{'model id':20s} {'upstream':30s} {'hint':>7s} {'1st-any':>8s} {'content':>8s}")
    print("-" * 86)
    for spec, t_any, t_content, note in rows:
        if t_content is None:
            print(f"{spec.id:20s} {spec.upstream_model:30s} {spec.latency_hint:>7s}   {note}")
            continue
        print(f"{spec.id:20s} {spec.upstream_model:30s} {spec.latency_hint:>7s} "
              f"{t_any:>7.2f}s {t_content:>7.2f}s")


if __name__ == "__main__":
    asyncio.run(main())
