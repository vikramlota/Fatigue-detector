"""Central configuration: feature ordering, weights, thresholds, smoothing."""

from __future__ import annotations

FEATURE_NAMES: tuple[str, ...] = (
    "wpm",
    "key_variance",
    "backspace_ratio",
    "mouse_entropy",
    "micro_jitter",
    "scroll_pause",
    "direction_change",
    "idle_spikes",
)

# Per-feature weights for the default weighted scorer. Must sum to 1.0.
FEATURE_WEIGHTS: dict[str, float] = {
    "wpm": 0.12,
    "key_variance": 0.15,
    "backspace_ratio": 0.18,
    "mouse_entropy": 0.10,
    "micro_jitter": 0.15,
    "scroll_pause": 0.10,
    "direction_change": 0.08,
    "idle_spikes": 0.12,
}

# +1 => higher raw value means more fatigue.
# -1 => lower raw value means more fatigue (e.g. wpm drops when tired).
FEATURE_DIRECTIONS: dict[str, int] = {
    "wpm": -1,
    "key_variance": +1,
    "backspace_ratio": +1,
    "mouse_entropy": +1,
    "micro_jitter": +1,
    "scroll_pause": +1,
    "direction_change": +1,
    "idle_spikes": +1,
}

# Exponential smoothing: final = (1 - alpha) * prev + alpha * current.
SMOOTHING_ALPHA: float = 0.3

HISTORY_BUFFER_SIZE: int = 2  # 10s window if 1 sample every 5s; adjust in feature_processor if needed
ROLLING_MEAN_MIN_SAMPLES: int = 3
ISOFOREST_MIN_SAMPLES: int = 15


# Fatigue score thresholds for UI mapping (not used, see ui_mapper.py for custom logic)
LEVEL_THRESHOLDS: tuple[float, float] = (2.0, 4.0)  # Not used, but kept for compatibility

# Custom tier boundaries (used in ui_mapper.py)
TIER_THRESHOLDS: tuple[float, float, float] = (2.0, 4.0, 7.0)  # 1-2 normal, 2-4 mild, 4-7 moderate, 7+ severe

# Epsilon for safe division.
EPS: float = 1e-6

# Confidence tiers.
CONFIDENCE_NO_BASELINE: float = 0.4
CONFIDENCE_WARMING_UP: float = 0.6
CONFIDENCE_WEIGHTED_STEADY: float = 0.8
CONFIDENCE_ISOFOREST: float = 0.95

assert abs(sum(FEATURE_WEIGHTS.values()) - 1.0) < 1e-9, "FEATURE_WEIGHTS must sum to 1.0"
assert set(FEATURE_WEIGHTS) == set(FEATURE_NAMES) == set(FEATURE_DIRECTIONS)
