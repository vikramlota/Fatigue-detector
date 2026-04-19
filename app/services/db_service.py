"""SQLite persistence for face-signal telemetry (async via aiosqlite)."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

import aiosqlite

log = logging.getLogger(__name__)

DB_PATH = Path("data") / "helix.db"

_CREATE_FACE_EVENTS = """
CREATE TABLE IF NOT EXISTS face_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_ip_hash TEXT NOT NULL,
    recorded_at TEXT DEFAULT (datetime('now')),
    blink_rate REAL,
    gaze_on_screen INTEGER,
    gaze_x REAL,
    gaze_y REAL,
    focus_duration_ms INTEGER,
    gaze_shift_freq REAL,
    head_movement_freq REAL,
    mouth_active INTEGER,
    emotion TEXT,
    perclos REAL,
    avg_ear REAL,
    combined_score REAL,
    fatigue_score REAL,
    fatigue_tier INTEGER,
    snapshot_base64 TEXT
);
"""

_CREATE_SESSIONS = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_ip_hash TEXT NOT NULL,
    first_seen TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
);
"""

_CREATE_SNAPSHOTS = """
CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_ip_hash TEXT NOT NULL,
    recorded_at TEXT DEFAULT (datetime('now')),
    image_base64 TEXT NOT NULL,
    byte_size INTEGER NOT NULL
);
"""

_CREATE_BEHAVIORAL_EVENTS = """
CREATE TABLE IF NOT EXISTS behavioral_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    user_ip_hash TEXT NOT NULL,
    recorded_at TEXT DEFAULT (datetime('now')),
    wpm REAL,
    key_variance REAL,
    backspace_ratio REAL,
    mouse_entropy REAL,
    micro_jitter REAL,
    scroll_pause REAL,
    direction_change REAL,
    idle_spikes REAL,
    fatigue_score REAL,
    level TEXT,
    ui_mode TEXT,
    confidence REAL
);
"""

_INDEX_EVENTS_HASH = "CREATE INDEX IF NOT EXISTS idx_face_events_hash ON face_events(user_ip_hash);"
_INDEX_EVENTS_TIME = "CREATE INDEX IF NOT EXISTS idx_face_events_time ON face_events(recorded_at);"
_INDEX_SNAPSHOTS_SESSION = "CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);"
_INDEX_SNAPSHOTS_HASH = "CREATE INDEX IF NOT EXISTS idx_snapshots_hash ON snapshots(user_ip_hash);"
_INDEX_BEHAV_HASH = "CREATE INDEX IF NOT EXISTS idx_behav_events_hash ON behavioral_events(user_ip_hash);"
_INDEX_BEHAV_TIME = "CREATE INDEX IF NOT EXISTS idx_behav_events_time ON behavioral_events(recorded_at);"


class DBService:
    def __init__(self, db_path: Path = DB_PATH) -> None:
        self._db_path = db_path
        self._conn: aiosqlite.Connection | None = None

    async def init(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self._db_path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute(_CREATE_FACE_EVENTS)
        await self._conn.execute(_CREATE_SESSIONS)
        await self._conn.execute(_CREATE_SNAPSHOTS)
        await self._conn.execute(_CREATE_BEHAVIORAL_EVENTS)
        await self._conn.execute(_INDEX_EVENTS_HASH)
        await self._conn.execute(_INDEX_EVENTS_TIME)
        await self._conn.execute(_INDEX_SNAPSHOTS_SESSION)
        await self._conn.execute(_INDEX_SNAPSHOTS_HASH)
        await self._conn.execute(_INDEX_BEHAV_HASH)
        await self._conn.execute(_INDEX_BEHAV_TIME)
        await self._conn.commit()
        log.info("db_service initialized at %s", self._db_path)

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def insert_face_signal(self, user_ip_hash: str, body: Any) -> int:
        assert self._conn is not None, "DBService not initialized"
        await self._conn.execute(
            """
            INSERT INTO sessions (session_id, user_ip_hash)
            VALUES (?, ?)
            ON CONFLICT(session_id) DO UPDATE SET last_seen = datetime('now')
            """,
            (body.session_id, user_ip_hash),
        )
        cursor = await self._conn.execute(
            """
            INSERT INTO face_events (
                session_id, user_ip_hash,
                blink_rate, gaze_on_screen, gaze_x, gaze_y,
                focus_duration_ms, gaze_shift_freq, head_movement_freq,
                mouth_active, emotion, perclos, avg_ear,
                combined_score, fatigue_score, fatigue_tier, snapshot_base64
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                body.session_id,
                user_ip_hash,
                body.blink_rate,
                1 if body.gaze_on_screen else 0,
                body.gaze_x,
                body.gaze_y,
                body.focus_duration_ms,
                body.gaze_shift_freq,
                body.head_movement_freq,
                1 if body.mouth_active else 0,
                body.emotion,
                body.perclos,
                body.avg_ear,
                body.combined_score,
                body.fatigue_score,
                body.fatigue_tier,
                getattr(body, "snapshot_base64", ""),
            ),
        )
        await self._conn.commit()
        return cursor.lastrowid or 0

    async def get_face_events(self, user_ip_hash: str, limit: int = 500) -> list[dict]:
        assert self._conn is not None, "DBService not initialized"
        cursor = await self._conn.execute(
            """
            SELECT id, session_id, user_ip_hash, recorded_at,
                   blink_rate, gaze_on_screen, gaze_x, gaze_y,
                   focus_duration_ms, gaze_shift_freq, head_movement_freq,
                   mouth_active, emotion, perclos, avg_ear,
                   combined_score, fatigue_score, fatigue_tier,
                   snapshot_base64
            FROM face_events
            WHERE user_ip_hash = ?
            ORDER BY recorded_at ASC
            LIMIT ?
            """,
            (user_ip_hash, limit),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def insert_snapshot(
        self, user_ip_hash: str, session_id: str, image_base64: str
    ) -> tuple[int, float]:
        """Insert a base64 image into the snapshots table.

        Returns (record_id, elapsed_ms) so callers can surface insert latency.
        """
        assert self._conn is not None, "DBService not initialized"
        byte_size = len(image_base64)
        start = time.perf_counter()
        await self._conn.execute(
            """
            INSERT INTO sessions (session_id, user_ip_hash)
            VALUES (?, ?)
            ON CONFLICT(session_id) DO UPDATE SET last_seen = datetime('now')
            """,
            (session_id, user_ip_hash),
        )
        cursor = await self._conn.execute(
            """
            INSERT INTO snapshots (session_id, user_ip_hash, image_base64, byte_size)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, user_ip_hash, image_base64, byte_size),
        )
        await self._conn.commit()
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        return (cursor.lastrowid or 0, elapsed_ms)

    async def insert_behavioral_event(
        self,
        user_ip_hash: str,
        session_id: str,
        features: dict,
        fatigue_score: float,
        level: str,
        ui_mode: str,
        confidence: float,
    ) -> int:
        """Persist every /fatigue request, regardless of score/level.

        Mirrors the sessions upsert pattern used by insert_face_signal so that
        behavioural-only sessions also show up in the sessions table.
        """
        assert self._conn is not None, "DBService not initialized"
        await self._conn.execute(
            """
            INSERT INTO sessions (session_id, user_ip_hash)
            VALUES (?, ?)
            ON CONFLICT(session_id) DO UPDATE SET last_seen = datetime('now')
            """,
            (session_id, user_ip_hash),
        )
        cursor = await self._conn.execute(
            """
            INSERT INTO behavioral_events (
                session_id, user_ip_hash,
                wpm, key_variance, backspace_ratio, mouse_entropy,
                micro_jitter, scroll_pause, direction_change, idle_spikes,
                fatigue_score, level, ui_mode, confidence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                user_ip_hash,
                features.get("wpm"),
                features.get("key_variance"),
                features.get("backspace_ratio"),
                features.get("mouse_entropy"),
                features.get("micro_jitter"),
                features.get("scroll_pause"),
                features.get("direction_change"),
                features.get("idle_spikes"),
                fatigue_score,
                level,
                ui_mode,
                confidence,
            ),
        )
        await self._conn.commit()
        return cursor.lastrowid or 0

    async def get_behavioral_events(
        self, user_ip_hash: str, limit: int = 500
    ) -> list[dict]:
        assert self._conn is not None, "DBService not initialized"
        cursor = await self._conn.execute(
            """
            SELECT id, session_id, user_ip_hash, recorded_at,
                   wpm, key_variance, backspace_ratio, mouse_entropy,
                   micro_jitter, scroll_pause, direction_change, idle_spikes,
                   fatigue_score, level, ui_mode, confidence
            FROM behavioral_events
            WHERE user_ip_hash = ?
            ORDER BY recorded_at ASC
            LIMIT ?
            """,
            (user_ip_hash, limit),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def list_users(self) -> list[dict]:
        """Return one row per user_ip_hash, aggregating BOTH event tables.

        face_events and behavioral_events are unioned so a user who has only
        sent behavioural data (no eye tracking) still appears in the dashboard.
        """
        assert self._conn is not None, "DBService not initialized"
        cursor = await self._conn.execute(
            """
            WITH all_events AS (
                SELECT user_ip_hash, session_id, recorded_at, fatigue_score
                FROM face_events
                UNION ALL
                SELECT user_ip_hash, session_id, recorded_at, fatigue_score
                FROM behavioral_events
            )
            SELECT user_ip_hash,
                   MAX(recorded_at) AS last_seen,
                   COUNT(DISTINCT session_id) AS session_count,
                   AVG(fatigue_score) AS avg_fatigue,
                   COUNT(*) AS event_count,
                   (SELECT COUNT(*) FROM face_events fe
                      WHERE fe.user_ip_hash = all_events.user_ip_hash) AS face_count,
                   (SELECT COUNT(*) FROM behavioral_events be
                      WHERE be.user_ip_hash = all_events.user_ip_hash) AS behavioral_count
            FROM all_events
            GROUP BY user_ip_hash
            ORDER BY last_seen DESC
            """
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def get_combined_events(
        self, user_ip_hash: str, limit: int = 1000
    ) -> list[dict]:
        """Merge face + behavioural events into a single time-ordered stream.

        Each row carries a `source` field so the dashboard can tell them
        apart. Columns unique to one table are NULL on rows from the other.
        """
        assert self._conn is not None, "DBService not initialized"
        cursor = await self._conn.execute(
            """
            SELECT 'face' AS source,
                   id, session_id, user_ip_hash, recorded_at,
                   blink_rate, gaze_on_screen, gaze_x, gaze_y,
                   focus_duration_ms, gaze_shift_freq, head_movement_freq,
                   mouth_active, emotion, perclos, avg_ear,
                   combined_score, fatigue_score, fatigue_tier,
                   NULL AS wpm, NULL AS key_variance, NULL AS backspace_ratio,
                   NULL AS mouse_entropy, NULL AS micro_jitter,
                   NULL AS scroll_pause, NULL AS direction_change,
                   NULL AS idle_spikes, NULL AS level, NULL AS ui_mode,
                   NULL AS confidence
            FROM face_events
            WHERE user_ip_hash = ?
            UNION ALL
            SELECT 'behavioral' AS source,
                   id, session_id, user_ip_hash, recorded_at,
                   NULL AS blink_rate, NULL AS gaze_on_screen,
                   NULL AS gaze_x, NULL AS gaze_y,
                   NULL AS focus_duration_ms, NULL AS gaze_shift_freq,
                   NULL AS head_movement_freq, NULL AS mouth_active,
                   NULL AS emotion, NULL AS perclos, NULL AS avg_ear,
                   NULL AS combined_score, fatigue_score,
                   NULL AS fatigue_tier,
                   wpm, key_variance, backspace_ratio,
                   mouse_entropy, micro_jitter,
                   scroll_pause, direction_change,
                   idle_spikes, level, ui_mode, confidence
            FROM behavioral_events
            WHERE user_ip_hash = ?
            ORDER BY recorded_at ASC
            LIMIT ?
            """,
            (user_ip_hash, user_ip_hash, limit),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
