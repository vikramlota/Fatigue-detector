"""Feature cleaning, normalization, deviation, rolling mean, vectorization."""

from __future__ import annotations

import math
from collections import deque
from typing import Iterable

import numpy as np

from app.core.config import EPS, FEATURE_DIRECTIONS, FEATURE_NAMES


def safe_fill(raw: dict) -> dict[str, float]:
    """Coerce to float, fill missing/NaN/inf with 0.0, only keep known features."""
    out: dict[str, float] = {}
    for name in FEATURE_NAMES:
        value = raw.get(name, 0.0)
        try:
            v = float(value)
        except (TypeError, ValueError):
            v = 0.0
        if not math.isfinite(v):
            v = 0.0
        out[name] = max(v, 0.0)
    return out



# Reduce behavioral signal window to 10s (2 samples if 5s interval)
def rolling_mean(history: Iterable[dict[str, float]]) -> dict[str, float]:
    """Element-wise mean over last 2 samples (10s window). Empty iter → zeros."""
    samples = list(history)[-2:]
    if not samples:
        return {name: 0.0 for name in FEATURE_NAMES}
    totals = {name: 0.0 for name in FEATURE_NAMES}
    for s in samples:
        for name in FEATURE_NAMES:
            totals[name] += s.get(name, 0.0)
    n = len(samples)
    return {name: totals[name] / n for name in FEATURE_NAMES}


def compute_deviation(
    current: dict[str, float], baseline: dict[str, float]
) -> dict[str, float]:
    """Signed ratio deviation (x - baseline) / (|baseline| + eps). No clipping."""
    return {
        name: (current.get(name, 0.0) - baseline.get(name, 0.0))
        / (abs(baseline.get(name, 0.0)) + EPS)
        for name in FEATURE_NAMES
    }


def directional_normalize(
    current: dict[str, float], baseline: dict[str, float]
) -> dict[str, float]:
    """
    Per-feature normalized fatigue contribution in [0, 1].

    1. Compute signed deviation from baseline.
    2. Multiply by FEATURE_DIRECTIONS so higher = more fatigue.
    3. Clip to [-3, 3], then map to [0, 1] via (x + 3) / 6.
    """
    out: dict[str, float] = {}
    for name in FEATURE_NAMES:
        base = baseline.get(name, 0.0)
        cur = current.get(name, 0.0)
        dev = (cur - base) / (abs(base) + EPS)
        dev *= FEATURE_DIRECTIONS[name]
        dev = max(-3.0, min(3.0, dev))
        out[name] = (dev + 3.0) / 6.0
    return out


def to_vector(features: dict[str, float]) -> np.ndarray:
    """Ordered numpy vector following FEATURE_NAMES."""
    return np.array([features.get(name, 0.0) for name in FEATURE_NAMES], dtype=np.float64)


def top_deviation_reasons(
    current: dict[str, float],
    baseline: dict[str, float],
    k: int = 3,
    min_abs: float = 0.15,
) -> list[str]:
    """Human-readable top-k deviations."""
    dev = compute_deviation(current, baseline)
    # Weight by direction so items that increase fatigue rank higher; negatives
    # (below baseline but direction=+1) still count via absolute value.
    ranked = sorted(dev.items(), key=lambda kv: abs(kv[1]), reverse=True)
    reasons: list[str] = []
    for name, d in ranked:
        if abs(d) < min_abs:
            continue
        direction_hint = "above" if d * FEATURE_DIRECTIONS[name] > 0 else "below"
        reasons.append(f"{name} {d:+.2f} vs baseline ({direction_hint} typical)")
        if len(reasons) >= k:
            break
    if not reasons:
        reasons.append("features within baseline range")
    return reasons


def history_deque_view(history: deque[dict[str, float]]) -> list[dict[str, float]]:
    """Snapshot copy, avoids mutation during iteration."""
    return list(history)
