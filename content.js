// content.js

const IS_TWITTER = location.hostname.includes("x.com") || location.hostname.includes("twitter.com");
const IS_LINKEDIN = location.hostname.includes("linkedin.com");
const IS_REDDIT = location.hostname.includes("reddit.com");
const IS_THREADS = location.hostname.includes("threads.com") || location.hostname.includes("threads.net");
const PAGE_HOSTNAME = location.hostname;
const PLATFORM = IS_TWITTER ? "twitter"
  : IS_LINKEDIN ? "linkedin"
  : IS_REDDIT ? "reddit"
  : IS_THREADS ? "threads"
  : "universal";

// Sites with hand-tuned DOM adapters vs. those still relying on the generic
// universal fallback. Beta sites work but detection is less precise — surfaced
// in the settings UI so users know what to expect.
const TUNED_PLATFORMS = ["twitter", "linkedin"];
const IS_BETA_PLATFORM = !TUNED_PLATFORMS.includes(PLATFORM) && PLATFORM !== "universal";

// Minimum post length to even consider for classification. Posts below this
// floor are skipped entirely — they don't carry enough signal for the model
// to reliably distinguish authentic chatter from short slop, and trying
// burns AI tokens on conversational replies that are usually fine.
// The prompt itself also has length-aware guidance for posts in the
// "short but worth classifying" range (see buildPrompt in background.js).
const MIN_POST_CHARS = 20;

// ── Settings ──────────────────────────────────────────────────────────────
let settings = {
  darkMode: false, showTrashCan: true,
  minConfidence: 80, hideSlop: false,
  excludedSites: [], // user-added hostnames to skip even among supported sites
  showTrainingButtons: true, // show "Confirm slop" / "Not slop" training buttons
  nonIntrusiveMode: false,    // hide slop quietly — no banners, no training UI
  removeEntirely: false,      // when hiding, remove the element from the DOM completely
};
let isPaused = false;

// Per-site pause: { [hostname]: "session" | "forever" }
// "session" = in-memory only, "forever" = persisted in storage
const sessionPausedSites = new Set();

function isSitePaused() {
  return sessionPausedSites.has(PAGE_HOSTNAME);
}

// ── Logging ───────────────────────────────────────────────────────────────
// srLog() both prints to the console AND forwards the line to the background
// worker, which keeps a ring buffer that the Settings page renders as a live
// log window. This replaces scattered console.log calls.
function srLog(...args) {
  const msg = args.map(a =>
    typeof a === "string" ? a : JSON.stringify(a)
  ).join(" ");
  console.log("[SlopRadar]", msg);
  try {
    chrome.runtime.sendMessage({
      action: "log",
      line: msg,
      host: PAGE_HOSTNAME,
      ts: Date.now(),
    }).catch(() => {});
  } catch (_) {}
}

function loadSettings(cb) {
  chrome.runtime.sendMessage({ action: "getSettings" }, (s) => {
    if (!chrome.runtime.lastError && s) settings = { ...settings, ...s };
    if (cb) cb();
  });
  chrome.runtime.sendMessage({ action: "getPauseState" }, (res) => {
    if (!chrome.runtime.lastError && res) isPaused = !!res.paused;
  });
  // Check if this site is forever-paused
  chrome.runtime.sendMessage({ action: "getSitePause", hostname: PAGE_HOSTNAME }, (res) => {
    if (!chrome.runtime.lastError && res?.paused) {
      sessionPausedSites.add(PAGE_HOSTNAME);
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "settingsUpdated") {
    const prev = settings;
    settings = { ...settings, ...request.settings };
    applyTheme(IS_TWITTER ? "dark" : (settings.darkMode ? "dark" : "light"));
    // Display-mode changes must re-render already-flagged cards — otherwise
    // switching e.g. "banner" → "remove entirely" leaves existing slop cards
    // showing the old treatment (they're already in evaluatedWrappers and
    // would never be reprocessed). Detect a relevant change and reapply.
    const displayChanged =
      prev.hideSlop !== settings.hideSlop ||
      prev.removeEntirely !== settings.removeEntirely ||
      prev.nonIntrusiveMode !== settings.nonIntrusiveMode ||
      prev.showTrainingButtons !== settings.showTrainingButtons;
    if (displayChanged) reapplyAllSlopCards();
  }
  if (request.action === "queueSize") { currentQueueSize = request.size; }
  if (request.action === "getPageStats") {
    sendResponse({ pageStats, queueSize: currentQueueSize });
    return true;
  }
  if (request.action === "pauseStateChanged") {
    isPaused = request.paused;
    if (!isPaused && !isSitePaused()) scheduleDrain();
  }
  if (request.action === "pauseSiteSession") {
    sessionPausedSites.add(PAGE_HOSTNAME);
    pendingNodes.length = 0;
    inFlightDrains = 0;
    showSitePauseBanner();
  }
  if (request.action === "markRightClickedAsSlop") {
    markRightClickedAsSlop(request.selectionText || "");
  }
});

// ── Right-click target tracking ───────────────────────────────────────────
// We remember the element under the most recent right-click so the
// background context-menu click handler can act on it. The contextmenu
// event fires before the menu opens, so lastRightClicked is always fresh.
let lastRightClicked = null;
document.addEventListener("contextmenu", (e) => {
  lastRightClicked = e.target;
}, true);

// Resolve the post wrapper from whatever was right-clicked, then teach the
// model from it and remove it immediately — the "Block this ad" workflow.
function markRightClickedAsSlop(selectionText) {
  let wrapper = null;

  // Prefer the post that contains the right-clicked node.
  if (lastRightClicked && lastRightClicked.nodeType === Node.ELEMENT_NODE) {
    // Find a text node inside the clicked element to resolve the wrapper.
    const probe = lastRightClicked.closest?.(
      'article, [data-urn], [data-id], .feed-shared-update-v2, .occludable-update'
    );
    if (probe) {
      wrapper = probe;
    } else {
      // Walk up looking for something getPostWrapper recognises.
      let el = lastRightClicked;
      for (let i = 0; i < 12 && el && el.tagName !== "BODY"; i++) {
        const w = getPostWrapper(el);
        if (w) { wrapper = w; break; }
        el = el.parentElement;
      }
    }
  }

  // The post text: prefer the wrapper's text, fall back to any selection.
  const postText = (
    (wrapper && wrapper.textContent) ||
    selectionText ||
    (lastRightClicked && lastRightClicked.textContent) ||
    ""
  ).trim().substring(0, 800);

  if (postText.length < 20) {
    srLog("right-click teach: couldn't find post text — nothing taught");
    return;
  }

  // 1. Remove / mark the element immediately (don't wait for the model).
  if (wrapper) {
    resetWrapper(wrapper);
    applySlop(wrapper, 95, ["user marked as slop"]); // user override — high confidence
    srLog(`right-click: marked post as slop — "${postText.substring(0, 50)}…"`);
  }

  // 2. Teach the model in the background — modular userTaughtPatterns bucket.
  chrome.runtime.sendMessage(
    { action: "teachMissedPost", postText },
    (res) => {
      if (chrome.runtime.lastError || !res) {
        srLog("right-click teach: background did not respond");
        return;
      }
      if (res.ok && res.patterns && res.patterns.length > 0) {
        srLog(`right-click teach: learned ${res.patterns.length} new pattern(s): ` +
          res.patterns.join(" | "));
      } else {
        srLog(`right-click teach: ${res.note || res.reason || "no new patterns"}`);
      }
    }
  );
}

// ── Tab ID + lifecycle ────────────────────────────────────────────────────
let MY_TAB_ID = -1;
chrome.runtime.sendMessage({ action: "getTabId" }, (res) => {
  if (chrome.runtime.lastError) return;
  MY_TAB_ID = res?.tabId ?? -1;
  chrome.runtime.sendMessage({ action: "contentActive" }).catch(() => {});
});

window.addEventListener("beforeunload", () => {
  chrome.runtime.sendMessage({ action: "tabRefreshing", tabId: MY_TAB_ID }).catch(() => {});
});

// SPA nav flush — polled rather than observed (an observer on `document`
// is another fingerprintable signal for LinkedIn's integrity script).
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    flushQueue();
    chrome.runtime.sendMessage({ action: "tabRefreshing", tabId: MY_TAB_ID }).catch(() => {});
  }
}, 600);

function flushQueue() {
  pendingNodes.length = 0;
  targetedTextNodes.clear();
  // NOTE: we deliberately do NOT clear verdictCache here. It is keyed on
  // post text, so keeping it across SPA navigation is exactly what lets a
  // returning page be re-stamped instantly without re-running the AI.
  // evaluatedWrappers is a WeakSet — it self-empties as detached nodes
  // are garbage-collected after navigation.
  srLog("Queue flushed (verdict cache kept)");
}

// ── Page stats ────────────────────────────────────────────────────────────
const pageStats = { checked: 0, slop: 0 };
function recordResult(isSlop) {
  pageStats.checked++;
  if (isSlop) pageStats.slop++;
  chrome.runtime.sendMessage({ action: "recordResult", hostname: PAGE_HOSTNAME, isSlop }).catch(() => {});
}

// ── Verdict cache — keyed on POST TEXT, not DOM element ───────────────────
// X (and LinkedIn) destroy and rebuild feed DOM nodes on back-navigation,
// so an element-keyed WeakMap forgets everything the moment you navigate.
// Keying on a hash of the post's text means a verdict survives navigation:
// when the same post reappears in a brand-new wrapper element, we recognise
// it instantly and re-stamp it without re-running the AI.
const verdictCache = new Map(); // textHash → {isSlop, confidence, ts}
const VERDICT_CACHE_MAX = 600;  // cap memory; oldest entries evicted

function hashPostText(text) {
  // Normalize: collapse whitespace, lowercase, trim to a stable prefix.
  const norm = (text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 280);
  // djb2 — fast, good enough for dedup keys
  let h = 5381;
  for (let i = 0; i < norm.length; i++) {
    h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
  }
  return `${h}:${norm.length}`;
}

function cacheGetVerdict(text) {
  const v = verdictCache.get(hashPostText(text));
  return v || null;
}

function cacheSetVerdict(text, isSlop, confidence, reasons, belowThreshold) {
  const key = hashPostText(text);
  verdictCache.set(key, {
    isSlop,
    confidence,
    reasons: Array.isArray(reasons) ? reasons : [],
    // True when isSlop=true but confidence is below the user's threshold
    // at classification time. The cache hit path checks this against the
    // CURRENT threshold to decide whether to actually paint the banner.
    // Lets a user dial the threshold down and have prior verdicts kick in
    // without needing to re-AI everything.
    belowThreshold: !!belowThreshold,
    ts: Date.now(),
  });
  // Evict oldest if over cap
  if (verdictCache.size > VERDICT_CACHE_MAX) {
    const oldest = verdictCache.keys().next().value;
    verdictCache.delete(oldest);
  }
  schedulePersist();
}

// ── Viewport-priority queue ───────────────────────────────────────────────
let pendingNodes = [];
// WeakSet so we don't permanently retain every text node we've ever seen —
// the platform recycles these aggressively and we don't need them after the
// node is removed from the DOM. (Was a regular Set previously, which leaked
// references to dead text nodes across the whole session.)
const targetedTextNodes = new WeakSet();
const evaluatedWrappers = new WeakSet();
const nodeTextSnapshot = new WeakMap(); // textNode → last seen text (recycle detection)
let currentQueueSize = 0;

// ── Verdict cache persistence ─────────────────────────────────────────────
// The in-memory `verdictCache` evaporates when the tab closes. We persist
// it to chrome.storage.local so a reload doesn't have to reclassify every
// post in the feed — on startup we restore the Map and re-apply known
// verdicts immediately, then only new posts hit the AI.
//
// Layout in storage:
//   { srVerdictCache: { [hashKey]: { isSlop, confidence, reasons, ts } } }
//
// GC strategy:
//   • Drop entries older than VERDICT_TTL_MS on every persist.
//   • If still over cap after age-pruning, drop oldest by ts until under.
//   • Debounce writes (5s coalescing) — applying verdicts in bursts during
//     scroll shouldn't thrash storage.
// v2: write/read keys are now hashes of the BODY text only, not the whole
// wrapper text (which included avatar/timestamp/engagement-counts and made
// every lookup miss). The old "srVerdictCache" key is left in storage and
// will be cleaned up the next time someone uses the chrome.storage quota,
// but we don't try to migrate entries — they were keyed under a completely
// different hash function input and aren't usable.
const VERDICT_STORAGE_KEY = "srVerdictCache_v2";
const VERDICT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const VERDICT_PERSIST_CAP = 2000;               // hard ceiling in storage
const PERSIST_DEBOUNCE_MS = 5000;

let persistTimer = null;
let cacheRestored = false;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(persistVerdictCache, PERSIST_DEBOUNCE_MS);
}

function gcCache() {
  const cutoff = Date.now() - VERDICT_TTL_MS;
  // Drop expired entries first.
  for (const [k, v] of verdictCache) {
    if (!v || (v.ts && v.ts < cutoff)) verdictCache.delete(k);
  }
  // Then enforce the cap by ts (oldest first). Map preserves insertion order
  // but we want true oldest-by-ts in case entries were restored out of order.
  if (verdictCache.size > VERDICT_PERSIST_CAP) {
    const sorted = [...verdictCache.entries()]
      .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const drop = sorted.slice(0, verdictCache.size - VERDICT_PERSIST_CAP);
    for (const [k] of drop) verdictCache.delete(k);
  }
}

function persistVerdictCache() {
  persistTimer = null;
  if (!chrome?.storage?.local) return;
  gcCache();
  // Convert Map → plain object for storage. Each entry stays tiny
  // (few-byte hash key + small JSON value).
  const obj = {};
  for (const [k, v] of verdictCache) obj[k] = v;
  try {
    chrome.storage.local.set({ [VERDICT_STORAGE_KEY]: obj });
  } catch (_) {}
}

// Flush opportunistically — when the tab is closing or hidden, write
// anything we have so a reload picks up the very latest verdicts.
window.addEventListener("beforeunload", () => {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  persistVerdictCache();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    persistVerdictCache();
    return;
  }
  // Visible again. Two things may have gone stale while we were hidden:
  // (1) X's SPA navigation tore down articles we had in-flight, leaving
  //     pipeline slots blocked on callbacks that may never fire. The
  //     drain watchdog will eventually clear them, but we can also kick
  //     pumpDrain now — if there's queue work and pipeline capacity, it
  //     runs immediately.
  // (2) Sweeps fire on a timer even when hidden, but X often holds back
  //     DOM updates for backgrounded tabs and the visible feed has new
  //     posts the next sweep should pick up. Force one immediately.
  if (!isPaused && !isSitePaused()) {
    safeSweep();
    pumpDrain();
  }
});

// Load any persisted verdicts into the in-memory cache on startup.
function restoreVerdictCache(cb) {
  if (!chrome?.storage?.local) { cacheRestored = true; cb?.(); return; }
  chrome.storage.local.get([VERDICT_STORAGE_KEY, "srVerdictCache"], (data) => {
    if (chrome.runtime.lastError) { cacheRestored = true; cb?.(); return; }
    // Opportunistic cleanup: drop the stale v1 cache key (entries hashed
    // under the old wrapper-text key scheme that never matches the new
    // body-text lookup). Fire-and-forget; we don't block on it.
    if (data.srVerdictCache) {
      try { chrome.storage.local.remove("srVerdictCache"); } catch (_) {}
    }
    const obj = data[VERDICT_STORAGE_KEY] || {};
    const cutoff = Date.now() - VERDICT_TTL_MS;
    let loaded = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v !== "object") continue;
      if (v.ts && v.ts < cutoff) continue;       // skip expired on load
      verdictCache.set(k, v);
      loaded++;
    }
    cacheRestored = true;
    if (loaded > 0) srLog(`restored ${loaded} cached verdict(s) from storage`);
    cb?.();
  });
}

// ── Viewport scoring ──────────────────────────────────────────────────────
function viewportScore(el) {
  try {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    if (rect.top >= 0 && rect.bottom <= vh) return 0;
    if (rect.top > vh) return rect.top - vh;
    return Math.abs(rect.bottom) + 10000;
  } catch (_) { return 99999; }
}

function sortPendingByViewport() {
  pendingNodes.sort((a, b) => viewportScore(a.wrapper) - viewportScore(b.wrapper));
}

window.addEventListener("scroll", () => { sortPendingByViewport(); }, { passive: true });

// ── Theme ─────────────────────────────────────────────────────────────────
function applyTheme(mode) {
  document.documentElement.setAttribute("data-sr-theme", mode);
}

// ── Styles ────────────────────────────────────────────────────────────────
const slopStyle = document.createElement("style");
slopStyle.textContent = `
  :root, [data-sr-theme="light"] {
    --sr-bg:#fff; --sr-border:#e5e7eb; --sr-text2:#6b7280;
    --sr-red:#e02424; --sr-red-dim:rgba(224,36,36,0.07); --sr-red-border:rgba(224,36,36,0.3);
    --sr-green:#137333; --sr-green-bg:#f0fdf4; --sr-green-border:#86efac;
    --sr-shadow:0 1px 3px rgba(0,0,0,0.08);
    --sr-btn-bg:#fff; --sr-btn-hover:#f3f4f6;
  }
  [data-sr-theme="dark"] {
    --sr-bg:#16202a; --sr-border:#2f3336; --sr-text2:#71767b;
    --sr-red:#f4212e; --sr-red-dim:rgba(244,33,46,0.13); --sr-red-border:rgba(244,33,46,0.4);
    --sr-green:#00ba7c; --sr-green-bg:rgba(0,186,124,0.1); --sr-green-border:rgba(0,186,124,0.35);
    --sr-shadow:0 1px 4px rgba(0,0,0,0.4);
    --sr-btn-bg:#1e2732; --sr-btn-hover:#2a3441;
  }

  .slop_radar_card { position: relative !important; }

  /* ── Slop: horizontal banner + blur cover ── */
  .slop_dog_ear {
    position: absolute !important;
    top: 0 !important; left: 0 !important; right: 0 !important;
    background: var(--sr-red) !important;
    display: flex !important; flex-wrap: wrap !important; align-items: center !important; gap: 10px !important;
    padding: 8px 14px !important;
    z-index: 99999 !important; pointer-events: none !important;
    box-shadow: 0 2px 12px rgba(224,36,36,0.35) !important;
    box-sizing: border-box !important;
  }
  /* hideSlop mode: card fully hidden, only banner visible */
  .sr_hide_mode .slop_dog_ear { position: static !important; }
  .sr_hide_mode[data-slop-detected="true"]:not([data-sr-revealed]) {
    height: auto !important; max-height: none !important;
    overflow: visible !important;
  }
  .sr_hide_mode[data-slop-detected="true"]:not([data-sr-revealed]) > *:not(.slop_dog_ear) {
    display: none !important;
  }
  .slop_dog_ear_ribbon {
    display: flex !important; flex-direction: row !important;
    align-items: center !important; gap: 8px !important;
    pointer-events: none !important; user-select: none !important; flex: 1 !important;
  }
  .slop_dog_ear_ribbon .sr-main {
    color: #fff !important; font-size: 0.85rem !important; font-weight: 900 !important;
    letter-spacing: 0.12rem !important; text-transform: uppercase !important; white-space: nowrap !important;
  }
  .slop_dog_ear_ribbon .sr-sub {
    color: rgba(255,255,255,0.75) !important; font-size: 0.7rem !important;
    font-weight: 600 !important; white-space: nowrap !important;
  }
  /* "Why this is slop" — short list of model reasons. Spans the banner
     under the ribbon so it stays visible while the post body is blurred. */
  .slop_dog_ear_reasons {
    flex-basis: 100% !important;
    color: rgba(255,255,255,0.92) !important;
    font-size: 0.68rem !important; font-weight: 500 !important;
    line-height: 1.35 !important;
    padding: 4px 2px 0 2px !important;
    border-top: 1px solid rgba(255,255,255,0.2) !important;
    margin-top: 4px !important;
    user-select: text !important;
  }
  .sr_blur_cover {
    position: absolute !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
    backdrop-filter: blur(8px) !important; -webkit-backdrop-filter: blur(8px) !important;
    background: rgba(0,0,0,0.08) !important;
    z-index: 99998 !important; pointer-events: none !important;
  }
  [data-sr-revealed] .sr_blur_cover { display: none !important; }

  .slop_radar_controls {
    display: flex !important; align-items: center !important; gap: 6px !important;
    margin-left: auto !important; pointer-events: auto !important;
    z-index: 100001 !important; flex-shrink: 0 !important;
  }
  .slop_radar_btn {
    font-size: 0.72rem !important; font-weight: 800 !important;
    cursor: pointer !important; border-radius: 5px !important; padding: 4px 11px !important;
    pointer-events: auto !important; z-index: 100002 !important;
    white-space: nowrap !important; line-height: 1.5 !important;
    transition: opacity 0.12s !important;
    background: rgba(255,255,255,0.18) !important; color: #fff !important;
    border: 1px solid rgba(255,255,255,0.35) !important; box-shadow: none !important;
  }
  .slop_radar_btn:hover { background: rgba(255,255,255,0.28) !important; }

  /* Confirm-slop training button — slightly greener accent so it reads as
     a positive/confirming action distinct from "Show anyway". */
  .slop_radar_btn.sr_confirm_btn {
    background: rgba(255,255,255,0.22) !important;
  }
  .slop_radar_btn.sr_confirmed {
    background: rgba(120,220,140,0.32) !important;
    border-color: rgba(160,240,180,0.55) !important;
    cursor: default !important;
  }

  /* When revealed: the banner stays position:absolute at top:0 of the
     wrapper. To make room for it without breaking X's flex-row layout
     (where padding-top on the article gets ignored relative to its
     children's positioning), we inject a spacer DIV as the article's
     first child. The spacer's height equals --sr-banner-h, kept in sync
     by ResizeObserver on the banner.

     If the wrapper is a flex container (X's tweet article), we force
     flex-wrap:wrap so the spacer claims its own row above the avatar
     and content. The spacer's flex-basis:100% then makes it take the
     entire row width. On block-layout wrappers (LinkedIn, Reddit) the
     spacer is just a block element that takes its natural row. */
  [data-sr-revealed] {
    flex-wrap: wrap !important;
  }
  [data-sr-revealed] > .sr_reveal_spacer {
    display: block !important;
    width: 100% !important;
    flex-basis: 100% !important;
    flex-shrink: 0 !important;
    height: var(--sr-banner-h, 96px) !important;
    order: -1 !important;             /* claim the topmost row in flex */
    transition: height 0.15s ease-out !important;
  }
  /* When not revealed, the spacer is irrelevant. */
  :not([data-sr-revealed]) > .sr_reveal_spacer {
    display: none !important;
  }
  /* Banner stays absolute regardless of revealed state — it overlays
     either the spacer (revealed) or the blurred card (collapsed). */
  [data-sr-revealed] > .slop_dog_ear,
  [data-sr-revealed] .slop_dog_ear:first-child {
    position: absolute !important;
    top: 0 !important; left: 0 !important; right: 0 !important;
    width: auto !important;
    display: flex !important;
    flex-basis: auto !important;
    order: 0 !important;
  }

  /* LinkedIn/universal/reddit/threads collapse */
  .slop_radar_linkedin[data-slop-detected="true"]:not([data-sr-revealed]):not(.sr_hide_mode),
  .slop_radar_universal[data-slop-detected="true"]:not([data-sr-revealed]):not(.sr_hide_mode),
  .slop_radar_reddit[data-slop-detected="true"]:not([data-sr-revealed]):not(.sr_hide_mode),
  .slop_radar_threads[data-slop-detected="true"]:not([data-sr-revealed]):not(.sr_hide_mode) {
    max-height: 80px !important; overflow: hidden !important;
  }
  .slop_radar_linkedin[data-slop-detected="true"][data-sr-revealed],
  .slop_radar_universal[data-slop-detected="true"][data-sr-revealed],
  .slop_radar_reddit[data-slop-detected="true"][data-sr-revealed],
  .slop_radar_threads[data-slop-detected="true"][data-sr-revealed] {
    max-height: 3000px !important; overflow: visible !important;
  }

  /* ── NOT SLOP: bottom-right horizontal tag ── */
  .not_slop_dog_ear {
    position: absolute !important; bottom: 8px !important; right: 8px !important;
    display: flex !important; align-items: center !important; gap: 6px !important;
    pointer-events: none !important; z-index: 99999 !important;
  }
  .not_slop_ribbon {
    display: inline-flex !important; align-items: center !important; gap: 4px !important;
    padding: 4px 10px !important;
    background: var(--sr-green-bg) !important; border: 1px solid var(--sr-green-border) !important;
    border-radius: 6px !important; font-size: 0.68rem !important; font-weight: 800 !important;
    color: var(--sr-green) !important; white-space: nowrap !important;
    pointer-events: none !important; user-select: none !important;
    box-shadow: 0 1px 4px rgba(0,0,0,0.1) !important;
  }
  .not_slop_ribbon .sr-sub {
    font-weight: 600 !important; opacity: 0.75 !important; font-size: 0.63rem !important;
  }
  .not_slop_trash_btn {
    pointer-events: auto !important; background: var(--sr-btn-bg) !important;
    border: 1px solid var(--sr-border) !important; border-radius: 5px !important;
    width: 26px !important; height: 26px !important;
    display: flex !important; align-items: center !important; justify-content: center !important;
    font-size: 0.8rem !important; cursor: pointer !important;
    box-shadow: var(--sr-shadow) !important; z-index: 100000 !important; flex-shrink: 0 !important;
  }
  .not_slop_trash_btn:hover { background: var(--sr-red-dim) !important; border-color: var(--sr-red-border) !important; }

  /* Twitter NOT SLOP pill */
  .not_slop_tw_wrap { display: inline-flex !important; align-items: center !important; gap: 4px !important; margin-left: 6px !important; vertical-align: middle !important; }
  .not_slop_tw_badge {
    display: inline-flex !important; align-items: center !important; padding: 2px 8px !important;
    background: var(--sr-green-bg) !important; border: 1px solid var(--sr-green-border) !important;
    border-radius: 999px !important; font-size: 0.65rem !important; font-weight: 800 !important;
    color: var(--sr-green) !important; white-space: nowrap !important; pointer-events: none !important;
  }
  .not_slop_tw_trash_btn {
    display: inline-flex !important; align-items: center !important; justify-content: center !important;
    width: 20px !important; height: 20px !important; border-radius: 50% !important;
    border: 1px solid var(--sr-border) !important; background: var(--sr-btn-bg) !important;
    font-size: 0.7rem !important; cursor: pointer !important; pointer-events: auto !important;
  }
  .not_slop_tw_trash_btn:hover { background: var(--sr-red-dim) !important; border-color: var(--sr-red-border) !important; }

  /* Site-pause banner */
  #sr_site_pause_banner {
    position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important;
    background: #1f2937 !important; color: #f9fafb !important;
    font-size: 0.75rem !important; font-weight: 700 !important;
    padding: 6px 16px !important; z-index: 2147483647 !important;
    display: flex !important; align-items: center !important; gap: 12px !important;
    letter-spacing: 0.04rem !important; box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
    pointer-events: auto !important;
  }
  #sr_site_pause_banner .sr_pb_label { opacity: 0.7 !important; }
  #sr_site_pause_banner .sr_pb_resume {
    margin-left: auto !important; font-size: 0.7rem !important; font-weight: 800 !important;
    color: #f9fafb !important; background: rgba(255,255,255,0.12) !important;
    border: 1px solid rgba(255,255,255,0.25) !important; border-radius: 4px !important;
    padding: 2px 10px !important; cursor: pointer !important;
  }
  #sr_site_pause_banner .sr_pb_resume:hover { background: rgba(255,255,255,0.22) !important; }
`;
document.head.appendChild(slopStyle);

// ── Modal guards ──────────────────────────────────────────────────────────
const LINKEDIN_MODAL_SEL = [
  '[role="dialog"]','[data-test-modal]','[data-test-modal-container]',
  '.artdeco-modal','.artdeco-modal-overlay','.share-box',
  '.share-box-v2__modal','.share-creation-state','.artdeco-modal__content',
  '.media-editor__container','.share-box-footer',
].join(',');
const TWITTER_MODAL_SEL = [
  '[data-testid="tweetTextarea_0"]','[aria-label="Tweet text"]',
  '[role="dialog"]','.DraftEditor-root',
].join(',');

function isComposerOrInput(el) {
  if (!el) return false;
  const shared = 'input,textarea,[contenteditable="true"],[role="textbox"]';
  const extra = IS_LINKEDIN ? `,${LINKEDIN_MODAL_SEL}` : IS_TWITTER ? `,${TWITTER_MODAL_SEL}` : '';
  return !!el.closest(shared + extra);
}
function isInsideModal(el) {
  if (!el) return false;
  if (IS_LINKEDIN) return !!el.closest(LINKEDIN_MODAL_SEL);
  if (IS_TWITTER) return !!el.closest(TWITTER_MODAL_SEL);
  return false;
}

// ── Wrapper finders ───────────────────────────────────────────────────────
function getLinkedInWrapper(textNode) {
  if (isInsideModal(textNode)) return null;

  // Reject comment text — comments also use expandable-text-box and
  // role="listitem" internally. Without this guard we'd try to classify
  // comment replies as feed posts.
  if (textNode.closest('.comments-comment-item, .comments-comments-list, ' +
      '[class*="comment-item"], [class*="comments-"]')) {
    return null;
  }
  // Secondary comment guard: if the nearest listitem does NOT contain
  // the "Feed post" h2 that LinkedIn puts on every feed card, it's a
  // comment or some other non-feed listitem — skip it.
  // (This catches comment listitems that don't have the old class names.)

  // ── Primary: [role="listitem"] that is a feed card ─────────────────────
  // All LinkedIn feed cards — regular, Suggested, "For You", "Finds this
  // insightful" — share this structure:
  //   <div role="listitem" componentkey="expanded...FeedType_...">
  //     <h2><span>Feed post</span></h2>   ← stable indicator
  //     ...
  //     <span data-testid="expandable-text-box">POST TEXT</span>
  //     ...
  //   </div>
  // There is NO outer listitem wrapping the label — "Suggested" is a <p>
  // INSIDE the same single listitem as the post content.
  const listitem = textNode.closest('[role="listitem"]');
  if (listitem && !isInsideModal(listitem)) {
    // Validate it's a feed card (not a comment/nav listitem) by checking
    // for the "Feed post" h2 LinkedIn injects into every card.
    const hasFeedH2 = !!listitem.querySelector('h2 span._482149db, h2 [class*="482149db"]');
    // Fallback: componentkey containing "FeedType" is equally reliable.
    const ck = listitem.getAttribute('componentkey') || '';
    const isFeedCard = hasFeedH2 || ck.includes('FeedType') || ck.startsWith('expanded');
    if (isFeedCard) return listitem;
  }

  // ── Fallback: legacy card selectors (older / un-migrated surfaces) ──────
  const cardSelectors = [
    '[data-urn]', '[data-activity-urn]', '[data-id]',
    '.feed-shared-update-v2', '.occludable-update', '.nt-card', 'article',
  ];
  for (const sel of cardSelectors) {
    const found = textNode.closest(sel);
    if (found && !isInsideModal(found)) {
      const p = found.parentElement;
      if (p && (p.tagName === 'LI' || (p.className||'').toLowerCase().includes('item-wrapper'))) return p;
      return found;
    }
  }

  // ── Last resort: walk up looking for a card-like ancestor ──────────────
  const INNER = ['__description','__text','__content','segment-list','inline-show'];
  let el = textNode.parentElement, best = null, depth = 0;
  while (el && el.tagName !== 'BODY' && el.tagName !== 'MAIN' && depth < 25) {
    if (el.matches?.(LINKEDIN_MODAL_SEL)) return null;
    if (el.getAttribute && el.getAttribute('role') === 'listitem') { best = el; break; }
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const hasUrn = el.hasAttribute('data-urn') || el.hasAttribute('data-activity-urn') || el.hasAttribute('data-id');
    const isInner = INNER.some(c => cls.includes(c));
    if (!isInner && (hasUrn || cls.includes('occludable') || cls.includes('feed-shared-update-v2') || cls.includes('nt-card') || el.tagName === 'ARTICLE')) best = el;
    el = el.parentElement; depth++;
  }
  if (!best) {
    let fb = textNode.parentElement;
    for (let i = 0; i < 10 && fb && fb.tagName !== 'BODY'; i++) fb = fb.parentElement;
    best = fb;
  }
  if (!best || isInsideModal(best)) return null;
  return best;
}

function getTwitterWrapper(textNode) {
  if (isInsideModal(textNode)) return null;
  const art = textNode.closest('article[data-testid="tweet"]');
  if (!art || isInsideModal(art)) return null;
  return art;
}

function getUniversalWrapper(textNode) {
  let el = textNode.parentElement;
  for (let i = 0; i < 10 && el && el.tagName !== 'BODY'; i++) {
    if (['P','ARTICLE','SECTION','LI','BLOCKQUOTE','DIV'].includes(el.tagName)) {
      if ((el.textContent?.trim() || '').length >= 80) return el;
    }
    el = el.parentElement;
  }
  return null;
}

function getPostWrapper(textNode) {
  if (IS_TWITTER) return getTwitterWrapper(textNode);
  if (IS_LINKEDIN) return getLinkedInWrapper(textNode);
  if (IS_REDDIT) {
    // Prefer the post/comment custom elements; fall back to universal walk-up.
    const el = textNode.parentElement;
    const w = el?.closest('shreddit-post, [data-testid="post-container"], ' +
      'shreddit-comment, [data-testid="comment"]');
    if (w) return w;
    return getUniversalWrapper(textNode);
  }
  if (IS_THREADS) {
    const el = textNode.parentElement;
    const w = el?.closest('div[data-pressable-container], article');
    if (w) return w;
    return getUniversalWrapper(textNode);
  }
  return getUniversalWrapper(textNode);
}

// ── Media kill ────────────────────────────────────────────────────────────
function killMedia(container) {
  // Non-destructive: pause playback and hide via CSS only.
  // We deliberately do NOT remove elements or null their src — on LinkedIn
  // that triggers network teardown events their integrity script watches
  // for, and removing iframes can fire navigation/security hooks.
  container.querySelectorAll("video,audio").forEach(m => {
    try { m.pause(); } catch (_) {}
  });
  // The .sr_blur_cover / collapse CSS already hides media visually.
}

// ── Inline page feedback toast ────────────────────────────────────────────
// Shows a transient feedback element near the post so the user knows exactly
// what happened to the pattern list — whether something was added, was already
// covered, or nothing changed.
function showPatternFeedback(wrapper, { icon, headline, detail, color }) {
  // Remove any existing feedback on this wrapper first.
  wrapper.querySelector(".sr_pattern_feedback")?.remove();

  const fb = document.createElement("div");
  fb.className = "sr_pattern_feedback";
  fb.style.cssText = `
    position:absolute !important; bottom:100% !important; left:0 !important; right:0 !important;
    background:${color || "rgba(30,30,40,0.97)"} !important;
    color:#fff !important; padding:10px 14px !important;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif !important;
    font-size:0.74rem !important; line-height:1.4 !important;
    border-radius:6px 6px 0 0 !important;
    box-shadow:0 -4px 16px rgba(0,0,0,0.35) !important;
    z-index:2147483647 !important; pointer-events:none !important;
  `;

  const head = document.createElement("div");
  head.style.cssText = "font-weight:700 !important; margin-bottom:3px !important;";
  head.textContent = `${icon} ${headline}`;

  const sub = document.createElement("div");
  sub.style.cssText = "opacity:0.82 !important;";
  sub.textContent = detail;

  fb.append(head, sub);

  // Needs a positioned parent to anchor to.
  const pos = window.getComputedStyle(wrapper).position;
  if (pos === "static") wrapper.style.setProperty("position", "relative", "important");

  wrapper.appendChild(fb);
  // Fade out after 4s.
  setTimeout(() => {
    fb.style.transition = "opacity 0.5s";
    fb.style.opacity = "0";
    setTimeout(() => fb.remove(), 600);
  }, 4000);
}

// ── Learn from slop (trash-can click on NOT SLOP tag) ─────────────────────
function learnFromPost(postText, wrapper, btn) {
  btn.textContent = "⏳"; btn.disabled = true;
  chrome.runtime.sendMessage({ action: "learnFromSlop", postText }, (res) => {
    if (chrome.runtime.lastError || !res) {
      btn.textContent = "🗑️"; btn.disabled = false; return;
    }
    const n = res.added?.length ?? 0;
    if (n > 0) {
      btn.textContent = `✓ +${n}`;
      showPatternFeedback(wrapper, {
        icon: "✅",
        headline: `Added ${n} new slop pattern${n > 1 ? "s" : ""}`,
        detail: res.added.map(p => `"${p}"`).join("  ·  "),
        color: "rgba(16,100,30,0.96)",
      });
    } else {
      btn.textContent = "✓";
      showPatternFeedback(wrapper, {
        icon: "ℹ️",
        headline: "Already covered",
        detail: res.covered?.length
          ? `Covered by: ${res.covered.slice(0, 2).join("  ·  ")}`
          : (res.reasoning || "This pattern is already in the filter."),
        color: "rgba(30,30,50,0.97)",
      });
    }
    srLog(`learnFromSlop: added ${n}, covered ${res.covered?.length ?? 0}: ${res.reasoning || ""}`);
  });
}

// ── Uncategorize slop → not-slop ─────────────────────────────────────────
function uncategorizeSlop(wrapper, postText, btn) {
  btn.textContent = "⏳"; btn.disabled = true;
  chrome.runtime.sendMessage({ action: "unlearn", postText }, (res) => {
    if (chrome.runtime.lastError || !res) { btn.textContent = "✗"; btn.disabled = false; return; }
    // Visually revert: remove slop marks, add not-slop tag.
    wrapper.removeAttribute("data-slop-detected");
    wrapper.removeAttribute("data-sr-revealed");
    wrapper.querySelector(".slop_dog_ear")?.remove();
    wrapper.querySelector(".sr_blur_cover")?.remove();
    wrapper.querySelectorAll(".sr_hide_mode").forEach(el => el.classList.remove("sr_hide_mode"));
    wrapper.classList.remove("sr_hide_mode");
    wrapper.style.removeProperty("max-height");
    wrapper.style.removeProperty("overflow");
    cacheSetVerdict(postText, false, 0);
    evaluatedWrappers.delete(wrapper);
    applyNotSlop(wrapper, 0, true);

    // Inline feedback.
    const r = res.removed || 0, n = res.narrowed || 0;
    if (r > 0 || n > 0) {
      const parts = [];
      if (r > 0) parts.push(`Removed ${r}: ${(res.removedPatterns || []).slice(0,2).map(p=>`"${p}"`).join(", ")}`);
      if (n > 0) parts.push(`Narrowed ${n}: ${(res.narrowedPatterns || []).slice(0,2).map(p=>`"${p}"`).join(", ")}`);
      showPatternFeedback(wrapper, {
        icon: "🔧",
        headline: "Patterns updated — not slop",
        detail: parts.join("  ·  ") + (res.reasoning ? `  —  ${res.reasoning}` : ""),
        color: "rgba(10,60,90,0.97)",
      });
    } else {
      showPatternFeedback(wrapper, {
        icon: "ℹ️",
        headline: "Marked as not slop",
        detail: res.reasoning || "No patterns changed — may be borderline content.",
        color: "rgba(30,30,50,0.97)",
      });
    }
    srLog(`unlearn: removed ${r}, narrowed ${n}: ${res.reasoning || ""}`);
  });
}

// ── Confirm slop (confirm-slop button on slop banner) ─────────────────────
// Writes confirmed patterns into slopPatterns (the top prompt list).
function confirmSlop(wrapper, postText, btn) {
  btn.textContent = "⏳"; btn.disabled = true;
  chrome.runtime.sendMessage({ action: "confirmSlop", postText }, (res) => {
    if (chrome.runtime.lastError || !res) {
      btn.textContent = "✗ retry"; btn.disabled = false;
      srLog("confirm slop: background did not respond");
      return;
    }
    const n = res.added?.length ?? 0;
    if (n > 0) {
      btn.textContent = "✓ Learned";
      btn.classList.add("sr_confirmed");
      showPatternFeedback(wrapper, {
        icon: "✅",
        headline: `Confirmed slop — added ${n} pattern${n > 1 ? "s" : ""}`,
        detail: res.added.map(p => `"${p}"`).join("  ·  "),
        color: "rgba(140,20,20,0.96)",
      });
    } else {
      btn.textContent = "✓ Covered";
      btn.classList.add("sr_confirmed");
      showPatternFeedback(wrapper, {
        icon: "ℹ️",
        headline: "Already well covered",
        detail: res.covered?.length
          ? `Covered by: ${res.covered.slice(0, 2).join("  ·  ")}`
          : (res.reasoning || "This pattern is already in the filter."),
        color: "rgba(80,20,20,0.96)",
      });
    }
    srLog(`confirmSlop: added ${n}: ${res.reasoning || ""}`);
  });
}

// ── Site pause banner ─────────────────────────────────────────────────────
function showSitePauseBanner() {
  if (document.getElementById("sr_site_pause_banner")) return;
  const banner = document.createElement("div");
  banner.id = "sr_site_pause_banner";
  const label = document.createElement("span");
  label.className = "sr_pb_label";
  label.textContent = `🚫 SlopRadar paused on ${PAGE_HOSTNAME}`;
  const resumeBtn = document.createElement("button");
  resumeBtn.className = "sr_pb_resume";
  resumeBtn.textContent = "Resume";
  resumeBtn.addEventListener("click", () => {
    sessionPausedSites.delete(PAGE_HOSTNAME);
    chrome.runtime.sendMessage({ action: "clearSitePause", hostname: PAGE_HOSTNAME }).catch(() => {});
    banner.remove();
    scheduleDrain();
  });
  banner.append(label, resumeBtn);
  document.body.insertBefore(banner, document.body.firstChild);
}

// ── Apply SLOP ────────────────────────────────────────────────────────────
// Pull the canonical "post body" text from a wrapper — the same text that
// the sweep would extract from the post's text-node child. This MUST match
// what enqueueNode hashes for cache lookup, otherwise the write and read
// keys diverge and the cache appears to have 0% hit rate even with hundreds
// of entries (the bug that broke reload-restore).
//
// The wrapper.textContent shortcut concatenates EVERYTHING — avatar names,
// timestamps, engagement counts, suggested replies — which produces a
// completely different hash than the bare body text. We instead query the
// platform-specific body selector and use its trimmed text, falling back
// to the wrapper text if no body selector matches.
function getCanonicalPostText(wrapper) {
  if (!wrapper) return "";
  // Use the SAME selector logic as getTextSelectors() but scoped to the
  // wrapper. Take the first matching node — there's exactly one body per
  // post on the platforms we support.
  let bodyEl = null;
  if (IS_TWITTER) {
    bodyEl = wrapper.querySelector('[data-testid="tweetText"]');
  } else if (IS_LINKEDIN) {
    bodyEl = wrapper.querySelector(
      '[data-testid="expandable-text-box"], ' +
      '.update-components-text, ' +
      '.feed-shared-update-v2__description-wrapper, ' +
      '.feed-shared-inline-show-more-text'
    );
  } else if (IS_REDDIT) {
    bodyEl = wrapper.querySelector(
      '[data-testid="post-content"] [property="schema:articleBody"], ' +
      'shreddit-post [slot="text-body"], [data-click-id="text"], .md'
    );
  } else if (IS_THREADS) {
    bodyEl = wrapper.querySelector('span[dir="auto"]');
  }
  const text = (bodyEl?.textContent || wrapper.textContent || "").trim();
  return text.substring(0, 800);
}

function applySlop(wrapper, confidence, reasons = [], fromCache = false) {
  if (evaluatedWrappers.has(wrapper)) return;
  if (wrapper.querySelector(".slop_dog_ear")) return;
  wrapper.querySelector(".not_slop_dog_ear")?.remove();
  wrapper.querySelector(".not_slop_tw_wrap")?.remove();

  evaluatedWrappers.add(wrapper);
  const postText = getCanonicalPostText(wrapper);
  cacheSetVerdict(postText, true, confidence, reasons);

  if (!fromCache) recordResult(true);

  // ── Mode 1: remove entirely — take the element off the page, no UI ──────
  if (settings.removeEntirely) {
    // Keep a tiny stamped placeholder comment so recycle detection and
    // the cache still behave, but the visible element is gone.
    wrapper.setAttribute("data-slop-detected", "true");
    wrapper.dataset.srStampedText = postText.substring(0, 120);
    wrapper.style.setProperty("display", "none", "important");
    return;
  }

  wrapper.classList.add("slop_radar_card", `slop_radar_${PLATFORM}`);
  wrapper.setAttribute("data-slop-detected", "true");
  wrapper.removeAttribute("data-sr-revealed");
  wrapper.dataset.srStampedText = postText.substring(0, 120);

  if (window.getComputedStyle(wrapper).position === "static") {
    wrapper.style.setProperty("position", "relative", "important");
  }

  // ── Mode 2: non-intrusive — hide the slop quietly, add nothing else ─────
  // No banner, no training buttons. Just collapse the card out of view.
  // For people who have trained the filter and now just want clean feeds.
  if (settings.nonIntrusiveMode) {
    wrapper.classList.add("sr_hide_mode", "sr_noninstrusive");
    return;
  }

  // hideSlop mode: just add class and banner, hide everything else
  if (settings.hideSlop) {
    wrapper.classList.add("sr_hide_mode");
  } else if (!IS_TWITTER) {
    killMedia(wrapper);
    wrapper.style.setProperty("overflow", "hidden", "important");
  }

  // ── Mode 3: normal — banner with controls and reasons ──────────────────
  const banner = document.createElement("div");
  banner.className = "slop_dog_ear";

  const ribbon = document.createElement("div");
  ribbon.className = "slop_dog_ear_ribbon";
  const mainSpan = document.createElement("span");
  mainSpan.className = "sr-main";
  mainSpan.textContent = "🚫 AI SLOP";
  const subSpan = document.createElement("span");
  subSpan.className = "sr-sub";
  subSpan.textContent = `${confidence}% certainty`;
  ribbon.append(mainSpan, subSpan);

  const controls = document.createElement("div");
  controls.className = "slop_radar_controls";

  const showBtn = document.createElement("button");
  showBtn.className = "slop_radar_btn";
  showBtn.textContent = settings.hideSlop ? "Reveal" : "Show anyway";
  showBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const revealed = wrapper.hasAttribute("data-sr-revealed");
    if (revealed) {
      wrapper.removeAttribute("data-sr-revealed");
      showBtn.textContent = settings.hideSlop ? "Reveal" : "Show anyway";
      if (!IS_TWITTER && !settings.hideSlop) wrapper.style.setProperty("overflow", "hidden", "important");
    } else {
      wrapper.setAttribute("data-sr-revealed", "1");
      showBtn.textContent = "Collapse";
      if (!IS_TWITTER && !settings.hideSlop) wrapper.style.setProperty("overflow", "visible", "important");
    }
  });
  controls.appendChild(showBtn);

  // Training buttons — can be hidden once the filter is well-trained.
  if (settings.showTrainingButtons) {
    // "Confirm slop" — reinforces: runs the post through the model to
    // extract confirming patterns into the modular userTaughtPatterns bucket.
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "slop_radar_btn sr_confirm_btn";
    confirmBtn.textContent = "✓ Confirm slop";
    confirmBtn.title = "Correctly flagged — teach SlopRadar to catch more like this";
    confirmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmSlop(wrapper, postText, confirmBtn);
    });
    controls.appendChild(confirmBtn);

    // "Not slop" — the inverse correction (narrows over-broad patterns).
    const notSlopBtn = document.createElement("button");
    notSlopBtn.className = "slop_radar_btn";
    notSlopBtn.textContent = "✕ Not slop";
    notSlopBtn.title = "Incorrectly flagged? Teach SlopRadar";
    notSlopBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      uncategorizeSlop(wrapper, postText, notSlopBtn);
    });
    controls.appendChild(notSlopBtn);
  }

  banner.append(ribbon, controls);

  // Reasons row — short list of WHY the model flagged this post. Sits below
  // the ribbon, inside the banner. Stays clear even when the card is blurred
  // (the banner is above the blur cover).
  if (reasons && reasons.length > 0) {
    const reasonsEl = document.createElement("div");
    reasonsEl.className = "slop_dog_ear_reasons";
    reasonsEl.textContent = "Why: " + reasons.join(" · ");
    banner.appendChild(reasonsEl);
  }

  // Insert a spacer FIRST, then the banner before the spacer. Result order:
  //   <wrapper>
  //     <banner>          (position:absolute, top:0)
  //     <spacer>          (height:--sr-banner-h when revealed, display:none otherwise)
  //     ...original content...
  //   </wrapper>
  // The spacer participates in whatever layout X has set up — flex row,
  // grid, block — and pushes everything else down by --sr-banner-h when
  // the card is revealed. The banner overlays the spacer area visually.
  // This avoids fighting X's layout: we don't have to change the article's
  // display mode or apply padding-top (which X's flex-row makes a no-op).
  wrapper.querySelector(".sr_reveal_spacer")?.remove();
  const spacer = document.createElement("div");
  spacer.className = "sr_reveal_spacer";
  spacer.setAttribute("aria-hidden", "true");
  wrapper.insertBefore(spacer, wrapper.firstChild);
  wrapper.insertBefore(banner, wrapper.firstChild);

  // Measure the banner's height and expose it as a CSS variable so the
  // "revealed" padding-top matches exactly — gives the post content room to
  // breathe below the banner instead of overlapping it. We do this LIVE via
  // ResizeObserver because:
  //  • the reasons row can wrap to multiple lines on narrow viewports
  //  • LinkedIn/X rewrite the card's inner content, which can re-flow the
  //    banner's siblings and change wrap behavior
  //  • the very first offsetHeight read can be too early if web fonts are
  //    still loading; a follow-up tick is needed
  // The observer is cheap (one element) and disconnects when the wrapper
  // is GC'd along with the banner.
  const syncBannerHeight = () => {
    const h = banner.offsetHeight;
    if (h > 0) {
      // Add a small visual buffer so the first line of revealed content has
      // breathing room below the banner, not flush against it.
      wrapper.style.setProperty("--sr-banner-h", (h + 6) + "px");
    }
  };
  requestAnimationFrame(syncBannerHeight);
  // Once more after fonts settle — Space Mono / DM Sans may not have been
  // applied on the first rAF.
  setTimeout(syncBannerHeight, 120);
  if (typeof ResizeObserver !== "undefined") {
    try {
      const ro = new ResizeObserver(syncBannerHeight);
      ro.observe(banner);
    } catch (_) {}
  }

  // Blur cover (non-hide mode only)
  if (!settings.hideSlop) {
    const blurCover = document.createElement("div");
    blurCover.className = "sr_blur_cover";
    wrapper.appendChild(blurCover);
    const syncBlurTop = () => {
      const h = banner.offsetHeight;
      if (h > 0) blurCover.style.top = h + "px";
    };
    requestAnimationFrame(syncBlurTop);
    setTimeout(syncBlurTop, 120);
    if (typeof ResizeObserver !== "undefined") {
      try { new ResizeObserver(syncBlurTop).observe(banner); } catch (_) {}
    }
  }
}

// ── Apply NOT SLOP ────────────────────────────────────────────────────────
function applyNotSlop(wrapper, confidence, force = false, fromCache = false) {
  if (!force && evaluatedWrappers.has(wrapper)) return;
  if (wrapper.getAttribute("data-slop-detected") === "true") return;

  evaluatedWrappers.add(wrapper);
  const postText = getCanonicalPostText(wrapper);
  cacheSetVerdict(postText, false, confidence);
  wrapper.dataset.srStampedText = postText.substring(0, 120);

  // In non-intrusive / remove-entirely modes the NOT SLOP tag is just
  // visual noise — the whole point of those modes is to add nothing to the
  // page. We still record the verdict + cache it above, just no green tag.
  if (settings.nonIntrusiveMode || settings.removeEntirely) {
    return;
  }

  wrapper.classList.add("slop_radar_card", `slop_radar_${PLATFORM}`);
  if (window.getComputedStyle(wrapper).position === "static") {
    wrapper.style.setProperty("position", "relative", "important");
  }

  if (IS_TWITTER) {
    if (!force && wrapper.querySelector(".not_slop_tw_wrap")) return;
    wrapper.querySelector(".not_slop_tw_wrap")?.remove();
    const timeEl = wrapper.querySelector("time");
    if (timeEl?.parentElement) {
      const wrap = document.createElement("span");
      wrap.className = "not_slop_tw_wrap";
      const badge = document.createElement("span");
      badge.className = "not_slop_tw_badge";
      badge.textContent = confidence > 0 ? `✓ NOT SLOP  ${confidence}%` : "✓ NOT SLOP";
      wrap.appendChild(badge);
      if (settings.showTrashCan) {
        const tb = document.createElement("button");
        tb.className = "not_slop_tw_trash_btn"; tb.textContent = "🗑️";
        tb.title = "Actually slop? Teach SlopRadar";
        tb.addEventListener("click", (e) => { e.stopPropagation(); learnFromPost(postText, wrapper, tb); });
        wrap.appendChild(tb);
      }
      timeEl.parentElement.insertAdjacentElement("afterend", wrap);
    }
  } else {
    wrapper.querySelector(".not_slop_dog_ear")?.remove();
    const ear = document.createElement("div");
    ear.className = "not_slop_dog_ear";

    const tag = document.createElement("span");
    tag.className = "not_slop_ribbon";
    const mainSpan = document.createElement("span");
    mainSpan.textContent = "NOT SLOP";
    const subSpan = document.createElement("span");
    subSpan.className = "sr-sub";
    subSpan.textContent = confidence > 0 ? `${confidence}%` : "";
    tag.append(mainSpan, subSpan);
    ear.appendChild(tag);

    if (settings.showTrashCan) {
      const tb = document.createElement("button");
      tb.className = "not_slop_trash_btn"; tb.textContent = "🗑️";
      tb.title = "Actually slop? Teach SlopRadar";
      tb.addEventListener("click", (e) => { e.stopPropagation(); learnFromPost(postText, wrapper, tb); });
      ear.appendChild(tb);
    }

    wrapper.appendChild(ear);
  }
  if (!fromCache) recordResult(false);
}

// ── Text selectors ────────────────────────────────────────────────────────
function getTextSelectors() {
  if (IS_TWITTER) return '[data-testid="tweetText"]';
  if (IS_LINKEDIN) {
    // LinkedIn's current feed marks every post body with the stable test ID
    // data-testid="expandable-text-box" — the same kind of stable hook X
    // uses for tweetText. This survives their CSS-class obfuscation.
    // The older class-based selectors are kept as fallbacks for any
    // un-migrated surfaces, plus a [dir="ltr"] catch-all.
    return [
      '[data-testid="expandable-text-box"]',
      '.update-components-text',
      '.feed-shared-update-v2__description-wrapper',
      '.feed-shared-inline-show-more-text',
      'span[dir="ltr"]',
    ].join(',');
  }
  if (IS_REDDIT) {
    // Reddit (new + shreddit): post bodies live in these containers. Beta —
    // the wrapper resolution falls back to the generic walk-up.
    return [
      '[data-testid="post-content"] [property="schema:articleBody"]',
      'shreddit-post [slot="text-body"]',
      '[data-click-id="text"]',
      '.md',                       // old reddit / comment markdown
      '[data-testid="comment"]',
    ].join(',');
  }
  if (IS_THREADS) {
    // Threads marks post text spans with dir="auto" inside article elements.
    return [
      'article span[dir="auto"]',
      'div[data-pressable-container] span[dir="auto"]',
    ].join(',');
  }
  return 'p, [class*="post"] p, [class*="content"] p, article p';
}

// ── Drain loop ────────────────────────────────────────────────────────────
let inFlightDrains = 0;
// Pipeline up to this many post evaluations into the background at once.
// The single shared AI session still processes them serially, but the
// network round-trip / MV3 wake-up overhead of post N+1 overlaps with the
// inference for post N. Cap is small because the model is the bottleneck
// and we don't want stale work piling up if a tab is about to navigate.
const PIPELINE_MAX = 3;
// In-flight text-hash dedup. X (and LinkedIn) sometimes render the same
// post text in multiple wrappers — quote tweets, "you might have missed"
// re-renders, conversation threads — and each wrapper sees an enqueue.
// Without dedup, we burn AI calls re-classifying the same string.
// Maps hashKey → array of pending {wrapper, textNode} waiting for the
// in-flight verdict to come back. When it does, ALL waiters get applied.
const inFlightByText = new Map();
let swFailureStreak = 0; // consecutive service-worker failures

// ── Perf instrumentation ──────────────────────────────────────────────────
// Track where time goes so we can answer "why isn't my queue filling up?"
//
//   cacheHits / cacheMisses        — how often we skip the AI entirely
//   totalAgeMs                     — sum of (drainStart - enqueuedAt) so we
//                                    can report the AVERAGE time a post sits
//                                    in the queue before classification starts
//   aiCalls / totalAiMs / maxAiMs  — round-trip time to the background AI
//                                    (covers sendMessage + LanguageModel.prompt)
//
// Logged every 15 seconds via flushPerfStats() so the Logs tab shows
// throughput without flooding the console on bursty scrolls.
const perfStats = {
  cacheHits: 0, cacheMisses: 0,
  totalAgeMs: 0,
  aiCalls: 0, totalAiMs: 0, maxAiMs: 0,
  sweepCount: 0, sweepMatchedTotal: 0, sweepEnqueuedTotal: 0,
  lastFlushAt: Date.now(),
};

function flushPerfStats() {
  const s = perfStats;
  const elapsed = Math.max(1, (Date.now() - s.lastFlushAt) / 1000);
  const handled = s.cacheHits + s.cacheMisses;
  // ALWAYS log a perf line so the user can see the system is alive even when
  // idle (steady-state of a static viewport produces 0 posts/15s but the
  // sweeps are still running). The "idle" wording makes the state clear.
  if (handled === 0 && s.aiCalls === 0 && s.sweepCount === 0) {
    srLog(`perf: idle (no sweeps or work in last ${elapsed.toFixed(1)}s)`);
    s.lastFlushAt = Date.now();
    return;
  }
  const cacheRate = handled ? Math.round((s.cacheHits / handled) * 100) : 0;
  const avgAge = handled ? Math.round(s.totalAgeMs / handled) : 0;
  const avgAi = s.aiCalls ? Math.round(s.totalAiMs / s.aiCalls) : 0;
  const tps = (handled / elapsed).toFixed(2);
  srLog(
    `perf: ${handled} posts in ${elapsed.toFixed(1)}s (${tps}/s) | ` +
    `cache ${cacheRate}% (${s.cacheHits} hit / ${s.cacheMisses} miss) | ` +
    `queue-age avg ${avgAge}ms | ` +
    `AI avg ${avgAi}ms max ${Math.round(s.maxAiMs)}ms over ${s.aiCalls} calls | ` +
    `sweeps ${s.sweepCount} matched ${s.sweepMatchedTotal} enq ${s.sweepEnqueuedTotal} | ` +
    `pending ${pendingNodes.length} pipe ${inFlightDrains}/${PIPELINE_MAX}` +
    (swFailureStreak > 0 ? ` | ⚠ AI failure streak ${swFailureStreak}` : "")
  );
  // Reset window counters; keep maxAiMs across windows for tail visibility.
  s.cacheHits = 0; s.cacheMisses = 0;
  s.totalAgeMs = 0;
  s.aiCalls = 0; s.totalAiMs = 0;
  s.sweepCount = 0; s.sweepMatchedTotal = 0; s.sweepEnqueuedTotal = 0;
  s.lastFlushAt = Date.now();
}
setInterval(flushPerfStats, 15000);

// Pipelined drain. The single AI session in the background is still serial,
// but pipelining lets us overlap the message round-trip / MV3 wake-up of
// post N+1 with the inference for post N. Also makes the queue VISIBLE in
// the popup: instead of insta-shifting one item at a time, multiple items
// stay in flight, which is what the user expects to see.
// Tracks the last time we successfully kicked a drain. If pumpDrain is
// called but inFlightDrains == PIPELINE_MAX (pipeline is "full") for an
// extended period despite pending work, we log a diagnostic.
let lastPumpFiredAt = Date.now();
let lastStuckWarnAt = 0;

function pumpDrain() {
  if (isPaused || isSitePaused()) return;
  // Start up to PIPELINE_MAX concurrent drains. Each drain handles ONE item
  // and self-decrements when it completes (sync, cache hit) or its callback
  // returns (async, AI call).
  let kicked = 0;
  while (inFlightDrains < PIPELINE_MAX && pendingNodes.length > 0) {
    inFlightDrains++;
    kicked++;
    queueMicrotask(drainOne);
  }
  if (kicked > 0) lastPumpFiredAt = Date.now();

  // Stuck-pipeline diagnostic: if the pipeline is at cap AND there's pending
  // work AND we haven't fired a new drain in a while, something is sitting
  // on the slots without finishing. The watchdog should free them at +30s,
  // but if it doesn't (e.g. the tab was backgrounded and timers throttled),
  // at least the user can see in the logs that we're aware.
  if (inFlightDrains >= PIPELINE_MAX && pendingNodes.length > 0) {
    const stuckMs = Date.now() - lastPumpFiredAt;
    const since = Date.now() - lastStuckWarnAt;
    if (stuckMs > 15000 && since > 15000) {
      srLog(
        `⚠ pipeline stuck for ${Math.round(stuckMs / 1000)}s ` +
        `(inFlight=${inFlightDrains}/${PIPELINE_MAX}, pending=${pendingNodes.length}). ` +
        `Drain watchdogs at ${DRAIN_MAX_AGE_MS}ms should release them. ` +
        `If this persists, the AI session is likely wedged — try Restart Engine.`
      );
      lastStuckWarnAt = Date.now();
    }
  }
}

// Wall-clock cap on a single in-flight drain. AI inferences have been
// observed at 6-10s in real X usage, but if a callback genuinely never
// fires (MV3 worker died mid-request, tab navigated, etc.) the pipeline
// slot would leak forever. 30s is well beyond the slowest healthy
// inference we've measured, and guarantees the slot will free up.
const DRAIN_MAX_AGE_MS = 30000;

function drainOne() {
  if (isPaused || isSitePaused() || pendingNodes.length === 0) {
    inFlightDrains = Math.max(0, inFlightDrains - 1);
    return;
  }

  const item = pendingNodes.shift();
  currentQueueSize = pendingNodes.length;
  const { textNode, wrapper } = item;
  const tDrainStart = performance.now();

  // Idempotent finish — defends against double-calls (callback fires AND
  // the watchdog timer fires) which would otherwise double-decrement
  // inFlightDrains and let pumpDrain start MORE work than PIPELINE_MAX.
  let finished = false;
  let watchdog = null;
  // The drainOneInner code sets this when it dispatches an AI call so the
  // watchdog (in this outer scope) can clean up the in-flight text map if
  // the callback never fires. Stays null for cache hits / promoted hits
  // that don't open an in-flight entry.
  let inFlightKey = null;
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    // If we set an in-flight entry but never delivered a verdict to its
    // waiters (e.g. watchdog fired before the callback came back), clear
    // it now so the next sweep can re-dispatch. Waiters are left orphaned
    // here — the next sweep that finds their text will re-enqueue them,
    // and they'll either hit the cache (if a parallel dispatch succeeded)
    // or be the new originator. We don't try to immediately re-queue
    // waiters because the watchdog path already re-queues the originator;
    // the sweep will re-find the waiters' wrappers naturally.
    if (inFlightKey && inFlightByText.has(inFlightKey)) {
      const orphaned = inFlightByText.get(inFlightKey);
      inFlightByText.delete(inFlightKey);
      if (orphaned.length > 0) {
        srLog(`drain ${reason || "ok"} — clearing ${orphaned.length} orphaned waiter${orphaned.length>1?"s":""} (next sweep will re-find them)`);
      }
    }
    inFlightDrains = Math.max(0, inFlightDrains - 1);
    if (reason && reason !== "ok") srLog(`drain finished via ${reason} (in-flight now ${inFlightDrains})`);
    pumpDrain();
  };

  // Hard timeout: if NOTHING calls finish() within DRAIN_MAX_AGE_MS we
  // force-release the pipeline slot. The only way a pipeline gets stuck
  // is a sendMessage callback that never fires — this is the failsafe.
  // We also re-queue the item if it's still in the DOM so it gets retried
  // once the pipeline is healthy again.
  watchdog = setTimeout(() => {
    if (finished) return;
    srLog(`⚠ drain watchdog fired — slot was stuck ${DRAIN_MAX_AGE_MS}ms ` +
      `(likely lost callback). Forcing release.`);
    if (document.contains(wrapper) && !evaluatedWrappers.has(wrapper)) {
      try { targetedTextNodes.delete(textNode); } catch (_) {}
      pendingNodes.push({ textNode, wrapper, enqueuedAt: performance.now() });
    }
    finish("watchdog");
  }, DRAIN_MAX_AGE_MS);

  // Belt-and-suspenders: any synchronous exception in the drain body would
  // skip past finish() and leak the pipeline slot. The watchdog catches
  // that 30s later, but we want it to release immediately so the user
  // doesn't sit watching a frozen feed. try/finally guarantees finish()
  // runs if we exit synchronously without scheduling sendMessage.
  try {
    drainOneInner(item, finish, (k) => { inFlightKey = k; });
  } catch (err) {
    srLog(`⚠ drain exception: ${err?.message || err}. Releasing slot.`);
    finish("exception");
  }
}

// Body of the drain. Separated so we can wrap drainOne's setup (counter
// management, watchdog, finish closure) around it in a try/catch without
// nesting the logic visually. `setInFlightKey` lets the inner body report
// which text-hash it claimed in inFlightByText, so the watchdog can clean
// it up if the callback never fires.
function drainOneInner(item, finish, setInFlightKey) {
  const { textNode, wrapper } = item;
  const tDrainStart = performance.now();

  if (evaluatedWrappers.has(wrapper) || !document.contains(wrapper)) {
    finish(); return;
  }

  const rawText = (textNode.textContent || "").trim();
  if (rawText.length < MIN_POST_CHARS) {
    finish(); return;
  }

  // ── Cache hit — keyed on post text, survives X back-navigation ──────────
  const cached = cacheGetVerdict(rawText);
  if (cached) {
    if (cached.isSlop) applySlop(wrapper, cached.confidence, cached.reasons || [], true);
    else applyNotSlop(wrapper, cached.confidence, false, true);
    perfStats.cacheHits++;
    if (item.enqueuedAt) perfStats.totalAgeMs += (tDrainStart - item.enqueuedAt);
    finish();
    return;
  }
  perfStats.cacheMisses++;
  if (item.enqueuedAt) perfStats.totalAgeMs += (tDrainStart - item.enqueuedAt);

  // In-flight dedup: if the same post text is already in flight, attach
  // this wrapper as a waiter and finish() the slot. When the original
  // verdict returns, all waiters get the result applied. Saves AI calls
  // for X's "same tweet rendered in 3 places" pattern.
  const textKey = hashPostText(rawText);
  if (inFlightByText.has(textKey)) {
    inFlightByText.get(textKey).push({ wrapper, textNode });
    srLog(`⇉waiting (same text already in flight) "${rawText.substring(0,50)}…"`);
    finish();
    return;
  }
  inFlightByText.set(textKey, []);
  setInFlightKey(textKey);

  srLog(`→AI dispatch (pending:${pendingNodes.length} pipe:${inFlightDrains}/${PIPELINE_MAX}) "${rawText.substring(0,50)}…"`);

  const tAiStart = performance.now();
  chrome.runtime.sendMessage(
    { action: "evaluatePost", text: rawText.substring(0, 1500), tabId: MY_TAB_ID, platform: PLATFORM },
    (response) => {
      const dt = performance.now() - tAiStart;
      perfStats.aiCalls++;
      perfStats.totalAiMs += dt;
      if (dt > perfStats.maxAiMs) perfStats.maxAiMs = dt;

      // Pull the waiter list now; we'll deliver to them after we determine
      // the verdict shape. Always clear the in-flight entry, even on
      // failure, so subsequent enqueues of the same text retry.
      const waiters = inFlightByText.get(textKey) || [];
      inFlightByText.delete(textKey);
      // ── Service worker / model failure handling ────────────────────────
      // Two failure shapes, both must NOT be stamped:
      //  • empty/undefined response → MV3 worker asleep or dropped the message
      //  • { degraded: true } → the Gemini session returned garbage for this
      //    (and probably every) post. Background recreates the session after
      //    a few of these; meanwhile we just re-queue and wait.
      // The old code stamped these as confidence 50, which is the
      // "everything is 50% not slop" bug. Instead: don't stamp, don't cache,
      // re-queue so it retries once the model is healthy again.
      const failed = chrome.runtime.lastError ||
                     !response ||
                     response.degraded === true ||
                     (typeof response.isSlop === "undefined" && !response.stale);

      if (failed) {
        swFailureStreak++;
        // Re-queue this node at the back so it retries later. Also re-queue
        // any waiters that piled up — they were riding on this verdict; if
        // it failed, they need their own retry. (Without this, X's
        // multi-rendered tweets would silently drop after one failure.)
        const requeue = (w, tn) => {
          if (!w || !tn) return;
          if (document.contains(w) && !evaluatedWrappers.has(w)) {
            try { targetedTextNodes.delete(tn); } catch (_) {}
            pendingNodes.push({ textNode: tn, wrapper: w, enqueuedAt: performance.now() });
          }
        };
        requeue(wrapper, textNode);
        for (const w of waiters) requeue(w.wrapper, w.textNode);
        if (swFailureStreak === 1 || swFailureStreak % 10 === 0) {
          const why = response?.degraded ? "model returned degraded output — kickstarting"
            : (chrome.runtime.lastError?.message || "empty response");
          srLog(
            `⚠ classification unavailable ` +
            `(streak ${swFailureStreak}) — re-queued post${waiters.length>0?` +${waiters.length} waiter${waiters.length>1?"s":""}`:""}, will retry. ${why}`
          );
        }
        // Back off so we don't hammer a dead/recovering worker. Cap higher
        // for degraded streaks since session recreation takes a moment.
        // finish() refills the pipeline immediately; the backoff applies to
        // the NEXT pump rather than blocking this drain slot.
        setTimeout(finish, Math.min(4000, 200 * swFailureStreak));
        return;
      }

      // Healthy response — reset the streak.
      swFailureStreak = 0;

      // A stale response means the background dropped this item because the
      // tab navigated/reloaded after it was enqueued. Don't stamp anything —
      // just move on. (On a hard reload this content script is already gone;
      // this guard matters for SPA navigation within the same document.)
      if (response.stale) {
        finish();
        return;
      }

      const confidence = response.confidence ?? 70;
      const reasons = Array.isArray(response.reasons) ? response.reasons : [];
      const verdictStr = response.isSlop ? `SLOP ${confidence}%` :
                         response.lowConfidence ? `low-conf ${confidence}%` :
                         `ok ${confidence}%`;
      const waitersNote = waiters.length > 0 ? ` (+${waiters.length} waiter${waiters.length>1?"s":""})` : "";
      srLog(`→AI ${Math.round(dt)}ms ${verdictStr} "${rawText.substring(0, 50)}…"${waitersNote}`);

      // Helper to apply the same verdict to one (wrapper, textNode) pair.
      // Used for the originator AND for every waiter that piled up while
      // this inference was running. applySlop / applyNotSlop are safe to
      // call on already-evaluated wrappers (they early-return).
      const applyTo = (w, tn) => {
        if (!w || !document.contains(w)) return;
        if (response.isSlop) {
          applySlop(w, confidence, reasons);
        } else if (response.lowConfidence) {
          // Slop suspected but below the user's confidence bar. Don't paint
          // the banner, but DO cache the verdict (with a low-conf flag) so
          // the next sweep doesn't re-classify the same post. If the user
          // later lowers the threshold, the cache layer can re-evaluate
          // from the stored confidence without a fresh AI call.
          evaluatedWrappers.add(w);
          if (tn) w.dataset.srStampedText = (tn.textContent || "").trim().substring(0, 120);
          // Cache as slop=true with the original confidence + a flag so
          // future code (e.g. threshold-change handlers) can find these.
          cacheSetVerdict(rawText, true, confidence, reasons, true /*belowThreshold*/);
        } else {
          applyNotSlop(w, confidence);
        }
      };
      applyTo(wrapper, textNode);
      for (const w of waiters) applyTo(w.wrapper, w.textNode);
      finish();
    }
  );
}

function scheduleDrain() {
  if (isPaused || isSitePaused()) return;
  pumpDrain();
}

// ── Enqueue ───────────────────────────────────────────────────────────────
// ── Promoted / Ad detector ────────────────────────────────────────────────
// LinkedIn marks promoted posts with the literal text "Promoted" inside the
// post header (a small label next to or below the actor name). X marks ads
// with "Ad" in the same role. We detect these structurally so we can hide
// them WITHOUT spending an AI inference — they're slop by definition (paid
// placement, not content). Reasons row makes it clear why they're flagged.
//
// Detection is intentionally conservative:
//   - The label must be a SHORT standalone element (≤ 12 chars).
//   - It must be inside the post's header area, not in the body text.
//   - We match the exact strings LinkedIn/X use plus a few common
//     localizations ("Promu", "Anuncio") for non-English feeds.
const PROMOTED_LABELS = [
  "Promoted",        // LinkedIn EN
  "Promu",           // LinkedIn FR
  "Promocionado",    // LinkedIn ES (some surfaces)
  "Gesponsert",      // LinkedIn DE
  "Sponsored",       // Generic
  "Ad",              // X
  "Anuncio",         // X ES
  "Werbung",         // X DE
];
function isPromotedPost(wrapper) {
  if (!wrapper) return false;
  // Fast path: look for very small text nodes inside the wrapper containing
  // one of the label strings, near the top of the card. We scope to header
  // candidates rather than searching the whole post — a post body that
  // happens to say "Promoted by his peers" must NOT match.
  // X: aria-labelledby on the article often lists element IDs; the testid
  // "tweet" wrappers use a span with role="presentation" for the Ad label.
  if (IS_TWITTER) {
    // The promoted indicator on X sits inside the user-name header as a
    // sibling of the timestamp. Look for short standalone "Ad" text.
    const header = wrapper.querySelector('[data-testid="User-Name"]');
    if (header) {
      const spans = header.querySelectorAll("span");
      for (const s of spans) {
        const t = (s.textContent || "").trim();
        if (t.length <= 12 && PROMOTED_LABELS.includes(t)) return true;
      }
    }
    return false;
  }
  if (IS_LINKEDIN) {
    // LinkedIn puts "Promoted" inside the actor description area, usually
    // as a span sibling of the connection-degree text. Restrict to the
    // first ~250 chars of the card markup to avoid body false-positives.
    // We use a structural check: a span/div whose ENTIRE text is exactly
    // one of the labels.
    const candidates = wrapper.querySelectorAll(
      ".update-components-actor__description span, " +
      ".update-components-actor__sub-description span, " +
      ".update-components-actor__sub-description, " +
      "[class*='actor__description'] span, " +
      "[class*='actor__sub-description'] span"
    );
    for (const c of candidates) {
      const t = (c.textContent || "").trim();
      if (t.length <= 12 && PROMOTED_LABELS.includes(t)) return true;
    }
    // Fallback: a top-level visually-hidden label LinkedIn sometimes uses.
    // ".visually-hidden" inside actor area with text "Promoted".
    const hidden = wrapper.querySelector('.visually-hidden, [class*="visually-hidden"]');
    if (hidden) {
      const t = (hidden.textContent || "").trim();
      if (t.length <= 12 && PROMOTED_LABELS.includes(t)) return true;
    }
    return false;
  }
  return false;
}

// When a sweep re-encounters a post we already classified, check whether
// the visible UI (banner / blur / NOT-SLOP tag) is still in place. The
// platform's own DOM-rewriting may have wiped what we injected even though
// our state still thinks the wrapper is "evaluated." If so, re-apply from
// the cached verdict — no AI call needed. Returns true if it re-applied.
//
// This is the dup-recovery path: dups shouldn't be silently dropped if
// they need their badge re-painted.
function maybeReapplyFromCache(wrapper, rawText) {
  const verdict = cacheGetVerdict(rawText);
  if (!verdict) return false;

  if (verdict.isSlop) {
    // For slop: the banner is the primary visible mark. If it's missing
    // AND we're not in hide-mode AND not display:none'd (remove-entirely),
    // the card is just sitting there un-flagged. Re-stamp.
    const hideModeApplied = wrapper.classList.contains("sr_hide_mode");
    const removedEntirely = wrapper.style.display === "none";
    const bannerMissing = !wrapper.querySelector(".slop_dog_ear");
    if (bannerMissing && !hideModeApplied && !removedEntirely) {
      // Treat as recycle — clear stale eval state, then re-paint from cache.
      evaluatedWrappers.delete(wrapper);
      resetWrapper(wrapper);
      applySlop(wrapper, verdict.confidence, verdict.reasons || [], true);
      srLog(`re-applied SLOP block — platform DOM rewrite had wiped it`);
      return true;
    }
  } else {
    // For NOT-SLOP: the green badge being missing is purely cosmetic and
    // platforms (especially LinkedIn) thrash that area aggressively. Only
    // re-apply if the trash-can button is enabled AND the badge is gone —
    // otherwise we'd churn re-injecting badges every sweep.
    const tagMissing = !wrapper.querySelector(".not_slop_dog_ear") &&
                       !wrapper.querySelector(".not_slop_tw_wrap");
    if (tagMissing && settings.showTrashCan) {
      evaluatedWrappers.delete(wrapper);
      // Don't resetWrapper here — leave the wrapper's other state alone,
      // we just need the tag back. applyNotSlop is idempotent enough.
      applyNotSlop(wrapper, verdict.confidence, true, true);
      return true;
    }
  }
  return false;
}

function enqueueNode(textNode) {
  if (isComposerOrInput(textNode)) return;
  const rawText = (textNode.textContent || "").trim();
  if (rawText.length < MIN_POST_CHARS) return;

  // Resolve the wrapper EARLY — needed for cache-hit application and the
  // dup-recovery branch below.
  const wrapper = getPostWrapper(textNode);
  if (!wrapper || isComposerOrInput(wrapper)) return;

  // ── Synchronous cache hit ───────────────────────────────────────────────
  // Look up the verdict by hashed post text FIRST, before any other work.
  // If we have a cached verdict and the wrapper hasn't been stamped yet,
  // paint it immediately without going through the AI queue. This is what
  // makes a page reload "feel instant": every post whose text we've seen
  // before gets its banner/badge back in the same tick the sweep finds it.
  //
  // We deliberately don't depend on text-node identity (X recycles those)
  // or wrapper identity (div names change every render). The cache key is
  // a hash of the trimmed post text — that's the only thing stable across
  // reloads and DOM rewrites.
  if (!evaluatedWrappers.has(wrapper)) {
    const cached = cacheGetVerdict(rawText);
    if (cached) {
      perfStats.cacheHits++;
      // The paint decision for a cached slop verdict is ALWAYS:
      // "does the stored confidence clear the user's CURRENT threshold?"
      // This way the threshold is the single source of truth — works
      // whether the verdict was originally classified as above-threshold
      // (e.g. 96% when threshold was 80) and the user later raised the
      // bar to 99, or was suppressed below threshold (the belowThreshold
      // case) and the user later lowered it. Either way, the cached
      // confidence + the current threshold determine the outcome.
      const threshold = settings.minConfidence ?? 80;
      const meetsThreshold = cached.isSlop && cached.confidence >= threshold;
      if (meetsThreshold) {
        const note = cached.belowThreshold ? " (promoted from low-conf)" : "";
        srLog(`✓cache SLOP ${cached.confidence}%${note} "${rawText.substring(0, 50)}…"`);
        applySlop(wrapper, cached.confidence, cached.reasons || [], true);
      } else if (cached.isSlop) {
        // Cached as slop but doesn't clear the current threshold. Treat
        // like the in-session low-conf path: mark evaluated, no banner.
        // Don't log on every sweep — would flood the log on long sessions.
        evaluatedWrappers.add(wrapper);
        wrapper.dataset.srStampedText = rawText.substring(0, 120);
      } else {
        srLog(`✓cache ok "${rawText.substring(0, 50)}…"`);
        applyNotSlop(wrapper, cached.confidence, false, true);
      }
      targetedTextNodes.add(textNode);
      nodeTextSnapshot.set(textNode, rawText);
      return;
    }
  }

  // Promoted / Ad short-circuit: structurally detected paid placements get
  // marked as slop immediately, no AI call. Saves inference time, gives the
  // user a clear reason in the banner, and makes the filter consistent
  // regardless of how the model would have classified the ad copy.
  // (We check this BEFORE the dup branch — if the wrapper just had a
  // Promoted label injected, we want to catch it even on a re-sweep.)
  if (!wrapper.querySelector(".slop_dog_ear") && isPromotedPost(wrapper)) {
    if (evaluatedWrappers.has(wrapper)) resetWrapper(wrapper);
    srLog(`✓promoted "${rawText.substring(0, 50)}…"`);
    applySlop(wrapper, 100, [
      IS_TWITTER ? "promoted post (X ad)" : "promoted post (LinkedIn ad)",
    ]);
    targetedTextNodes.add(textNode);
    nodeTextSnapshot.set(textNode, rawText);
    return;
  }

  // Dedup — but handle recycled nodes (X reuses <article> elements as you
  // scroll; the same DOM node ends up holding a different tweet). If the
  // text changed, treat it as a fresh node.
  if (targetedTextNodes.has(textNode)) {
    const lastText = nodeTextSnapshot.get(textNode);
    if (lastText === rawText) {
      // Genuinely unchanged — but the platform may have RE-RENDERED the card
      // since we stamped it, wiping the banner / NOT-SLOP tag we injected.
      // If we have a cached verdict for this exact text and the visible
      // marks are missing, re-apply silently from cache (no AI call).
      maybeReapplyFromCache(wrapper, rawText);
      return;
    }
    targetedTextNodes.delete(textNode);        // recycled — allow re-eval
  }

  // If the wrapper was already stamped but now holds different text,
  // it was recycled too — clear its marks so we re-evaluate.
  if (evaluatedWrappers.has(wrapper)) {
    const stampedText = wrapper.dataset.srStampedText;
    if (stampedText && stampedText !== rawText.substring(0, 120)) {
      resetWrapper(wrapper);
    } else {
      // Same wrapper, same text — but LinkedIn (and X) re-render the card's
      // inner content as you scroll/navigate, which silently destroys the
      // banner / blur / NOT-SLOP tag we injected while leaving the wrapper
      // element itself in evaluatedWrappers. Our state says "done" but the
      // DOM is blank. Detect that and re-apply from the cached verdict.
      maybeReapplyFromCache(wrapper, rawText);
      return;
    }
  }

  targetedTextNodes.add(textNode);
  nodeTextSnapshot.set(textNode, rawText);
  pendingNodes.push({ textNode, wrapper, enqueuedAt: performance.now() });
}

// Remove all SlopRadar marks from a recycled wrapper so it can be re-evaluated
function resetWrapper(wrapper) {
  evaluatedWrappers.delete(wrapper);
  // NOTE: verdictCache is text-keyed, not element-keyed, so there is
  // nothing to delete here — a recycled wrapper holding the same text
  // will simply hit the cache again, which is what we want.
  wrapper.removeAttribute("data-slop-detected");
  wrapper.removeAttribute("data-sr-revealed");
  delete wrapper.dataset.srStampedText;
  wrapper.classList.remove("slop_radar_card", "sr_hide_mode", "sr_noninstrusive",
    "slop_radar_twitter", "slop_radar_linkedin", "slop_radar_universal",
    "slop_radar_reddit", "slop_radar_threads");
  wrapper.querySelector(".slop_dog_ear")?.remove();
  wrapper.querySelector(".sr_reveal_spacer")?.remove();
  wrapper.querySelector(".not_slop_dog_ear")?.remove();
  wrapper.querySelector(".not_slop_tw_wrap")?.remove();
  wrapper.querySelector(".sr_blur_cover")?.remove();
  wrapper.querySelector(".sr_pattern_feedback")?.remove();
  wrapper.style.removeProperty("max-height");
  wrapper.style.removeProperty("overflow");
  wrapper.style.removeProperty("display"); // remove-entirely mode sets this
  wrapper.style.removeProperty("padding-top");
}

// Re-render every currently-flagged slop card using the current display-mode
// settings. Called when the user changes Hide/Remove/Non-intrusive/training
// settings while a feed is already classified. We reuse the cached verdict so
// no new AI calls are made.
function reapplyAllSlopCards() {
  const flagged = document.querySelectorAll('[data-slop-detected="true"]');
  let n = 0;
  flagged.forEach(wrapper => {
    // Pull the cached verdict by the wrapper's stamped text before resetting.
    const txt = wrapper.textContent?.trim().substring(0, 800) || "";
    const cached = cacheGetVerdict(txt);
    resetWrapper(wrapper);
    if (cached && cached.isSlop) {
      applySlop(wrapper, cached.confidence, cached.reasons || [], true);
      n++;
    }
  });
  // Also handle remove-entirely cards that were display:none'd (they keep
  // data-slop-detected, so the selector above already caught them).
  if (n > 0) srLog(`re-rendered ${n} slop card(s) for new display mode`);
}

function queueContainerCheck(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (isComposerOrInput(node)) return;
  if (node.classList?.contains("slop_dog_ear") || node.classList?.contains("not_slop_dog_ear") ||
      node.classList?.contains("slop_radar_controls") || node.classList?.contains("not_slop_tw_wrap") ||
      node.id === "sr_site_pause_banner") return;

  if (IS_TWITTER) {
    if (node.dataset?.testid === "tweetText") enqueueNode(node);
    else node.querySelectorAll('[data-testid="tweetText"]').forEach(enqueueNode);
  } else {
    const sel = getTextSelectors();
    if (node.matches?.(sel)) enqueueNode(node);
    node.querySelectorAll(sel).forEach(enqueueNode);
  }
}

// ── Discovery: periodic polling sweep ─────────────────────────────────────
// We deliberately AVOID an aggressive subtree MutationObserver here.
// Two reasons:
//   1. X recycles <article> nodes as you scroll — a node already in the DOM
//      whose tweetText re-renders never fires an addedNodes mutation, so an
//      observer silently misses 10-20% of posts.
//   2. LinkedIn's integrity/anti-bot script (HUMAN Security + reCAPTCHA)
//      flags pages with extension-style high-frequency DOM observation.
// A plain setInterval that re-runs querySelectorAll is quieter (no observer
// registration to fingerprint, no per-mutation callbacks) and re-scans the
// whole feed each pass, so recycled nodes get picked up.

let sweepTimer = null;
// Sweep cadence per platform. LinkedIn used to be at 1200ms (too conservative)
// which made the queue feel slow on heavy feeds — bumping it closer to X's
// 700ms keeps the in-viewport posts populating quickly without thrashing.
// Scroll events also trigger out-of-cadence sweeps via scrollSweepThrottle,
// so this is more of a "background refresh" than a hard upper bound.
const SWEEP_INTERVAL_MS = IS_LINKEDIN ? 800 : 700;

// Set to true to get verbose per-sweep diagnostics in the console.
// When true, every sweep is logged regardless of outcome. By default we only
// log sweeps with new work, slow sweeps, or empty-match sweeps (DOM may have
// changed). Flip this on locally if you're debugging selector issues.
const SR_DEBUG = false;

// Deep diagnostic — runs whenever a sweep matches nothing. Tells us
// definitively whether the DOM is empty, in an iframe, in shadow DOM,
// or just using class names we don't know.
function probeSelectors() {
  const candidates = [
    'span[dir="ltr"]', 'div[dir="ltr"]', '[dir="ltr"]',
    '.update-components-text', '.feed-shared-update-v2__description-wrapper',
    '.feed-shared-inline-show-more-text', '.feed-shared-text',
    '.update-components-update-v2__commentary',
    'article', '[data-urn]', '[data-id]', '[data-activity-urn]',
    '.feed-shared-update-v2', '.fie-impression-container',
    'main', '.scaffold-finite-scroll__content', '[data-finite-scroll-hotspot]',
    '.scaffold-layout__main', '[role="main"]',
  ];

  // Flat (document only) vs deep (shadow + iframes) counts side by side.
  const hits = candidates.map(sel => {
    let flat = 0, deep = 0;
    try { flat = document.querySelectorAll(sel).length; } catch (_) {}
    try { deep = deepQuery(sel, document).length; } catch (_) {}
    return { sel, flat, deep };
  }).filter(h => h.flat > 0 || h.deep > 0);

  console.log("[SlopRadar] ── DIAGNOSTIC ──────────────────────────────");
  console.log("[SlopRadar] total elements in document:", document.querySelectorAll("*").length);
  console.log("[SlopRadar] body text length:", (document.body?.innerText || "").length);
  console.log("[SlopRadar] selector hits (flat → deep):",
    hits.length
      ? hits.map(h => `${h.sel}=${h.flat}→${h.deep}`).join("  ")
      : "NONE — every candidate matched 0 even deep");

  const iframes = document.querySelectorAll("iframe");
  console.log("[SlopRadar] iframes on page:", iframes.length);
  // How many iframes are same-origin (reachable)?
  let sameOrigin = 0;
  iframes.forEach(f => { try { if (f.contentDocument) sameOrigin++; } catch (_) {} });
  console.log("[SlopRadar] same-origin (reachable) iframes:", sameOrigin);

  let shadowHosts = 0;
  document.querySelectorAll("*").forEach(el => { if (el.shadowRoot) shadowHosts++; });
  console.log("[SlopRadar] elements with open shadowRoot:", shadowHosts);

  // Largest text block — search DEEP this time so we find the real post text
  let biggest = null, biggestLen = 0;
  deepQuery("span,div,p", document).forEach(el => {
    const t = (el.textContent || "").trim();
    if (t.length > biggestLen && t.length < 2200) { biggestLen = t.length; biggest = el; }
  });
  if (biggest) {
    console.log("[SlopRadar] largest text block:", biggestLen, "chars |",
      "tag:", biggest.tagName,
      "| class:", (biggest.className || "(none)").toString().slice(0, 80),
      "| dir:", biggest.getAttribute("dir") || "(none)",
      "| in-shadow:", isInShadow(biggest));
  }
  console.log("[SlopRadar] location.href:", location.href);
  console.log("[SlopRadar] ────────────────────────────────────────────");
}

// Is an element inside a shadow root (rather than the main document)?
function isInShadow(el) {
  let node = el;
  while (node) {
    const root = node.getRootNode && node.getRootNode();
    if (root && root.host) return true; // ShadowRoot has a .host
    node = root && root.host ? root.host : null;
  }
  return false;
}

let sweepCount = 0;
let lastProbeAt = 0;

// ── Deep DOM query — pierces shadow roots and same-origin iframes ─────────
// LinkedIn now renders feed posts inside shadow DOM and/or iframes.
// document.querySelectorAll cannot cross those boundaries, so a normal
// query returns almost nothing. deepQuery walks every open shadowRoot and
// every reachable same-origin iframe document and collects matches from all
// of them.
function deepQuery(selector, root, out, seenDocs, depth) {
  out = out || [];
  seenDocs = seenDocs || new Set();
  depth = depth || 0;
  if (depth > 12 || !root) return out;

  // Matches in this root
  try {
    root.querySelectorAll(selector).forEach(el => out.push(el));
  } catch (_) { /* invalid selector for this root — ignore */ }

  // Descend into shadow roots
  try {
    root.querySelectorAll("*").forEach(el => {
      if (el.shadowRoot) {
        deepQuery(selector, el.shadowRoot, out, seenDocs, depth + 1);
      }
    });
  } catch (_) {}

  // Descend into same-origin iframes
  try {
    const frames = root.querySelectorAll("iframe");
    frames.forEach(frame => {
      let doc = null;
      try { doc = frame.contentDocument; } catch (_) { doc = null; } // cross-origin → null
      if (doc && !seenDocs.has(doc)) {
        seenDocs.add(doc);
        deepQuery(selector, doc, out, seenDocs, depth + 1);
      }
    });
  } catch (_) {}

  return out;
}

// Count how many shadow roots / iframes exist — used to decide whether the
// deep path is even needed (it's more expensive than a flat query).
let pageUsesShadowOrFrames = false;
function detectShadowOrFrames() {
  try {
    if (document.querySelectorAll("iframe").length > 0) { pageUsesShadowOrFrames = true; return; }
    const els = document.querySelectorAll("*");
    for (let i = 0; i < els.length; i++) {
      if (els[i].shadowRoot) { pageUsesShadowOrFrames = true; return; }
    }
  } catch (_) {}
}

function sweep() {
  if (isPaused || isSitePaused()) return;
  sweepCount++;
  const tSweepStart = performance.now();

  // Flat query first (cheap). If it finds nothing AND the page has shadow
  // roots or iframes, fall back to the deep query.
  let rawMatches = Array.from(document.querySelectorAll(getTextSelectors()));
  let usedDeep = false;
  if (rawMatches.length === 0) {
    detectShadowOrFrames();
    if (pageUsesShadowOrFrames) {
      rawMatches = deepQuery(getTextSelectors(), document);
      usedDeep = true;
    }
  }

  let found = 0;
  let rejectedComposer = 0, rejectedShort = 0, rejectedNoWrapper = 0, rejectedDup = 0;

  rawMatches.forEach(node => {
    if (isComposerOrInput(node)) { rejectedComposer++; return; }
    const txt = (node.textContent || "").trim();
    if (txt.length < MIN_POST_CHARS) { rejectedShort++; return; }
    const before = pendingNodes.length;
    const wrapper = getPostWrapper(node);
    if (!wrapper) { rejectedNoWrapper++; return; }
    enqueueNode(node);
    if (pendingNodes.length > before) found++;
    else rejectedDup++;
  });

  const sweepMs = performance.now() - tSweepStart;
  perfStats.sweepCount++;
  perfStats.sweepMatchedTotal += rawMatches.length;
  perfStats.sweepEnqueuedTotal += found;

  // Slow-sweep warning: if any single sweep takes longer than the sweep
  // interval itself (800ms LinkedIn, 700ms X), we're falling behind and
  // need to know. Logs immediately rather than waiting for the 15s flush.
  if (sweepMs > SWEEP_INTERVAL_MS) {
    srLog(`⚠ slow sweep #${sweepCount}: ${Math.round(sweepMs)}ms ` +
      `(matched ${rawMatches.length}, enq ${found}). ` +
      `Cadence ${SWEEP_INTERVAL_MS}ms — falling behind.`);
  }

  // Sweep logging strategy: only log when something interesting happened so
  // the Logs tab isn't a wall of identical "matched 16 enqueued 0" lines.
  //   • enqueued > 0   → log it (work entered the system)
  //   • slow sweep     → log it (already handled above)
  //   • matched 0      → log occasionally (selectors might be broken)
  //   • SR_DEBUG       → log everything (developer mode)
  const interesting = found > 0 || sweepMs > SWEEP_INTERVAL_MS ||
    (rawMatches.length === 0 && Date.now() - lastProbeAt > 5000);
  if (SR_DEBUG || interesting) {
    srLog(
      `sweep #${sweepCount} ${Math.round(sweepMs)}ms | ` +
      `matched ${rawMatches.length}${usedDeep ? "[deep]" : ""} ` +
      `enq ${found} q ${pendingNodes.length} ` +
      `(rej: comp ${rejectedComposer}, short ${rejectedShort}, ` +
      `noWrap ${rejectedNoWrapper}, dup ${rejectedDup})`
    );
    if (rawMatches.length === 0 && Date.now() - lastProbeAt > 5000) {
      lastProbeAt = Date.now();
      probeSelectors();
    }
  }

  if (found > 0) {
    sortPendingByViewport();
    scheduleDrain();
  }
}

function startSweeping() {
  if (sweepTimer) return;
  // Register the interval FIRST, before the initial sweep — that way a
  // throw in the first sweep can never prevent subsequent sweeps.
  sweepTimer = setInterval(safeSweep, SWEEP_INTERVAL_MS);
  safeSweep(); // immediate first pass
}

// Wrap sweep so a single bad pass (DOM race, detached node, etc.) can
// never kill the interval. Without this, one thrown error silently
// stops all future sweeps.
function safeSweep() {
  try {
    sweep();
  } catch (err) {
    srLog("sweep error (non-fatal, will retry):", String(err));
  }
}

function stopSweeping() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

// A scroll also triggers an out-of-cadence sweep so new posts appear fast
let scrollSweepThrottle = null;
window.addEventListener("scroll", () => {
  if (scrollSweepThrottle) return;
  scrollSweepThrottle = setTimeout(() => {
    scrollSweepThrottle = null;
    safeSweep();
  }, 250);
}, { passive: true });

// ── Bootstrap ─────────────────────────────────────────────────────────────
loadSettings(() => {
  applyTheme(IS_TWITTER ? "dark" : (settings.darkMode ? "dark" : "light"));

  // The manifest only injects this script on supported social sites, so we
  // no longer maintain a default exclusion list. Users can still exclude a
  // specific supported host (e.g. they want it on LinkedIn but not Reddit).
  const userExcluded = (settings.excludedSites || [])
    .some(s => s && PAGE_HOSTNAME.includes(s));
  if (userExcluded) {
    srLog(`${PAGE_HOSTNAME} is on your excluded list — not scanning.`);
    return;
  }

  if (isSitePaused()) {
    showSitePauseBanner();
    return; // don't sweep, don't process
  }

  if (IS_BETA_PLATFORM) {
    srLog(`${PLATFORM} support is beta — using the generic detector. ` +
      `Detection may be less precise than on LinkedIn/X.`);
  }

  // Restore the persisted verdict cache BEFORE the first sweep — otherwise
  // posts already classified in a previous session would all hit the AI
  // again instead of using their cached verdict. The sweep starts inside
  // the callback so we never race.
  restoreVerdictCache(() => {
    startSweeping();
  });
});
