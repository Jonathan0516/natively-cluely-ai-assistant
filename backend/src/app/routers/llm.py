# backend/src/app/routers/llm.py
"""Metered LLM gateway endpoints. Auth (JWT) → quota check → gateway → record usage."""
from __future__ import annotations

import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..deps import get_current_user, get_llm_gateway, get_usage_meter
from ..services.llm_gateway import LLMGateway
from ..services.llm_types import ChatMessage, NoModelAvailable, QuotaExceeded
from ..services.model_catalog import CATALOG
from ..services.usage_meter import UsageMeter
from ..services.user_repo import User

router = APIRouter(prefix="/llm", tags=["llm"])


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str
    messages: list[Message]
    images: list[str] = []
    max_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None

    def to_messages(self) -> list[ChatMessage]:
        return [ChatMessage(role=m.role, content=m.content) for m in self.messages]

    def to_params(self) -> dict:
        p: dict = {}
        if self.max_tokens is not None:
            p["max_tokens"] = self.max_tokens
        if self.temperature is not None:
            p["temperature"] = self.temperature
        if self.top_p is not None:
            p["top_p"] = self.top_p
        return p


def _quota_detail(exc: QuotaExceeded) -> dict:
    s = exc.status
    return {"error": "quota_exceeded", "credits_remaining": s.credits_remaining,
            "credits_total": s.credits_total, "plan": s.plan}


@router.post("/json")
async def llm_json(
    body: ChatRequest,
    user: Annotated[User, Depends(get_current_user)],
    gateway: Annotated[LLMGateway, Depends(get_llm_gateway)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> dict:
    try:
        await meter.check(user.id)
    except QuotaExceeded as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, _quota_detail(exc)) from exc
    try:
        spec, res = await gateway.generate_json(body.model, body.to_messages(), body.to_params())
    except NoModelAvailable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    await meter.record(user.id, kind="json", spec=spec, usage=res.usage)
    return {"text": res.text, "model": spec.id}


@router.post("/chat")
async def llm_chat(
    body: ChatRequest,
    user: Annotated[User, Depends(get_current_user)],
    gateway: Annotated[LLMGateway, Depends(get_llm_gateway)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
):
    # Quota + model resolution happen BEFORE we start streaming, so failures are real HTTP codes.
    try:
        await meter.check(user.id)
    except QuotaExceeded as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, _quota_detail(exc)) from exc
    try:
        gateway.resolve(body.model)
    except NoModelAvailable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    async def event_stream():
        from ..services.llm_types import Usage
        used_spec = None
        usage = Usage()
        try:
            async for spec, delta in gateway.stream_chat(
                body.model, body.to_messages(), body.images, body.to_params()
            ):
                used_spec = spec
                if delta.text:
                    yield f"data: {json.dumps({'delta': delta.text})}\n\n"
                if delta.usage:
                    usage = delta.usage
        except NoModelAvailable as exc:
            yield f"data: {json.dumps({'error': {'code': 'no_model', 'message': str(exc)}})}\n\n"
        finally:
            if used_spec is not None:
                await meter.record(user.id, kind="chat", spec=used_spec, usage=usage)
            yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/models")
async def llm_models(
    user: Annotated[User, Depends(get_current_user)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> list[dict]:
    status_ = await meter.status(user.id)
    allowed = set(meter.plan_allowed_tiers(status_.plan))
    return [
        {
            "id": s.id, "label": s.label, "tier": s.tier,
            "capabilities": list(s.capabilities),
            "available": s.tier in allowed,
        }
        for s in CATALOG.values()
    ]


@router.get("/quota")
async def llm_quota(
    user: Annotated[User, Depends(get_current_user)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> dict:
    s = await meter.status(user.id)
    return {
        "plan": s.plan, "period_start": s.period_start, "period_end": s.period_end,
        "credits_total": s.credits_total, "credits_used": s.credits_used,
        "credits_remaining": s.credits_remaining,
    }
