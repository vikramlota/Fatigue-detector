"""Pydantic request/response models."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class Features(BaseModel):
    """Behavioral features captured by the browser extension."""

    model_config = ConfigDict(extra="forbid")

    wpm: float = Field(..., ge=0.0, description="Words per minute.")
    key_variance: float = Field(..., ge=0.0, description="Variance of inter-key intervals.")
    backspace_ratio: float = Field(..., ge=0.0, description="Backspaces per keystroke.")
    mouse_entropy: float = Field(..., ge=0.0, description="Entropy of mouse movement.")
    micro_jitter: float = Field(..., ge=0.0, description="High-frequency cursor jitter.")
    scroll_pause: float = Field(..., ge=0.0, description="Mean pause between scrolls (s).")
    direction_change: float = Field(..., ge=0.0, description="Mouse direction-change rate.")
    idle_spikes: float = Field(..., ge=0.0, description="Count of idle spikes in window.")


class FatigueRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(..., min_length=1, max_length=128)
    features: Features


Level = Literal["low", "medium", "high"]
UIMode = Literal["normal", "reduced", "focus"]


class FatigueResponse(BaseModel):
    fatigue_score: float = Field(..., ge=0.0, le=1.0)
    level: Level
    ui_mode: UIMode
    confidence: float = Field(..., ge=0.0, le=1.0)
    reasons: list[str]


class BaselineInitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(..., min_length=1, max_length=128)
    features: Optional[Features] = None


class BaselineInitResponse(BaseModel):
    session_id: str
    status: Literal["ok"]
    samples_collected: int
    iso_model_ready: bool
    message: str


class HealthResponse(BaseModel):
    status: Literal["ok"]
    uptime_seconds: float
    active_sessions: int
    version: str


class FaceSignalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str = Field(..., min_length=1, max_length=128)
    blink_rate: float = 0.0
    gaze_on_screen: bool = True
    gaze_x: float = 0.0
    gaze_y: float = 0.0
    focus_duration_ms: int = 0
    gaze_shift_freq: float = 0.0
    head_movement_freq: float = 0.0
    mouth_active: bool = False
    emotion: str = "neutral"
    perclos: float = 0.0
    avg_ear: float = 0.0
    combined_score: float = 0.0
    fatigue_score: float = 0.0
    fatigue_tier: int = 0
    snapshot_base64: str = ""  # base64-encoded image (optional)


class FaceSignalResponse(BaseModel):
    status: Literal["ok"]
    record_id: int
