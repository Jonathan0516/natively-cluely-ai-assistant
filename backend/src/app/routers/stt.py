# backend/src/app/routers/stt.py
"""Metered STT gateway: WS /llm/stt. Auth (JWT query param) → quota → reverse-proxy Deepgram."""
from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Annotated

import jwt as pyjwt
from fastapi import APIRouter, Depends, WebSocket

from ..deps import get_jwt_service, get_stt_upstream, get_usage_meter, get_user_repo
from ..services.jwt_service import JwtService
from ..services.llm_types import Usage
from ..services.model_catalog import CATALOG
from ..services.stt_relay import DeepgramUpstream, audio_seconds_for
from ..services.usage_meter import UsageMeter
from ..services.user_repo import User, UserRepo

logger = logging.getLogger(__name__)
router = APIRouter(tags=["stt"])

STT_SPEC_ID = "stt-default"
QUOTA_RECHECK_SECONDS = 30.0


async def _authenticate(websocket: WebSocket, jwt_svc: JwtService, repo: UserRepo) -> User | None:
    token = websocket.query_params.get("token")
    if not token:
        return None
    try:
        payload = jwt_svc.verify(token, expected_type="access")
    except pyjwt.PyJWTError:
        return None
    return await repo.get_by_id(payload["sub"])


@router.websocket("/llm/stt")
async def llm_stt(
    websocket: WebSocket,
    jwt_svc: Annotated[JwtService, Depends(get_jwt_service)],
    repo: Annotated[UserRepo, Depends(get_user_repo)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
    upstream_factory: Annotated[DeepgramUpstream, Depends(get_stt_upstream)],
) -> None:
    await websocket.accept()
    user = await _authenticate(websocket, jwt_svc, repo)
    if user is None:
        await websocket.close(code=4401)
        return
    if (await meter.status(user.id)).exhausted:
        await websocket.close(code=4029)
        return

    qp = websocket.query_params
    sample_rate = int(qp.get("sample_rate", "16000"))
    channels = int(qp.get("channels", "1"))
    params = {
        "encoding": qp.get("encoding", "linear16"),
        "sample_rate": str(sample_rate),
        "channels": str(channels),
        "model": qp.get("model", "nova-2"),
        "interim_results": qp.get("interim_results", "true"),
    }
    if qp.get("language"):
        params["language"] = qp["language"]

    upstream = await upstream_factory.connect(params)
    spec = CATALOG[STT_SPEC_ID]
    total_bytes = 0
    last_checked = 0.0

    async def pump_up() -> None:
        nonlocal total_bytes, last_checked
        with contextlib.suppress(Exception):
            while True:
                data = await websocket.receive_bytes()
                total_bytes += len(data)
                await upstream.send(data)
                secs = audio_seconds_for(total_bytes, sample_rate, channels)
                if secs - last_checked >= QUOTA_RECHECK_SECONDS:
                    last_checked = secs
                    if (await meter.status(user.id)).exhausted:
                        await websocket.close(code=4029)
                        return

    async def pump_down() -> None:
        with contextlib.suppress(Exception):
            async for transcript in upstream:
                await websocket.send_text(transcript)

    up_task = asyncio.create_task(pump_up())
    down_task = asyncio.create_task(pump_down())
    try:
        await asyncio.wait({up_task, down_task}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in (up_task, down_task):
            t.cancel()
        with contextlib.suppress(Exception):
            await upstream.close()
        secs = audio_seconds_for(total_bytes, sample_rate, channels)
        if secs > 0:
            await meter.record(user.id, kind="stt", spec=spec, usage=Usage(), audio_seconds=secs)
        with contextlib.suppress(Exception):
            await websocket.close()
