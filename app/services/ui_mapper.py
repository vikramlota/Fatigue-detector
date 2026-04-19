"""Map a fatigue score to a user-facing level and UI mode."""

from __future__ import annotations

from app.core.config import TIER_THRESHOLDS
from app.schemas.request_response import Level, UIMode



def score_to_level(score: float) -> Level:
    """
    Custom tier mapping:
    1 <= score < 2: low (normal)
    2 <= score < 4: medium (mild)
    4 <= score < 7: high (moderate)
    7 <= score: high (severe)
    """
    t1, t2, t3 = TIER_THRESHOLDS
    if score < 1:
        return "low"
    if score < t1:
        return "low"
    if score < t2:
        return "medium"
    if score < t3:
        return "high"
    return "high"



def score_to_ui_mode(score: float) -> UIMode:
    t1, t2, t3 = TIER_THRESHOLDS
    if score < 1:
        return "normal"
    if score < t1:
        return "normal"
    if score < t2:
        return "reduced"
    if score < t3:
        return "focus"
    return "focus"
