"""FastAPI entry point for the Cognitive Fatigue-Aware Interface Adapter."""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.services.db_service import DBService
from app.services.fatigue_service import FatigueService
from app.state.session_manager import SessionManager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
)
log = logging.getLogger("fatigue.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.started_at = time.time()
    app.state.session_manager = SessionManager()
    app.state.fatigue_service = FatigueService(app.state.session_manager)
    app.state.db_service = DBService()
    await app.state.db_service.init()
    log.info("fatigue service initialized")
    yield
    log.info("fatigue service shutting down")
    await app.state.db_service.close()


app = FastAPI(
    title="Cognitive Fatigue-Aware Interface Adapter",
    description="Real-time fatigue scoring + UI adaptation decisions.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)
