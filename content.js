// content.js

const IS_TWITTER = location.hostname.includes("x.com") || location.hostname.includes("twitter.com");
const IS_LINKEDIN = location.hostname.includes("linkedin.com");
const PAGE_HOSTNAME = location.hostname;
const PLATFORM = IS_TWITTER ? "twitter" : IS_LINKEDIN ? "linkedin" : "universal";

// ── Settings ──────────────────────────────────────────────────────────────
let settings = {
  darkMode: false, showTrashCan: true,
  minConfidence: 60, universalMode: true, hideSlop: false,
};
let isPaused = false;

// Per-site pause: { [hostname]: "session" | "forever" }
// "session" = in-memory only, "forever" = persisted in storage
const sessionPausedSites = new Set();

function isSitePaused() {
  return sessionPausedSites.has(PAGE_HOSTNAME);
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
    settings = { ...settings, ...request.settings };
    applyTheme(IS_TWITTER ? "dark" : (settings.darkMode ? "dark" : "light"));
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
    draining = false;
    showSitePauseBanner();
  }
});

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
  // evaluatedWrappers is a WeakSet — can't .clear(); it self-empties as
  // detached nodes are garbage-collected after navigation.
  postCache.clear && postCache.clear();
  console.log("[SlopRadar] Queue flushed");
}

// ── Page stats ────────────────────────────────────────────────────────────
const pageStats = { checked: 0, slop: 0 };
function recordResult(isSlop) {
  pageStats.checked++;
  if (isSlop) pageStats.slop++;
  chrome.runtime.sendMessage({ action: "recordResult", hostname: PAGE_HOSTNAME, isSlop }).catch(() => {});
}

// ── Post cache (WeakMap: wrapper → {isSlop, confidence, text}) ────────────
const postCache = new WeakMap();

// ── Viewport-priority queue ───────────────────────────────────────────────
let pendingNodes = [];
const targetedTextNodes = new Set();
const evaluatedWrappers = new WeakSet();
const evaluatedLengths = new WeakMap();
const nodeTextSnapshot = new WeakMap(); // textNode → last seen text (recycle detection)
let currentQueueSize = 0;

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
    display: flex !important; align-items: center !important; gap: 10px !important;
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

  /* LinkedIn/universal collapse */
  .slop_radar_linkedin[data-slop-detected="true"]:not([data-sr-revealed]):not(.sr_hide_mode),
  .slop_radar_universal[data-slop-detected="true"]:not([data-sr-revealed]):not(.sr_hide_mode) {
    max-height: 80px !important; overflow: hidden !important;
  }
  .slop_radar_linkedin[data-slop-detected="true"][data-sr-revealed],
  .slop_radar_universal[data-slop-detected="true"][data-sr-revealed] {
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

  // Reject anything that isn't in the main feed scroll region — this keeps
  // us out of the nav, the left/right rails, and the messaging overlay.
  // LinkedIn's feed lives under one of these stable containers.
  const feedRoot = textNode.closest(
    '[data-finite-scroll-hotspot], .scaffold-finite-scroll, ' +
    '.scaffold-layout__main, main'
  );
  if (!feedRoot) return null;

  // Reject comment text — comments sit inside .comments-comment-* containers
  // and we only want top-level posts.
  if (textNode.closest('.comments-comment-item, .comments-comments-list, ' +
      '[class*="comment-item"], [class*="comments-"]')) {
    return null;
  }

  const cardSelectors = [
    '[data-urn]','[data-activity-urn]','[data-id]',
    '.feed-shared-update-v2','.occludable-update','.nt-card','article',
  ];
  for (const sel of cardSelectors) {
    const found = textNode.closest(sel);
    if (found && !isInsideModal(found)) {
      const p = found.parentElement;
      if (p && (p.tagName === 'LI' || (p.className||'').toLowerCase().includes('item-wrapper'))) return p;
      return found;
    }
  }
  const INNER = ['__description','__text','__content','segment-list','inline-show'];
  let el = textNode.parentElement, best = null, depth = 0;
  while (el && el.tagName !== 'BODY' && el.tagName !== 'MAIN' && depth < 20) {
    if (el.matches?.(LINKEDIN_MODAL_SEL)) return null;
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const hasUrn = el.hasAttribute('data-urn') || el.hasAttribute('data-activity-urn') || el.hasAttribute('data-id');
    const isInner = INNER.some(c => cls.includes(c));
    if (!isInner && (hasUrn || cls.includes('occludable') || cls.includes('feed-shared-update-v2') || cls.includes('nt-card') || el.tagName === 'ARTICLE' || el.tagName === 'LI')) best = el;
    el = el.parentElement; depth++;
  }
  if (!best) {
    let fb = textNode.parentElement;
    for (let i = 0; i < 8 && fb && fb.tagName !== 'BODY'; i++) fb = fb.parentElement;
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

// ── Learn from slop ───────────────────────────────────────────────────────
function learnFromPost(postText, btn) {
  btn.textContent = "⏳"; btn.disabled = true;
  chrome.runtime.sendMessage({ action: "learnFromSlop", postText }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) { btn.textContent = "🗑️"; btn.disabled = false; return; }
    const n = res.newPatterns?.length ?? 0;
    btn.textContent = n > 0 ? `✓ +${n}` : "✓";
    btn.title = n > 0 ? `Learned ${n} new patterns` : "Already covered";
  });
}

// ── Uncategorize slop → not-slop ─────────────────────────────────────────
function uncategorizeSlop(wrapper, postText, btn) {
  btn.textContent = "⏳"; btn.disabled = true;
  chrome.runtime.sendMessage({ action: "unlearn", postText }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) { btn.textContent = "✗"; btn.disabled = false; return; }
    // Visually revert: remove slop marks, add not-slop tag
    wrapper.removeAttribute("data-slop-detected");
    wrapper.removeAttribute("data-sr-revealed");
    wrapper.querySelector(".slop_dog_ear")?.remove();
    wrapper.querySelector(".sr_blur_cover")?.remove();
    wrapper.querySelectorAll(".sr_hide_mode").forEach(el => el.classList.remove("sr_hide_mode"));
    wrapper.classList.remove("sr_hide_mode");
    wrapper.style.removeProperty("max-height");
    wrapper.style.removeProperty("overflow");
    // Update cache
    postCache.set(wrapper, { isSlop: false, confidence: 0 });
    evaluatedWrappers.delete(wrapper); // allow re-stamp
    applyNotSlop(wrapper, 0, true);   // force=true skips evaluated check
    console.log("[SlopRadar] Uncategorized as NOT SLOP");
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
function applySlop(wrapper, confidence) {
  if (evaluatedWrappers.has(wrapper)) return;
  if (wrapper.querySelector(".slop_dog_ear")) return;
  wrapper.querySelector(".not_slop_dog_ear")?.remove();
  wrapper.querySelector(".not_slop_tw_wrap")?.remove();

  evaluatedWrappers.add(wrapper);
  const postText = wrapper.textContent?.trim().substring(0, 800) || "";
  postCache.set(wrapper, { isSlop: true, confidence, text: postText });

  wrapper.classList.add("slop_radar_card", `slop_radar_${PLATFORM}`);
  wrapper.setAttribute("data-slop-detected", "true");
  wrapper.removeAttribute("data-sr-revealed");
  wrapper.dataset.srStampedText = postText.substring(0, 120);

  if (window.getComputedStyle(wrapper).position === "static") {
    wrapper.style.setProperty("position", "relative", "important");
  }

  // hideSlop mode: just add class and banner, hide everything else
  if (settings.hideSlop) {
    wrapper.classList.add("sr_hide_mode");
  } else if (!IS_TWITTER) {
    killMedia(wrapper);
    wrapper.style.setProperty("overflow", "hidden", "important");
  }

  // Banner
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

  // "Not slop" correction button
  const notSlopBtn = document.createElement("button");
  notSlopBtn.className = "slop_radar_btn";
  notSlopBtn.textContent = "✓ Not slop";
  notSlopBtn.title = "Incorrectly flagged? Teach SlopRadar";
  notSlopBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    uncategorizeSlop(wrapper, postText, notSlopBtn);
  });
  controls.appendChild(notSlopBtn);

  banner.append(ribbon, controls);
  wrapper.insertBefore(banner, wrapper.firstChild);

  // Blur cover (non-hide mode only)
  if (!settings.hideSlop) {
    const blurCover = document.createElement("div");
    blurCover.className = "sr_blur_cover";
    wrapper.appendChild(blurCover);
    requestAnimationFrame(() => {
      blurCover.style.top = (banner.offsetHeight || 40) + "px";
    });
  }

  recordResult(true);
}

// ── Apply NOT SLOP ────────────────────────────────────────────────────────
function applyNotSlop(wrapper, confidence, force = false) {
  if (!force && evaluatedWrappers.has(wrapper)) return;
  if (wrapper.getAttribute("data-slop-detected") === "true") return;

  evaluatedWrappers.add(wrapper);
  const postText = wrapper.textContent?.trim().substring(0, 800) || "";
  postCache.set(wrapper, { isSlop: false, confidence, text: postText });
  wrapper.dataset.srStampedText = postText.substring(0, 120);

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
        tb.addEventListener("click", (e) => { e.stopPropagation(); learnFromPost(postText, tb); });
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
      tb.addEventListener("click", (e) => { e.stopPropagation(); learnFromPost(postText, tb); });
      ear.appendChild(tb);
    }

    wrapper.appendChild(ear);
  }
  recordResult(false);
}

// ── Text selectors ────────────────────────────────────────────────────────
function getTextSelectors() {
  if (IS_TWITTER) return '[data-testid="tweetText"]';
  if (IS_LINKEDIN) {
    // LinkedIn rotates obfuscated CSS class names, so class-based selectors
    // break silently. We target structure instead: post body text on
    // LinkedIn is always inside `<span dir="ltr">` (a stable accessibility
    // attribute). We cast wide and let getLinkedInWrapper + the 40-char
    // minimum filter out nav/labels/buttons.
    return [
      'span[dir="ltr"]',
      // Keep the class-based ones too — when they DO match they give a
      // cleaner text node, and they cost nothing when they don't.
      '.update-components-text',
      '.feed-shared-update-v2__description-wrapper',
      '.feed-shared-inline-show-more-text',
    ].join(',');
  }
  return 'p, [class*="post"] p, [class*="content"] p, article p';
}

// ── Drain loop ────────────────────────────────────────────────────────────
let draining = false;

async function drainOne() {
  if (isPaused || isSitePaused() || pendingNodes.length === 0) { draining = false; return; }
  draining = true;

  const item = pendingNodes.shift();
  currentQueueSize = pendingNodes.length;
  const { textNode, wrapper } = item;

  if (evaluatedWrappers.has(wrapper) || !document.contains(wrapper)) {
    requestAnimationFrame(drainOne); return;
  }

  if (postCache.has(wrapper)) {
    const cached = postCache.get(wrapper);
    if (cached.isSlop) applySlop(wrapper, cached.confidence);
    else applyNotSlop(wrapper, cached.confidence);
    requestAnimationFrame(drainOne); return;
  }

  const rawText = (textNode.textContent || "").trim();
  if (rawText.length < 40 || evaluatedLengths.get(wrapper) === rawText.length) {
    requestAnimationFrame(drainOne); return;
  }
  evaluatedLengths.set(wrapper, rawText.length);

  console.log(`[SlopRadar] Q:${pendingNodes.length} "${rawText.substring(0,60)}…"`);

  chrome.runtime.sendMessage(
    { action: "evaluatePost", text: rawText.substring(0, 1500), tabId: MY_TAB_ID },
    (response) => {
      if (chrome.runtime.lastError) { requestAnimationFrame(drainOne); return; }
      const confidence = response?.confidence ?? 50;
      if (response?.isSlop) applySlop(wrapper, confidence);
      else if (response) applyNotSlop(wrapper, confidence);
      requestAnimationFrame(drainOne);
    }
  );
}

function scheduleDrain() {
  if (!draining && !isPaused && !isSitePaused() && pendingNodes.length > 0) {
    draining = true;
    requestAnimationFrame(drainOne);
  }
}

// ── Enqueue ───────────────────────────────────────────────────────────────
function enqueueNode(textNode) {
  if (isComposerOrInput(textNode)) return;
  const rawText = (textNode.textContent || "").trim();
  if (rawText.length < 40) return;

  // Dedup — but handle recycled nodes (X reuses <article> elements as you
  // scroll; the same DOM node ends up holding a different tweet). If the
  // text changed, treat it as a fresh node.
  if (targetedTextNodes.has(textNode)) {
    const lastText = nodeTextSnapshot.get(textNode);
    if (lastText === rawText) return;          // genuinely unchanged
    targetedTextNodes.delete(textNode);        // recycled — allow re-eval
  }

  const wrapper = getPostWrapper(textNode);
  if (!wrapper || isComposerOrInput(wrapper)) return;

  // If the wrapper was already stamped but now holds different text,
  // it was recycled too — clear its marks so we re-evaluate.
  if (evaluatedWrappers.has(wrapper)) {
    const stampedText = wrapper.dataset.srStampedText;
    if (stampedText && stampedText !== rawText.substring(0, 120)) {
      resetWrapper(wrapper);
    } else {
      return;
    }
  }

  targetedTextNodes.add(textNode);
  nodeTextSnapshot.set(textNode, rawText);
  pendingNodes.push({ textNode, wrapper });
}

// Remove all SlopRadar marks from a recycled wrapper so it can be re-evaluated
function resetWrapper(wrapper) {
  evaluatedWrappers.delete(wrapper);
  postCache.delete(wrapper);
  wrapper.removeAttribute("data-slop-detected");
  wrapper.removeAttribute("data-sr-revealed");
  delete wrapper.dataset.srStampedText;
  wrapper.classList.remove("slop_radar_card", "sr_hide_mode",
    "slop_radar_twitter", "slop_radar_linkedin", "slop_radar_universal");
  wrapper.querySelector(".slop_dog_ear")?.remove();
  wrapper.querySelector(".not_slop_dog_ear")?.remove();
  wrapper.querySelector(".not_slop_tw_wrap")?.remove();
  wrapper.querySelector(".sr_blur_cover")?.remove();
  wrapper.style.removeProperty("max-height");
  wrapper.style.removeProperty("overflow");
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
const SWEEP_INTERVAL_MS = IS_LINKEDIN ? 1200 : 700; // gentler cadence on LinkedIn

// Set to true to get verbose per-sweep diagnostics in the console.
const SR_DEBUG = true;

// Probe a range of candidate selectors and report which ones match.
// Runs only in debug mode, only on the first few sweeps. This tells us
// definitively what LinkedIn's current DOM looks like.
function probeSelectors() {
  const candidates = [
    'span[dir="ltr"]',
    'div[dir="ltr"]',
    '[dir="ltr"]',
    '.update-components-text',
    '.feed-shared-update-v2__description-wrapper',
    '.feed-shared-inline-show-more-text',
    '.feed-shared-text',
    '.update-components-update-v2__commentary',
    'article',
    '[data-urn]',
    '[data-id]',
    '.feed-shared-update-v2',
    '.fie-impression-container',
    'main',
    '.scaffold-finite-scroll__content',
    '[data-finite-scroll-hotspot]',
  ];
  const hits = candidates
    .map(sel => {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch (_) {}
      return `${sel}=${n}`;
    })
    .filter(s => !s.endsWith("=0"));
  console.log("[SlopRadar] selector probe →", hits.length ? hits.join("  ") : "NOTHING matched anything");
}

let sweepCount = 0;
function sweep() {
  if (isPaused || isSitePaused()) return;
  sweepCount++;

  const rawMatches = document.querySelectorAll(getTextSelectors());
  let found = 0;
  let rejectedComposer = 0, rejectedShort = 0, rejectedNoWrapper = 0, rejectedDup = 0;

  rawMatches.forEach(node => {
    if (isComposerOrInput(node)) { rejectedComposer++; return; }
    const txt = (node.textContent || "").trim();
    if (txt.length < 40) { rejectedShort++; return; }
    const before = pendingNodes.length;
    const wrapper = getPostWrapper(node);
    if (!wrapper) { rejectedNoWrapper++; return; }
    enqueueNode(node);
    if (pendingNodes.length > before) found++;
    else rejectedDup++;
  });

  // Log the first several sweeps + any sweep that finds something.
  if (SR_DEBUG && (sweepCount <= 6 || found > 0)) {
    console.log(
      `[SlopRadar] sweep #${sweepCount} on ${PLATFORM}: ` +
      `selector matched ${rawMatches.length} | enqueued ${found} | ` +
      `queue ${pendingNodes.length} ` +
      `(rejected: composer ${rejectedComposer}, short ${rejectedShort}, ` +
      `no-wrapper ${rejectedNoWrapper}, dup/seen ${rejectedDup})`
    );
    // On sweep #2, if nothing matched, dump a full selector probe so we
    // can see exactly what LinkedIn's DOM exposes right now.
    if (rawMatches.length === 0 && sweepCount === 2) {
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
    console.warn("[SlopRadar] sweep error (non-fatal, will retry):", err);
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

  if (isSitePaused()) {
    showSitePauseBanner();
    return; // don't sweep, don't process
  }

  startSweeping();
});
