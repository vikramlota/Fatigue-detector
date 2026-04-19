/**
 * src/content/eyetracking.js
 * ───────────────────────────
 * Runs INSIDE src/eyetracking.html, which is loaded as a hidden iframe by
 * signals.js. Because eyetracking.html is served from chrome-extension://
 * origin, getUserMedia() works correctly here.
 *
 * Results are sent to the parent content script via window.parent.postMessage.
 * The content script then forwards them to the background worker via
 * chrome.runtime.sendMessage.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY AN IFRAME?
 * ════════════════════════════════════════════════════════════════════════════
 * getUserMedia() from a content script runs under the HOST PAGE origin
 * (e.g. https://example.com). Chrome's camera permission for the extension
 * only covers the chrome-extension:// origin. By loading this code in an
 * iframe whose src = chrome.runtime.getURL('eyetracking.html'), we run in
 * the correct origin and getUserMedia succeeds.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * MEDIAPIPE ASSET LOADING
 * ════════════════════════════════════════════════════════════════════════════
 * Assets load via <script> tag with RELATIVE paths — this page and the
 * assets/mediapipe/ directory share the same chrome-extension:// origin so
 * no chrome.runtime.getURL is needed. The locateFile callback also uses
 * relative paths for WASM/data files.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * EAR (Eye Aspect Ratio) and PERCLOS
 * ════════════════════════════════════════════════════════════════════════════
 * EAR formula (Soukupová & Čech 2016):
 *   EAR = (||p2-p6|| + ||p3-p5||) / (2 × ||p1-p4||)
 * Eyes considered closed when EAR < 0.20.
 * PERCLOS = fraction of frames in last 10 s with EAR < threshold.
 * PERCLOS > 0.15 is a drowsiness marker.
 *
 * NOTE — old dead code below this block has been replaced. The file no longer
 * exports requestCameraAndStart / stopEyeTracking; it auto-starts on
 * DOMContentLoaded instead.
 */

// ─────────────────────────────────────────────────────────────────────────────
// EAR Landmark indices (MediaPipe FaceMesh, 0-indexed)
// ─────────────────────────────────────────────────────────────────────────────

// Left eye
const L_EYE_LEFT = 33; // p1 — outer corner
const L_EYE_RIGHT = 133; // p4 — inner corner
const L_EYE_TOP_A = 160; // p2 — upper lid, outer
const L_EYE_TOP_B = 158; // p3 — upper lid, inner
const L_EYE_BOT_A = 144; // p6 — lower lid, outer
const L_EYE_BOT_B = 153; // p5 — lower lid, inner

// Right eye
const R_EYE_LEFT = 362; // p1 — inner corner
const R_EYE_RIGHT = 263; // p4 — outer corner
const R_EYE_TOP_A = 387; // p2 — upper lid, inner
const R_EYE_TOP_B = 385; // p3 — upper lid, outer
const R_EYE_BOT_A = 373; // p6 — lower lid, inner
const R_EYE_BOT_B = 380; // p5 — lower lid, outer

const BLINK_THRESHOLD = 0.2;
const PERCLOS_WINDOW_MS = 10_000;
const SIGNAL_THROTTLE_MS = 1_000;

// Iris landmarks (available only with refineLandmarks:true)
const L_IRIS_CENTER = 468;
const R_IRIS_CENTER = 473;

// Mouth landmarks
const MOUTH_UP = 13;
const MOUTH_DOWN = 14;
const MOUTH_LEFT = 61;
const MOUTH_RIGHT = 291;
const MAR_THRESHOLD = 0.15;

// Emotion / head landmarks
const L_BROW = 223;
const L_EYE_OUTER = 33;
const GLABELLA = 19;
const NOSE_BRIDGE = 9;
const NOSE_TIP = 4;

// Windows / thresholds for new signals
const ROLL_WINDOW_MS = 60_000;
const GAZE_OFFSCREEN_THRESHOLD = 0.35;
const HEAD_MOVE_THRESHOLD = 0.02;

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const _perclosBuffer = [];
let _blinkCount = 0;
let _eyeWasOpen = true;
let _lastSignalTime = 0;

// New rolling state
const _blinkTimestamps = []; // ms
const _gazeSamples = []; // {t, x}
const _headMoveTimestamps = []; // ms of frames with delta > threshold
let _noseLast = null; // {x, y}
let _focusAccumMs = 0;
let _focusStartedAt = null; // ms when gaze became on-screen
let _lastFrameTime = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function computeEAR(p1, p2, p3, p4, p5, p6) {
  const h = dist(p1, p4);
  if (h < 1e-6) return 0;
  return (dist(p2, p6) + dist(p3, p5)) / (2.0 * h);
}

function computePerclos() {
  const cutoff = Date.now() - PERCLOS_WINDOW_MS;
  while (_perclosBuffer.length > 0 && _perclosBuffer[0].timestamp < cutoff) {
    _perclosBuffer.shift();
  }
  if (_perclosBuffer.length === 0) return 0;
  return _perclosBuffer.filter((e) => e.closed).length / _perclosBuffer.length;
}

function _pruneOlder(arr, cutoff, key = null) {
  while (arr.length > 0) {
    const v = key ? arr[0][key] : arr[0];
    if (v < cutoff) arr.shift();
    else break;
  }
}

function computeEyeGaze(lm, irisIdx, outerIdx, innerIdx, topIdx, botIdx) {
  const iris = lm[irisIdx];
  const outer = lm[outerIdx];
  const inner = lm[innerIdx];
  const top = lm[topIdx];
  const bot = lm[botIdx];
  if (!iris || !outer || !inner || !top || !bot) return { gx: 0, gy: 0 };
  const cx = (outer.x + inner.x) / 2;
  const cy = (top.y + bot.y) / 2;
  const halfW = Math.abs(inner.x - outer.x) / 2;
  const halfH = Math.abs(bot.y - top.y) / 2;
  const gx = halfW > 1e-6 ? (iris.x - cx) / halfW : 0;
  const gy = halfH > 1e-6 ? (iris.y - cy) / halfH : 0;
  return { gx, gy };
}

function computeMAR(lm) {
  const up = lm[MOUTH_UP];
  const dn = lm[MOUTH_DOWN];
  const l = lm[MOUTH_LEFT];
  const r = lm[MOUTH_RIGHT];
  if (!up || !dn || !l || !r) return 0;
  const w = dist(l, r);
  if (w < 1e-6) return 0;
  return dist(up, dn) / w;
}

function classifyEmotion(lm) {
  const brow = lm[L_BROW];
  const eyeOuter = lm[L_EYE_OUTER];
  const glab = lm[GLABELLA];
  const nose = lm[NOSE_BRIDGE];
  const mL = lm[MOUTH_LEFT];
  const mR = lm[MOUTH_RIGHT];
  const mUp = lm[MOUTH_UP];
  if (!brow || !eyeOuter || !glab || !nose || !mL || !mR || !mUp) return "neutral";
  // Brow raise: brow y significantly above (smaller y) eye outer y
  const browRaise = eyeOuter.y - brow.y; // positive = raised
  // Brow furrow: small distance between glabella and nose bridge
  const furrow = dist(glab, nose);
  // Mouth corner drop: avg corner y minus upper-lip y (positive = corners below = frowning)
  const mouthCornerAvgY = (mL.y + mR.y) / 2;
  const mouthDrop = mouthCornerAvgY - mUp.y;

  if (browRaise > 0.035 || mouthDrop < -0.005) return "engaged";
  if (furrow < 0.025 || mouthDrop > 0.015) return "disengaged";
  return "neutral";
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-frame MediaPipe callback
// ─────────────────────────────────────────────────────────────────────────────

function onResults(results) {
  if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0)
    return;

  const lm = results.multiFaceLandmarks[0];

  const leftEAR = computeEAR(
    lm[L_EYE_LEFT],
    lm[L_EYE_TOP_A],
    lm[L_EYE_TOP_B],
    lm[L_EYE_RIGHT],
    lm[L_EYE_BOT_B],
    lm[L_EYE_BOT_A]
  );
  const rightEAR = computeEAR(
    lm[R_EYE_LEFT],
    lm[R_EYE_TOP_A],
    lm[R_EYE_TOP_B],
    lm[R_EYE_RIGHT],
    lm[R_EYE_BOT_B],
    lm[R_EYE_BOT_A]
  );
  const avgEAR = (leftEAR + rightEAR) / 2;
  const isClosed = avgEAR < BLINK_THRESHOLD;

  const now = Date.now();

  if (_eyeWasOpen && isClosed) {
    _blinkCount++;
    _blinkTimestamps.push(now);
  }
  _eyeWasOpen = !isClosed;

  _perclosBuffer.push({ timestamp: now, closed: isClosed });

  // ── Per-frame gaze + head metrics (always run, even when throttled) ──────
  const leftGaze = computeEyeGaze(
    lm,
    L_IRIS_CENTER,
    L_EYE_LEFT,
    L_EYE_RIGHT,
    L_EYE_TOP_A,
    L_EYE_BOT_A
  );
  const rightGaze = computeEyeGaze(
    lm,
    R_IRIS_CENTER,
    R_EYE_LEFT,
    R_EYE_RIGHT,
    R_EYE_TOP_A,
    R_EYE_BOT_A
  );
  const gazeX = (leftGaze.gx + rightGaze.gx) / 2;
  const gazeY = (leftGaze.gy + rightGaze.gy) / 2;
  const gazeOnScreen =
    Math.abs(gazeX) <= GAZE_OFFSCREEN_THRESHOLD &&
    Math.abs(gazeY) <= GAZE_OFFSCREEN_THRESHOLD;

  _gazeSamples.push({ t: now, x: gazeX });

  // Focus duration: accumulate continuous on-screen time; reset on off-screen
  if (gazeOnScreen) {
    if (_focusStartedAt === null) _focusStartedAt = now;
  } else {
    if (_focusStartedAt !== null) {
      _focusAccumMs += now - _focusStartedAt;
    }
    _focusStartedAt = null;
    _focusAccumMs = 0; // reset on gaze-off per spec
  }
  const focusDurationMs =
    _focusStartedAt !== null ? now - _focusStartedAt : _focusAccumMs;

  // Head movement: delta of nose-tip normalized position
  const nose = lm[NOSE_TIP];
  if (nose) {
    if (_noseLast) {
      const delta = Math.hypot(nose.x - _noseLast.x, nose.y - _noseLast.y);
      if (delta > HEAD_MOVE_THRESHOLD) _headMoveTimestamps.push(now);
    }
    _noseLast = { x: nose.x, y: nose.y };
  }

  // Mouth + emotion
  const mar = computeMAR(lm);
  const mouthActive = mar > MAR_THRESHOLD;
  const emotion = classifyEmotion(lm);

  _lastFrameTime = now;

  if (now - _lastSignalTime < SIGNAL_THROTTLE_MS) return;
  _lastSignalTime = now;

  const perclos = computePerclos();
  const invertedEAR = Math.max(0, 1 - avgEAR / 0.35);
  const combinedScore = Math.min(perclos * 0.7 + invertedEAR * 0.3, 1.0);

  // Rolling-window aggregates (60s)
  const rollCutoff = now - ROLL_WINDOW_MS;
  _pruneOlder(_blinkTimestamps, rollCutoff);
  _pruneOlder(_headMoveTimestamps, rollCutoff);
  _pruneOlder(_gazeSamples, rollCutoff, "t");

  const windowSec = Math.max(
    1,
    (now - (_gazeSamples.length > 0 ? _gazeSamples[0].t : now - ROLL_WINDOW_MS)) /
      1000
  );
  const blinkRate = (_blinkTimestamps.length / windowSec) * 60;
  const headMovementFreq = (_headMoveTimestamps.length / windowSec) * 60;

  // Gaze shift frequency: count sign changes in gazeX across samples
  let shifts = 0;
  let prevSign = 0;
  for (const s of _gazeSamples) {
    const sign = s.x > 0.05 ? 1 : s.x < -0.05 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) shifts++;
    if (sign !== 0) prevSign = sign;
  }
  const gazeShiftFreq = (shifts / windowSec) * 60;

  // ── postMessage to parent content script ──────────────────────────────────
  // chrome.runtime is NOT available inside an extension iframe loaded on a
  // host page. Instead we postMessage to the parent content script, which
  // does have chrome.runtime access and forwards the payload to the worker.
  window.parent.postMessage(
    {
      source: "focuslens-eye",
      type: "EYE_FATIGUE_SIGNAL",
      payload: {
        combinedScore,
        perclos,
        avgEAR,
        blinkCount: _blinkCount,
        blinkRate,
        gazeOnScreen,
        gazeX,
        gazeY,
        focusDurationMs,
        gazeShiftFreq,
        headMovementFreq,
        mouthActive,
        emotion,
        timestamp: now,
      },
    },
    "*"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Script loader
// ─────────────────────────────────────────────────────────────────────────────

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`FocusLens eye: failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-start on DOMContentLoaded
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const videoEl = document.getElementById("video");

    // ── 1. Load MediaPipe scripts in order ───────────────────────────────────
    // packed_assets_loader MUST come before face_mesh_solution.js so the
    // solution script can locate its binary data blob.
    // Paths are RELATIVE — this page shares the chrome-extension:// origin
    // with the assets/mediapipe/ directory, so no chrome.runtime.getURL needed.
    console.log("[FocusLens eye] Loading MediaPipe…");
    // Load in order: packed-assets loader first so face_mesh.js can find its data,
    // then face_mesh.js which defines window.FaceMesh.
    // These are the ACTUAL filenames shipped in @mediapipe/face_mesh npm package.
    await loadScript(
      "assets/mediapipe/face_mesh_solution_packed_assets_loader.js"
    );
    await loadScript("assets/mediapipe/face_mesh.js");

    // ── 2. Initialise FaceMesh ───────────────────────────────────────────────
    // locateFile maps internal MediaPipe asset requests to our extension directory.
    // The wasm/data files use the *_wasm_bin naming from the npm package.
    const faceMesh = new window.FaceMesh({
      locateFile: (file) => `assets/mediapipe/${file}`,
    });

    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    faceMesh.onResults(onResults);

    // ── 3. Start camera ───────────────────────────────────────────────────────
    // getUserMedia works here because this page runs in chrome-extension://
    // origin and the manifest declares "camera" in permissions.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: "user" },
    });

    videoEl.srcObject = stream;
    await videoEl.play();

    // ── 4. Drive the pipeline via rAF ─────────────────────────────────────────
    async function loop() {
      if (videoEl.readyState >= 2) {
        await faceMesh.send({ image: videoEl });
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    console.log("[FocusLens eye] Camera active, FaceMesh running");
    window.parent.postMessage(
      { source: "focuslens-eye", type: "EYE_READY" },
      "*"
    );
  } catch (err) {
    console.error("[FocusLens eye] Startup failed:", err);
    window.parent.postMessage(
      {
        source: "focuslens-eye",
        type: "EYE_ERROR",
        message: err.message,
      },
      "*"
    );
  }
});
