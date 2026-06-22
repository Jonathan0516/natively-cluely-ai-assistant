# backend/src/app/routers/llm.py
"""Metered LLM gateway endpoints. Auth (JWT) → quota check → gateway → record usage."""
from __future__ import annotations

import json
import logging
import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..deps import get_current_user, get_llm_gateway, get_usage_meter
from ..services.llm_gateway import LLMGateway
from ..services.llm_types import ChatMessage, NoModelAvailable, QuotaExceeded, TierNotAllowed
from ..services.model_catalog import CATALOG
from ..services.usage_meter import UsageMeter
from ..services.user_repo import User

router = APIRouter(prefix="/llm", tags=["llm"])
logger = logging.getLogger(__name__)


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
    # Per-request override of the model's thinking budget (Gemini 3.x). When set, wins over
    # the catalog default in ModelSpec.extra_params. e.g. "none" | "low" | "high".
    reasoning_effort: str | None = None
    # Optional meeting/session this call belongs to. Recorded on the usage event so the
    # account page can show per-meeting token usage + credit consumption (/llm/usage).
    meeting_id: str | None = None
    # Optional "turn" (one Q&A) this call belongs to. A turn may span several calls; recorded
    # so the meeting detail view can break usage down per Q&A (/llm/usage/meeting/{id}).
    turn_id: str | None = None

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
        if self.reasoning_effort is not None:
            p["reasoning_effort"] = self.reasoning_effort
        return p


def _quota_detail(exc: QuotaExceeded) -> dict:
    s = exc.status
    return {"error": "quota_exceeded", "credits_remaining": s.credits_remaining,
            "credits_total": s.credits_total, "plan": s.plan}


def _tier_detail(exc: TierNotAllowed) -> dict:
    return {"error": "tier_not_allowed", "required_tier": exc.required_tier, "plan": exc.plan}


@router.post("/json")
async def llm_json(
    body: ChatRequest,
    user: Annotated[User, Depends(get_current_user)],
    gateway: Annotated[LLMGateway, Depends(get_llm_gateway)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> dict:
    try:
        st = await meter.check(user.id)
    except QuotaExceeded as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, _quota_detail(exc)) from exc
    try:
        requested_spec, _ = gateway.resolve(body.model)
    except NoModelAvailable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    try:
        meter.authorize_model(st.plan, requested_spec)
    except TierNotAllowed as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, _tier_detail(exc)) from exc
    try:
        spec, res = await gateway.generate_json(body.model, body.to_messages(), body.to_params())
    except NoModelAvailable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    await meter.record(user.id, kind="json", spec=spec, usage=res.usage,
                       meeting_id=body.meeting_id, turn_id=body.turn_id)
    return {"text": res.text, "model": spec.id}


@router.post("/chat")
async def llm_chat(
    request: Request,
    body: ChatRequest,
    user: Annotated[User, Depends(get_current_user)],
    gateway: Annotated[LLMGateway, Depends(get_llm_gateway)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
):
    # TTFT breakdown timestamps. t0 = request arrival (stamped pre-auth by middleware);
    # t_handler = after auth ran (get_current_user dependency); the rest below.
    t0 = getattr(request.state, "t0", None)
    t_handler = time.perf_counter()

    # Quota + model resolution happen BEFORE we start streaming, so failures are real HTTP codes.
    try:
        st = await meter.check(user.id)
    except QuotaExceeded as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, _quota_detail(exc)) from exc
    try:
        requested_spec, _ = gateway.resolve(body.model)
    except NoModelAvailable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    try:
        meter.authorize_model(st.plan, requested_spec)
    except TierNotAllowed as exc:
        raise HTTPException(status.HTTP_403_FORBIDDEN, _tier_detail(exc)) from exc
    t_meter = time.perf_counter()

    async def event_stream():
        from ..services.llm_types import Usage
        used_spec = None
        usage = Usage()
        t_before_gemini = time.perf_counter()
        first_token_logged = False
        try:
            async for spec, delta in gateway.stream_chat(
                body.model, body.to_messages(), body.images, body.to_params()
            ):
                used_spec = spec
                if delta.text:
                    if not first_token_logged:
                        first_token_logged = True
                        now = time.perf_counter()
                        auth_ms = (t_handler - t0) * 1000 if t0 is not None else -1
                        logger.info(
                            "ttft model=%s auth=%.0fms meter=%.0fms gemini=%.0fms total=%.0fms",
                            requested_spec.id,
                            auth_ms,
                            (t_meter - t_handler) * 1000,
                            (now - t_before_gemini) * 1000,
                            (now - t0) * 1000 if t0 is not None else -1,
                        )
                    yield f"data: {json.dumps({'delta': delta.text})}\n\n"
                if delta.usage:
                    usage = delta.usage
        except NoModelAvailable as exc:
            yield f"data: {json.dumps({'error': {'code': 'no_model', 'message': str(exc)}})}\n\n"
        finally:
            if used_spec is not None:
                await meter.record(user.id, kind="chat", spec=used_spec, usage=usage,
                                   meeting_id=body.meeting_id, turn_id=body.turn_id)
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
            "latency_hint": s.latency_hint,
            # Credits per 1k tokens — surfaced for the account page's Model Library.
            "price_in": s.credits_per_1k_input,
            "price_out": s.credits_per_1k_output,
            # Drives the client's adaptive thinking toggle: "graded" (off/low/high),
            # "binary" (on/off), or "none" (hide the button).
            "reasoning": s.reasoning_style,
        }
        for s in CATALOG.values()
        if "text" in s.capabilities
    ]


@router.get("/quota")
async def llm_quota(
    user: Annotated[User, Depends(get_current_user)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> dict:
    s = await meter.status(user.id)
    return {
        "plan": s.plan, "period_start": s.period_start, "period_end": s.period_end,
        # Combined view: periodic free allowance + persistent wallet.
        "credits_total": s.credits_total + s.wallet_balance,
        "credits_used": s.credits_used,
        "credits_remaining": s.credits_remaining,
        "wallet_balance": s.wallet_balance,
    }


@router.get("/usage")
async def llm_usage(
    user: Annotated[User, Depends(get_current_user)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> list[dict]:
    """Per-meeting usage for the current billing period: token usage + credits, broken down
    by model. Powers the account page "Usage Details" list and per-meeting detail. Meeting
    titles are resolved client-side by meeting_id."""
    return await meter.meeting_usage(user.id)


@router.get("/usage/meeting/{meeting_id}")
async def llm_usage_meeting(
    meeting_id: str,
    user: Annotated[User, Depends(get_current_user)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> dict:
    """One meeting's usage broken down per turn (Q&A) and per model. Powers the meeting
    detail "Analysis" tab; the client joins each turn to its Q&A by turn_id."""
    return await meter.meeting_turn_usage(user.id, meeting_id)


class EmbeddingsRequest(BaseModel):
    texts: list[str]
    model: str = "embed-default"
    # Optional meeting this embedding batch belongs to (RAG indexing of a meeting's chunks /
    # query-time embedding). Recorded on the usage event so embedding credits show per meeting.
    meeting_id: str | None = None


@router.post("/embeddings")
async def llm_embeddings(
    body: EmbeddingsRequest,
    user: Annotated[User, Depends(get_current_user)],
    gateway: Annotated[LLMGateway, Depends(get_llm_gateway)],
    meter: Annotated[UsageMeter, Depends(get_usage_meter)],
) -> dict:
    try:
        await meter.check(user.id)
    except QuotaExceeded as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, _quota_detail(exc)) from exc
    try:
        spec, res = await gateway.embed(body.model, body.texts)
    except NoModelAvailable as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    await meter.record(user.id, kind="embeddings", spec=spec, usage=res.usage,
                       meeting_id=body.meeting_id)
    return {"embeddings": res.vectors, "dim": res.dim, "model": spec.id}
