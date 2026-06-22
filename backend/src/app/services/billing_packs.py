# backend/src/app/services/billing_packs.py
"""Credit top-up packs. Flat rate: 1 CNY = 1 credit. unit_amount is in minor units (fen)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Pack:
    id: str
    currency: str
    unit_amount: int   # minor units (fen): ¥50 = 5000
    credits: int


BILLING_PACKS: dict[str, Pack] = {
    "pack_s": Pack("pack_s", "cny", 5000, 50),
    "pack_m": Pack("pack_m", "cny", 10000, 100),
    "pack_l": Pack("pack_l", "cny", 20000, 200),
}
