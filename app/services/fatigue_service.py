"""End-to-end orchestrator: features → score → smoothing → UI decision."""

from __future__ import annotations

import logging
from typing import Optional

from app.core.config import (
    CONFIDENCE_ISOFOREST,
    CONFIDENCE_NO_BASELINE,
    CONFIDENCE_WARMING_UP,
    CONFIDENCE_WEIGHTED_STEADY,
    FEATURE_NAMES,
    ISOFOREST_MIN_SAMPLES,
    ROLLING_MEAN_MIN_SAMPLES,
    SMOOTHING_ALPHA,
)
from app.models.fatigue_model import IsolationForestScorer, WeightedScorer
from app.schemas.request_response import (
    BaselineInitRequest,
    BaselineInitResponse,
    FatigueRequest,
    FatigueResponse,
)
from app.services.feature_processor import (
    directional_normalize,
    history_deque_view,
    rolling_mean,
    safe_fill,
    to_vector,
    top_deviation_reasons,
)
from app.services.ui_mapper import score_to_level, score_to_ui_mode
from app.state.session_manager import SessionManager, SessionState

log = logging.getLogger(__name__)


def _default_baseline() -> dict[str, float]:
    """Zero-vector baseline used when a session has no collected baseline yet."""
    return {name: 0.0 for name in FEATURE_NAMES}


class FatigueService:
    def __init__(self, session_manager: SessionManager) -> None:
        self._sessions = session_manager
        self._weighted = WeightedScorer()

    # ------------------------------------------------------------------ baseline

    def init_baseline(self, req: BaselineInitRequest) -> BaselineInitResponse:
        sess = self._sessions.ensure(req.session_id)
        iso_ready_before = isinstance(sess.iso_model, IsolationForestScorer) and sess.iso_model.is_ready()

        if req.features is not None:
            filled = safe_fill(req.features.model_dump())
            sess = self._sessions.add_baseline_sample(req.session_id, filled)

        samples = len(sess.baseline_samples)
        iso_ready = iso_ready_before

        # Lazily fit / refit IsolationForest once we cross the threshold.
        if samples >= ISOFOREST_MIN_SAMPLES and req.features is not None:
            scorer = IsolationForestScorer()
            try:
                scorer.fit(sess.baseline_samples)
                self._sessions.set_iso_model(req.session_id, scorer)
                iso_ready = True
            except Exception as exc:
                log.warning("IsolationForest fit failed for %s: %s", req.session_id, exc)
                iso_ready = iso_ready_before

        if req.features is None:
            message = "session initialized; send samples to build baseline"
        elif iso_ready and not iso_ready_before:
            message = f"baseline ready, IsolationForest trained on {samples} samples"
        elif samples < ISOFOREST_MIN_SAMPLES:
            message = (
                f"baseline sample recorded ({samples}/{ISOFOREST_MIN_SAMPLES} for IsoForest)"
            )
        else:
            message = f"baseline sample recorded ({samples} total)"

        return BaselineInitResponse(
            session_id=req.session_id,
            status="ok",
            samples_collected=samples,
            iso_model_ready=iso_ready,
            message=message,
        )

    # -------------------------------------------------------------------- score

    def process(self, req: FatigueRequest) -> FatigueResponse:
        sess = self._sessions.ensure(req.session_id)

        filled = safe_fill(req.features.model_dump())
        self._sessions.append_history(req.session_id, filled)

        history = history_deque_view(sess.history)
        # Rolling mean once we have enough samples, otherwise raw.
        smoothed_features = (
            rolling_mean(history) if len(history) >= ROLLING_MEAN_MIN_SAMPLES else filled
        )

        baseline = sess.baseline if sess.baseline is not None else _default_baseline()
        has_baseline = sess.baseline is not None

        normalized = directional_normalize(smoothed_features, baseline)
        vector = to_vector(smoothed_features)

        scorer, scorer_name = self._pick_scorer(sess)
        raw_score = scorer.score(normalized, vector)

        if sess.prev_score is None:
            final = raw_score
        else:
            final = (1.0 - SMOOTHING_ALPHA) * sess.prev_score + SMOOTHING_ALPHA * raw_score
        final = float(max(0.0, min(1.0, final)))
        self._sessions.set_prev_score(req.session_id, final)

        reasons = top_deviation_reasons(filled, baseline) if has_baseline else [
            "no baseline recorded — scoring against zero reference"
        ]

        confidence = self._confidence(
            has_baseline=has_baseline,
            history_len=len(history),
            scorer_name=scorer_name,
        )

        level = score_to_level(final)
        ui_mode = score_to_ui_mode(final)

        log.info(
            "fatigue session=%s score=%.3f level=%s ui=%s scorer=%s conf=%.2f",
            req.session_id,
            final,
            level,
            ui_mode,
            scorer_name,
            confidence,
        )

        return FatigueResponse(
            fatigue_score=round(final, 4),
            level=level,
            ui_mode=ui_mode,
            confidence=round(confidence, 2),
            reasons=reasons,
        )

    # --------------------------------------------------------------- internals

    def _pick_scorer(self, sess: SessionState):
        iso: Optional[IsolationForestScorer] = sess.iso_model
        if (
            iso is not None
            and iso.is_ready()
            and len(sess.baseline_samples) >= ISOFOREST_MIN_SAMPLES
        ):
            return iso, "isoforest"
        return self._weighted, "weighted"

    @staticmethod
    def _confidence(has_baseline: bool, history_len: int, scorer_name: str) -> float:
        if not has_baseline:
            return CONFIDENCE_NO_BASELINE
        if history_len < 5:
            return CONFIDENCE_WARMING_UP
        if scorer_name == "isoforest":
            return CONFIDENCE_ISOFOREST
        return CONFIDENCE_WEIGHTED_STEADY
