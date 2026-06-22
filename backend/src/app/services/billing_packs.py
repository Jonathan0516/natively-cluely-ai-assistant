# backend/src/app/services/billing_packs.py
"""Credit top-up packs. Flat rate: 1 CNY = 100 credits (1 credit = 1 fen = ¥0.01), so the
granted credits equal unit_amount (both in fen). unit_amount is in minor units (fen)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Pack:
    id: str
    currency: str
    unit_amount: int   # minor units (fen): ¥50 = 5000
    credits: int


BILLING_PACKS: dict[str, Pack] = {
    "pack_s": Pack("pack_s", "cny", 5000, 5000),
    "pack_m": Pack("pack_m", "cny", 10000, 10000),
    "pack_l": Pack("pack_l", "cny", 20000, 20000),
}
