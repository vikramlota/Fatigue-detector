"""Scoring backends: WeightedScorer (default) and IsolationForestScorer (trained)."""

from __future__ import annotations

import logging
from typing import Protocol

import numpy as np
from sklearn.ensemble import IsolationForest

from app.core.config import FEATURE_NAMES, FEATURE_WEIGHTS

log = logging.getLogger(__name__)


class Scorer(Protocol):
    def score(self, normalized: dict[str, float], vector: np.ndarray) -> float: ...


class WeightedScorer:
    """Simple weighted sum of normalized-in-[0,1] feature contributions."""

    name = "weighted"

    def score(self, normalized: dict[str, float], vector: np.ndarray) -> float:
        total = sum(FEATURE_WEIGHTS[name] * normalized.get(name, 0.0) for name in FEATURE_NAMES)
        return float(max(0.0, min(1.0, total)))


class IsolationForestScorer:
    """
    Anomaly-based scorer. Fit on baseline samples; inference returns
    normalized anomaly score in [0, 1], where 1 = most anomalous.
    """

    name = "isoforest"

    def __init__(self) -> None:
        self._clf: IsolationForest | None = None
        self._train_min: float = 0.0
        self._train_max: float = 1.0

    def fit(self, samples: list[dict[str, float]]) -> None:
        if len(samples) < 2:
            raise ValueError("IsolationForest needs at least 2 samples to fit")
        X = np.array(
            [[s.get(name, 0.0) for name in FEATURE_NAMES] for s in samples],
            dtype=np.float64,
        )
        clf = IsolationForest(
            n_estimators=50,
            contamination=0.1,
            random_state=42,
            n_jobs=1,
        )
        clf.fit(X)
        # Cache the training-score distribution for min-max scaling at inference.
        train_scores = -clf.score_samples(X)
        self._train_min = float(train_scores.min())
        self._train_max = float(train_scores.max())
        if self._train_max - self._train_min < 1e-9:
            self._train_max = self._train_min + 1.0  # avoid div-by-zero
        self._clf = clf
        log.info(
            "IsolationForest fitted on %d samples (train score range %.3f..%.3f)",
            len(samples),
            self._train_min,
            self._train_max,
        )

    def is_ready(self) -> bool:
        return self._clf is not None

    def score(self, normalized: dict[str, float], vector: np.ndarray) -> float:
        if self._clf is None:
            # Fallback: treat normalized mean as the score.
            return float(
                max(0.0, min(1.0, sum(normalized.values()) / max(1, len(normalized))))
            )
        try:
            raw = -self._clf.score_samples(vector.reshape(1, -1))[0]
            span = self._train_max - self._train_min
            # Values above training max indicate stronger anomalies → >1 before clip.
            scaled = (raw - self._train_min) / span
            return float(max(0.0, min(1.0, scaled)))
        except Exception as exc:  # never take down the request path
            log.warning("IsolationForest scoring failed, falling back: %s", exc)
            return float(
                max(0.0, min(1.0, sum(normalized.values()) / max(1, len(normalized))))
            )
