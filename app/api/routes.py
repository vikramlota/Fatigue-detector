"""HTTP routes for the fatigue API."""

from __future__ import annotations

import hashlib
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app import __version__
from app.schemas.request_response import (
    BaselineInitRequest,
    BaselineInitResponse,
    FaceSignalRequest,
    FaceSignalResponse,
    FatigueRequest,
    FatigueResponse,
    HealthResponse,
)
from app.services.db_service import DBService
from app.services.fatigue_service import FatigueService

log = logging.getLogger(__name__)

router = APIRouter()


def get_service(request: Request) -> FatigueService:
    service: FatigueService | None = getattr(request.app.state, "fatigue_service", None)
    if service is None:  # pragma: no cover - misconfiguration guard
        raise HTTPException(status_code=500, detail="fatigue service not initialized")
    return service


@router.post("/fatigue", response_model=FatigueResponse)
async def score_fatigue(
    body: FatigueRequest,
    request: Request,
    service: FatigueService = Depends(get_service),
) -> FatigueResponse:
    t0 = time.perf_counter()
    try:
        response = service.process(body)
    except Exception as exc:
        log.exception("fatigue scoring failed for session=%s", body.session_id)
        raise HTTPException(status_code=500, detail=f"scoring error: {exc}") from exc
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    # Persist every behavioural sample — even low/normal — so the dashboard
    # has a full curve to draw, not just the spikes.
    db: DBService | None = getattr(request.app.state, "db_service", None)
    if db is not None:
        try:
            await db.insert_behavioral_event(
                user_ip_hash=_hash_client_ip(request),
                session_id=body.session_id,
                features=body.features.model_dump(),
                fatigue_score=response.fatigue_score,
                level=response.level,
                ui_mode=response.ui_mode,
                confidence=response.confidence,
            )
        except Exception:
            log.exception(
                "behavioral insert failed for session=%s", body.session_id
            )
            # Scoring response still returns — persistence is best-effort.

    log.debug("POST /fatigue took %.2fms", elapsed_ms)
    return response


@router.post("/baseline/init", response_model=BaselineInitResponse)
async def init_baseline(
    body: BaselineInitRequest,
    service: FatigueService = Depends(get_service),
) -> BaselineInitResponse:
    try:
        return service.init_baseline(body)
    except Exception as exc:
        log.exception("baseline init failed for session=%s", body.session_id)
        raise HTTPException(status_code=500, detail=f"baseline error: {exc}") from exc


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    started = getattr(request.app.state, "started_at", time.time())
    service: FatigueService = get_service(request)
    active = service._sessions.count()  # simple read, lock internal
    return HealthResponse(
        status="ok",
        uptime_seconds=round(time.time() - started, 2),
        active_sessions=active,
        version=__version__,
    )


def _get_db(request: Request) -> DBService:
    db: DBService | None = getattr(request.app.state, "db_service", None)
    if db is None:  # pragma: no cover - misconfiguration guard
        raise HTTPException(status_code=500, detail="db service not initialized")
    return db


def _hash_client_ip(request: Request) -> str:
    raw_ip = request.headers.get("X-Forwarded-For") or (
        request.client.host if request.client else "unknown"
    )
    return hashlib.sha256(raw_ip.encode()).hexdigest()[:16]


@router.post("/face-signals", response_model=FaceSignalResponse)
async def store_face_signal(body: FaceSignalRequest, request: Request) -> FaceSignalResponse:
    db = _get_db(request)
    user_ip_hash = _hash_client_ip(request)
    try:
        record_id = await db.insert_face_signal(user_ip_hash, body)
    except Exception as exc:
        log.exception("face-signal insert failed for session=%s", body.session_id)
        raise HTTPException(status_code=500, detail=f"db error: {exc}") from exc
    return FaceSignalResponse(status="ok", record_id=record_id)


@router.get("/reports/{user_ip_hash}")
async def get_user_report(
    user_ip_hash: str, request: Request, limit: int = 1000
) -> dict:
    """Return face + behavioural events merged into one stream.

    Each row has `source: "face" | "behavioral"` so the dashboard can
    branch on it. Columns absent from the row's source table are null.
    """
    db = _get_db(request)
    events = await db.get_combined_events(user_ip_hash, limit)
    face_count = sum(1 for e in events if e.get("source") == "face")
    behavioral_count = sum(1 for e in events if e.get("source") == "behavioral")
    return {
        "user_ip_hash": user_ip_hash,
        "events": events,
        "count": len(events),
        "face_count": face_count,
        "behavioral_count": behavioral_count,
    }


@router.get("/reports/{user_ip_hash}/behavioral")
async def get_behavioral_report(
    user_ip_hash: str, request: Request, limit: int = 500
) -> dict:
    db = _get_db(request)
    events = await db.get_behavioral_events(user_ip_hash, limit)
    return {"user_ip_hash": user_ip_hash, "events": events, "count": len(events)}


@router.get("/reports")
async def list_users(request: Request) -> dict:
    db = _get_db(request)
    users = await db.list_users()
    return {"users": users}


class ImagePayload(BaseModel):
    session_id: str
    image: str  # base64 string


@router.post("/upload-image")
async def upload_image(payload: ImagePayload, request: Request) -> dict:
    db = _get_db(request)
    user_ip_hash = _hash_client_ip(request)
    try:
        record_id, elapsed_ms = await db.insert_snapshot(
            user_ip_hash, payload.session_id, payload.image
        )
    except Exception as exc:
        log.exception("snapshot insert failed for session=%s", payload.session_id)
        raise HTTPException(status_code=500, detail=f"db error: {exc}") from exc
    return {
        "status": "ok",
        "record_id": record_id,
        "byte_size": len(payload.image),
        "insert_ms": round(elapsed_ms, 3),
    }
