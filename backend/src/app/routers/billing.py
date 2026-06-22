# backend/src/app/routers/billing.py
"""Credit top-up: list packs, create Stripe Checkout sessions, handle the paid webhook.
Crediting is webhook-driven and idempotent (Stripe event id → credit_ledger unique)."""
from __future__ import annotations

import logging
from typing import Annotated

import stripe
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from ..config import Settings, get_settings
from ..deps import get_billing_repo, get_current_user
from ..services.billing_packs import BILLING_PACKS
from ..services.billing_repo import BillingRepo
from ..services.user_repo import User

router = APIRouter(prefix="/billing", tags=["billing"])
logger = logging.getLogger(__name__)


class CheckoutRequest(BaseModel):
    pack_id: str


@router.get("/packs")
async def billing_packs(user: Annotated[User, Depends(get_current_user)]) -> list[dict]:
    return [
        {"id": p.id, "currency": p.currency, "amount": p.unit_amount, "credits": p.credits}
        for p in BILLING_PACKS.values()
    ]


@router.post("/checkout")
async def billing_checkout(
    body: CheckoutRequest,
    user: Annotated[User, Depends(get_current_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> dict:
    if not settings.stripe_enabled:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "stripe not configured")
    pack = BILLING_PACKS.get(body.pack_id)
    if not pack:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "unknown pack")
    stripe.api_key = settings.stripe_secret_key
    session = stripe.checkout.Session.create(
        mode="payment",
        payment_method_types=["card", "alipay", "wechat_pay"],
        # WeChat Pay on hosted Checkout requires the display client; Stripe 400s without it.
        payment_method_options={"wechat_pay": {"client": "web"}},
        line_items=[{
            "quantity": 1,
            "price_data": {
                "currency": pack.currency,
                "unit_amount": pack.unit_amount,
                "product_data": {"name": f"{pack.credits} credits"},
            },
        }],
        metadata={"user_id": user.id, "pack_id": pack.id, "credits": str(pack.credits)},
        success_url="https://example.com/topup/success",
        cancel_url="https://example.com/topup/cancel",
    )
    return {"url": session.url}


@router.post("/webhook")
async def billing_webhook(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    repo: Annotated[BillingRepo, Depends(get_billing_repo)],
) -> dict:
    payload = await request.body()  # raw body required for signature verification
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, settings.stripe_webhook_secret)
    except (ValueError, stripe.error.SignatureVerificationError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid signature") from exc

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        if session.get("payment_status") == "paid":
            md = session.get("metadata") or {}
            user_id = md.get("user_id")
            # Parse defensively: a malformed `credits` must NOT raise. A 500 here returns a
            # non-2xx to Stripe, which then retries the same event for ~3 days — a poison-event
            # retry storm. Log and no-op instead (still 200).
            try:
                credits = int(md.get("credits") or 0)
            except (TypeError, ValueError):
                logger.warning("topup webhook bad credits metadata user=%s credits=%r event=%s",
                               user_id, md.get("credits"), event["id"])
                credits = 0
            if user_id and credits > 0:
                granted = await repo.grant_credits(user_id, credits, event["id"])
                logger.info("topup webhook user=%s credits=%s granted=%s event=%s",
                            user_id, credits, granted, event["id"])
    return {"received": True}
