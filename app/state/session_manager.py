"""Thread-safe in-memory session store."""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Optional

from app.core.config import FEATURE_NAMES, HISTORY_BUFFER_SIZE


@dataclass
class SessionState:
    baseline: Optional[dict[str, float]] = None
    baseline_samples: list[dict[str, float]] = field(default_factory=list)
    history: deque[dict[str, float]] = field(
        default_factory=lambda: deque(maxlen=HISTORY_BUFFER_SIZE)
    )
    prev_score: Optional[float] = None
    iso_model: Any = None  # IsolationForestScorer; Any avoids import cycle
    created_at: float = field(default_factory=time.time)


class SessionManager:
    """Per-session in-memory state, safe across FastAPI worker threads."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}
        self._lock = threading.Lock()

    def ensure(self, session_id: str) -> SessionState:
        """Return existing session or create an empty one."""
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is None:
                sess = SessionState()
                self._sessions[session_id] = sess
            return sess

    def get(self, session_id: str) -> Optional[SessionState]:
        with self._lock:
            return self._sessions.get(session_id)

    def add_baseline_sample(self, session_id: str, sample: dict[str, float]) -> SessionState:
        """Append a baseline sample and update the running-mean baseline."""
        with self._lock:
            sess = self._sessions.get(session_id) or SessionState()
            sess.baseline_samples.append(sample)
            n = len(sess.baseline_samples)
            # Running mean over all samples.
            running: dict[str, float] = {name: 0.0 for name in FEATURE_NAMES}
            for s in sess.baseline_samples:
                for name in FEATURE_NAMES:
                    running[name] += s.get(name, 0.0)
            sess.baseline = {name: running[name] / n for name in FEATURE_NAMES}
            self._sessions[session_id] = sess
            return sess

    def append_history(self, session_id: str, sample: dict[str, float]) -> None:
        with self._lock:
            sess = self._sessions.setdefault(session_id, SessionState())
            sess.history.append(sample)

    def set_prev_score(self, session_id: str, score: float) -> None:
        with self._lock:
            sess = self._sessions.setdefault(session_id, SessionState())
            sess.prev_score = score

    def set_iso_model(self, session_id: str, model: Any) -> None:
        with self._lock:
            sess = self._sessions.setdefault(session_id, SessionState())
            sess.iso_model = model

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)
