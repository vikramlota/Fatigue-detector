// Listen for TIER_CHANGE messages from the background worker and dispatch the tier event
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "TIER_CHANGE" && typeof message.tier === "number") {
      document.dispatchEvent(
        new CustomEvent("focuslens:tier", { detail: { tier: message.tier } })
      );
    }
  });
}
/**
 * src/content/adapter.js
 * ───────────────────────
 * DOM adapter — applies visual tier changes to the host page.
 *
 * Responsibility:
 *   - Inject the <style> tag and amber overlay div once on load.
 *   - Listen for 'focuslens:tier' custom events from signals.js.
 *   - On tier change: update styles, hide elements, adjust overlay, manage HUD.
 *
 * Design principles:
 *   - All DOM writes are batched inside requestAnimationFrame so we touch the
 *     layout tree at most once per frame, avoiding multiple forced reflows.
 *   - Elements are hidden via display:none + data-focuslens-hidden="true" so
 *     observer.js can re-hide elements added by SPAs after navigation.
 *   - The overlay is a single fixed-position div with pointer-events:none so
 *     it never intercepts user interaction.
 */

import { TIERS } from "../shared/presets.js";

// ─── Module state ─────────────────────────────────────────────────────────────

/**
 * Currently active tier index (-1 means unset / not yet received from worker).
 * Exported as a getter so observer.js can read it without creating a circular
 * dependency on this module's internals.
 */
let _currentTier = -1;

/** @returns {number} The active tier (0-3), or -1 if not yet initialised. */
export function currentTier() {
  return _currentTier;
}

/**
 * applyTier(tier)
 * Public API — called by observer.js after SPA navigation to re-apply hiding
 * on freshly-injected DOM nodes.
 *
 * @param {number} tier - 0-3
 */
export function applyTier(tier) {
  _doApply(tier, /* force= */ false);
}

// ─── DOM element references (injected once) ───────────────────────────────────
let _styleEl = null; // <style id="focuslens-styles">
let _overlayEl = null; // amber tint overlay
let _hudEl = null; // tier-3 floating HUD

// ─── Main-content detection helpers ──────────────────────────────────────────
function _clearMainContentMarkers() {
  document
    .querySelectorAll("[data-focuslens-main], [data-focuslens-main-chain]")
    .forEach((el) => {
      el.removeAttribute("data-focuslens-main");
      el.removeAttribute("data-focuslens-main-chain");
    });

  if (document.body) {
    document.body.classList.remove("focuslens-main-mode");
  }
}

function _scoreMainCandidate(el) {
  if (!el) return -1;
  if (el.id && el.id.startsWith("focuslens")) return -1;
  const textLen = (el.innerText || "").trim().length;
  if (textLen < 380) return -1;

  const paragraphs = el.querySelectorAll("p").length;
  const links = el.querySelectorAll("a").length;
  const headings = el.querySelectorAll("h1, h2, h3").length;
  const linkPenalty = links > 0 ? Math.min(links * 20, textLen * 0.5) : 0;

  return textLen + paragraphs * 140 + headings * 80 - linkPenalty;
}

function _findMainContentNode() {
  const preferred = [
    "main",
    "article",
    '[role="main"]',
    ".post-content",
    ".article-body",
    ".entry-content",
    ".content-body",
    "#content",
    "#main",
  ];

  const candidates = [];
  const seen = new Set();

  preferred.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        candidates.push(el);
      }
    });
  });

  if (candidates.length === 0) {
    document.querySelectorAll("section, div").forEach((el) => {
      if (seen.has(el)) return;
      if ((el.childElementCount || 0) < 5) return;
      const cls = (el.className || "").toString().toLowerCase();
      const id = (el.id || "").toLowerCase();
      if (
        cls.includes("footer") ||
        cls.includes("sidebar") ||
        cls.includes("nav") ||
        id.includes("footer") ||
        id.includes("sidebar") ||
        id.includes("nav")
      ) {
        return;
      }

      seen.add(el);
      candidates.push(el);
    });
  }

  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = _scoreMainCandidate(candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function _markMainContent(tier) {
  _clearMainContentMarkers();
  if (tier < 2 || !document.body) return;

  const mainNode = _findMainContentNode();
  if (!mainNode) return;

  mainNode.setAttribute("data-focuslens-main", "true");

  let cursor = mainNode;
  while (cursor && cursor !== document.body) {
    cursor.setAttribute("data-focuslens-main-chain", "true");
    cursor = cursor.parentElement;
  }

  document.body.classList.add("focuslens-main-mode");
}

// ─── One-time DOM injection ───────────────────────────────────────────────────
function _injectShell() {
  // ── <style> tag ──────────────────────────────────────────────────────────
  _styleEl = document.getElementById("focuslens-styles");
  if (!_styleEl) {
    _styleEl = document.createElement("style");
    _styleEl.id = "focuslens-styles";
    document.head.appendChild(_styleEl);
  }

  // ── Amber overlay ─────────────────────────────────────────────────────────
  _overlayEl = document.getElementById("focuslens-overlay");
  if (!_overlayEl) {
    _overlayEl = document.createElement("div");
    _overlayEl.id = "focuslens-overlay";
    Object.assign(_overlayEl.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      background: "rgba(255, 180, 50, 0)", // Alpha starts at 0
      mixBlendMode: "multiply",
      zIndex: "2147483646",
      transition: "background 0.4s ease",
    });
    document.body.appendChild(_overlayEl);
  }
}

// Inject as soon as possible — DOMContentLoaded if not already fired,
// otherwise immediately.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _injectShell);
} else {
  _injectShell();
}

// ─── Tier-change event listener ───────────────────────────────────────────────
document.addEventListener("focuslens:tier", (e) => {
  const newTier = e.detail?.tier;
  if (typeof newTier !== "number") return;
  _doApply(newTier, /* force= */ false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Core apply logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * _doApply(tier, force)
 *
 * @param {number}  tier  - Target tier (0-3)
 * @param {boolean} force - If true, re-apply even if tier hasn't changed
 *                          (used by observer.js after SPA navigation)
 */
function _doApply(tier, force) {
  if (!force && tier === _currentTier) return; // No-op if tier unchanged
  _currentTier = tier;

  const config = TIERS[tier];
  if (!config) {
    console.warn("[FocusLens] Unknown tier:", tier);
    return;
  }

  // Batch all DOM writes in a single rAF to avoid multiple layout flushes
  requestAnimationFrame(() => {
    // Ensure shell elements exist (can be null if called before DOMContentLoaded)
    if (!_styleEl || !_overlayEl) _injectShell();

    // ── 1. Restore previously hidden elements ────────────────────────────────
    document.querySelectorAll("[data-focuslens-hidden]").forEach((el) => {
      el.style.removeProperty("display");
      el.removeAttribute("data-focuslens-hidden");
    });
    _clearMainContentMarkers();

    // ── 2. Inject tier CSS ───────────────────────────────────────────────────
    _styleEl.innerHTML = config.styles;

    // Mark the most likely article/content block for selective rendering tiers
    _markMainContent(tier);

    // ── 3. Apply hide selectors ──────────────────────────────────────────────
    for (const selector of config.hideSelectors) {
      try {
        document.querySelectorAll(selector).forEach((el) => {
          // Skip extension-injected elements
          if (el.id && el.id.startsWith("focuslens")) return;
          el.style.setProperty("display", "none", "important");
          el.setAttribute("data-focuslens-hidden", "true");
        });
      } catch (err) {
        // Malformed selector (e.g. :has() unsupported in older Chrome) — skip
        // silent
      }
    }

    // ── 4. Update amber overlay opacity ──────────────────────────────────────
    const overlayAlphas = [0, 0.04, 0.07, 0.1];
    const alpha = overlayAlphas[tier] ?? 0;
    _overlayEl.style.background = `rgba(255, 180, 50, ${alpha})`;

    // Reinforce root-level paint and color-scheme (sites often override body)
    const root = document.documentElement;
    if (tier >= 3) {
      root.style.setProperty("background-color", "#161513", "important");
      root.style.setProperty("color-scheme", "dark");
    } else if (tier >= 2) {
      root.style.setProperty("background-color", "#23211e", "important");
      root.style.setProperty("color-scheme", "dark");
    } else {
      root.style.removeProperty("background-color");
      root.style.removeProperty("color-scheme");
    }

    // ── 5. Pause all media at tier 2+ ────────────────────────────────────────
    if (tier >= 2) {
      document.querySelectorAll("video, audio").forEach((m) => {
        try {
          m.pause();
        } catch (_) {
          /* ignore cross-origin frames */
        }
      });
    }

    // ── 6. Manage floating HUD (tier 3 only) ──────────────────────────────────
    _updateHud(tier);

    // ── 7. Ollama summarisation at tier >=2 (async, non-blocking) ─────────────
    if (tier >= 2) {
      _summarizeReadingContent().catch(() => {});
    } else {
      _restoreSummarizedContent();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama summarisation — replaces long paragraphs with 1-2 sentence summaries
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_URL = "http://localhost:11434/api/generate";
const OLLAMA_MODEL = "llama3.2";
const SUMMARY_MIN_LEN = 250;
const SUMMARY_MAX_PARAS = 8;

function _restoreSummarizedContent() {
  document.querySelectorAll("[data-focuslens-original]").forEach((el) => {
    const html = el.dataset.focuslensOriginal;
    if (typeof html === "string") {
      el.innerHTML = html;
      delete el.dataset.focuslensOriginal;
    }
  });
}

async function _summarizeReadingContent() {
  const main = _findMainContentNode();
  if (!main) return;
  const paragraphs = Array.from(main.querySelectorAll("p"))
    .filter(
      (p) =>
        !p.dataset.focuslensOriginal &&
        (p.innerText || "").length > SUMMARY_MIN_LEN
    )
    .slice(0, SUMMARY_MAX_PARAS);

  for (const p of paragraphs) {
    const originalHTML = p.innerHTML;
    const originalText = p.innerText;
    p.dataset.focuslensOriginal = originalHTML;
    p.innerHTML =
      '<span style="opacity:0.5;font-style:italic">\u27F3 Simplifying for focus mode\u2026</span>';

    fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt:
          "Summarize this in 1-2 very simple sentences a tired person can read at a glance:\n\n" +
          originalText,
        stream: false,
      }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad response"))))
      .then((data) => {
        const summary = (data && data.response ? String(data.response) : "").trim();
        if (!summary) {
          p.innerHTML = originalHTML;
          delete p.dataset.focuslensOriginal;
          return;
        }
        p.innerHTML =
          '<span data-focuslens-summary="true" style="display:block;background:rgba(240,192,64,0.12);border-left:3px solid #f0c040;padding:10px 14px;border-radius:0 6px 6px 0;line-height:1.6">' +
          '<span style="font-size:11px;opacity:0.55;letter-spacing:0.05em;text-transform:uppercase;display:block;margin-bottom:4px">focus summary</span>' +
          _escapeHTML(summary) +
          '<button style="float:right;font-size:11px;background:none;border:1px solid rgba(255,255,255,0.2);border-radius:4px;padding:2px 8px;cursor:pointer;opacity:0.6;margin-top:2px" onclick="focuslensRestore(this)">show full</button>' +
          "</span>";
      })
      .catch((err) => {
        // Ollama likely not running — silently restore original.
        console.warn("[FocusLens] Ollama summarise failed:", err && err.message);
        p.innerHTML = originalHTML;
        delete p.dataset.focuslensOriginal;
      });
  }
}

function _escapeHTML(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Inject restore hook into page scope (inline onclick needs a page-scope function).
if (!window.focuslensRestore) {
  const script = document.createElement("script");
  script.textContent =
    "window.focuslensRestore = function(btn){" +
    "  var host = btn.closest('[data-focuslens-original]');" +
    "  if (host && host.dataset.focuslensOriginal) {" +
    "    host.innerHTML = host.dataset.focuslensOriginal;" +
    "    delete host.dataset.focuslensOriginal;" +
    "  }" +
    "};";
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// ── DevTools / demo global ────────────────────────────────────────────────────
// Open any page's DevTools console and run:
//   __focuslens.setTier(3)  → severe dark mode instantly
//   __focuslens.reset()     → full restore
window.__focuslens = {
  setTier: (t) => {
    _currentTier = -1;
    _doApply(t, true);
  },
  getTier: () => _currentTier,
  reset: () => {
    _currentTier = -1;
    _doApply(0, true);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Floating HUD
// ─────────────────────────────────────────────────────────────────────────────

const HUD_DISMISSED_KEY = "focuslens_hud_dismissed";

function _updateHud(tier) {
  if (tier < 3) {
    // Hide the HUD for non-severe tiers
    if (_hudEl) _hudEl.style.display = "none";
    return;
  }

  // Don't show HUD if the user dismissed it this session
  if (sessionStorage.getItem(HUD_DISMISSED_KEY) === "1") return;

  if (!_hudEl) {
    _hudEl = document.createElement("div");
    _hudEl.id = "focuslens-hud";
    Object.assign(_hudEl.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "2147483647",
      background: "#f0c040",
      color: "#1a1a1a",
      padding: "14px 16px",
      borderRadius: "10px",
      fontFamily: "system-ui, sans-serif",
      fontSize: "14px",
      lineHeight: "1.5",
      maxWidth: "260px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
      transition: "opacity 0.3s ease",
    });

    // ── Message ────────────────────────────────────────────────────────────
    const msg = document.createElement("p");
    msg.style.cssText = "margin:0 0 10px 0; font-weight:600;";
    msg.textContent = "⚠ High fatigue detected — display simplified";
    _hudEl.appendChild(msg);

    const sub = document.createElement("p");
    sub.style.cssText = "margin:0 0 10px 0; font-size:12px; opacity:0.75;";
    sub.textContent =
      "FocusLens has reduced visual complexity to help you focus.";
    _hudEl.appendChild(sub);

    // ── Dismiss button ─────────────────────────────────────────────────────
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      display: "block",
      width: "100%",
      padding: "6px",
      border: "2px solid #1a1a1a",
      borderRadius: "6px",
      background: "transparent",
      cursor: "pointer",
      fontSize: "13px",
      fontWeight: "600",
    });
    btn.textContent = "Dismiss";
    btn.addEventListener("click", () => {
      sessionStorage.setItem(HUD_DISMISSED_KEY, "1");
      _hudEl.style.opacity = "0";
      setTimeout(() => {
        if (_hudEl) _hudEl.style.display = "none";
      }, 300);
    });
    _hudEl.appendChild(btn);

    document.body.appendChild(_hudEl);
  }

  _hudEl.style.display = "block";
  _hudEl.style.opacity = "1";
}
