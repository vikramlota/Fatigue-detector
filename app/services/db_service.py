"""SQLite persistence for face-signal telemetry (async via aiosqlite)."""

from __future__ import annotations

import logging
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
    fatigue_tier INTEGER
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

_INDEX_EVENTS_HASH = "CREATE INDEX IF NOT EXISTS idx_face_events_hash ON face_events(user_ip_hash);"
_INDEX_EVENTS_TIME = "CREATE INDEX IF NOT EXISTS idx_face_events_time ON face_events(recorded_at);"


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
        await self._conn.execute(_INDEX_EVENTS_HASH)
        await self._conn.execute(_INDEX_EVENTS_TIME)
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
                combined_score, fatigue_score, fatigue_tier
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                   combined_score, fatigue_score, fatigue_tier
            FROM face_events
            WHERE user_ip_hash = ?
            ORDER BY recorded_at ASC
            LIMIT ?
            """,
            (user_ip_hash, limit),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]

    async def list_users(self) -> list[dict]:
        assert self._conn is not None, "DBService not initialized"
        cursor = await self._conn.execute(
            """
            SELECT user_ip_hash,
                   MAX(recorded_at) AS last_seen,
                   COUNT(DISTINCT session_id) AS session_count,
                   AVG(fatigue_score) AS avg_fatigue,
                   COUNT(*) AS event_count
            FROM face_events
            GROUP BY user_ip_hash
            ORDER BY last_seen DESC
            """
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
