// content.js

const IS_TWITTER = location.hostname.includes("x.com") || location.hostname.includes("twitter.com");
const IS_LINKEDIN = location.hostname.includes("linkedin.com");
const PAGE_HOSTNAME = location.hostname;
const PLATFORM = IS_TWITTER ? "twitter" : IS_LINKEDIN ? "linkedin" : "universal";

// ── Settings ──────────────────────────────────────────────────────────────
let settings = {
  darkMode: false, showTrashCan: true, showMessageAuthor: true,
  minConfidence: 60, universalMode: true,
};
let isPaused = false;

function loadSettings(cb) {
  chrome.runtime.sendMessage({ action: "getSettings" }, (s) => {
    if (!chrome.runtime.lastError && s) settings = { ...settings, ...s };
    if (cb) cb();
  });
  chrome.runtime.sendMessage({ action: "getPauseState" }, (res) => {
    if (!chrome.runtime.lastError && res) isPaused = !!res.paused;
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
    if (!isPaused) scheduleDrain();
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

// SPA nav flush
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    pendingNodes.length = 0;
    targetedTextNodes.clear();
    evaluatedWrappers.clear();
    postCache.clear();
    console.log("[SlopRadar] SPA nav — queue flushed");
    chrome.runtime.sendMessage({ action: "tabRefreshing", tabId: MY_TAB_ID }).catch(() => {});
  }
}).observe(document, { childList: true, subtree: false });

// ── Page stats ────────────────────────────────────────────────────────────
const pageStats = { checked: 0, slop: 0 };
function recordResult(isSlop) {
  pageStats.checked++;
  if (isSlop) pageStats.slop++;
  chrome.runtime.sendMessage({ action: "recordResult", hostname: PAGE_HOSTNAME, isSlop }).catch(() => {});
}

// ── Post cache ────────────────────────────────────────────────────────────
// WeakMap keyed on wrapper element — stores {text, isSlop, confidence}
// so re-encountered wrappers (scroll back) are instantly re-stamped
const postCache = new WeakMap();

// ── Viewport-priority queue ───────────────────────────────────────────────
let pendingNodes = [];
const targetedTextNodes = new Set();
const evaluatedWrappers = new WeakSet();
const evaluatedLengths = new WeakMap();
let currentQueueSize = 0;
let processRafId = null;

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

  /* ── Card base ── */
  .slop_radar_card { position: relative !important; }

  /* ── Dog-ear (shared: slop=red, notslop=green) ── */
  .slop_dog_ear, .not_slop_dog_ear {
    position: absolute !important;
    top: -100px !important; right: 0 !important;
    width: 260px !important; height: 260px !important;
    overflow: hidden !important;
    pointer-events: none !important;
    z-index: 99999 !important;
  }
  .slop_dog_ear_ribbon, .not_slop_ribbon {
    position: absolute !important;
    top: 50px !important; right: -65px !important; width: 360px !important;
    padding: 11px 0 !important; text-align: center !important;
    font-size: 1rem !important; font-weight: 900 !important;
    transform: rotate(45deg) !important;
    letter-spacing: 0.14rem !important; white-space: nowrap !important;
    display: flex !important; flex-direction: column !important;
    align-items: center !important; gap: 2px !important;
    user-select: none !important; pointer-events: none !important;
    color: #fff !important;
  }
  .slop_dog_ear_ribbon {
    background: var(--sr-red) !important;
    box-shadow: 0 4px 18px rgba(224,36,36,0.45) !important;
  }
  .not_slop_ribbon {
    background: var(--sr-green) !important;
    box-shadow: 0 4px 14px rgba(0,0,0,0.28) !important;
  }
  .slop_dog_ear_ribbon .sr-sub, .not_slop_ribbon .sr-sub {
    font-size: 0.68rem !important; opacity: 0.88 !important;
    font-weight: 700 !important; letter-spacing: 0.05rem !important;
  }

  /* ── TWITTER: blur via data-sr-revealed attribute ── */
  .slop_radar_twitter[data-slop-detected="true"]:not([data-sr-revealed]) .sr_blurable {
    filter: blur(7px) !important;
    opacity: 0.22 !important;
    pointer-events: none !important;
    user-select: none !important;
    transition: filter 0.2s, opacity 0.2s !important;
  }
  .slop_radar_twitter[data-slop-detected="true"][data-sr-revealed] .sr_blurable {
    filter: none !important;
    opacity: 1 !important;
    pointer-events: auto !important;
  }

  /* ── LINKEDIN: collapse ── */
  .slop_radar_linkedin[data-slop-detected="true"]:not([data-sr-revealed]) {
    max-height: 180px !important;
    overflow: hidden !important;
  }
  .slop_radar_linkedin[data-slop-detected="true"][data-sr-revealed] {
    max-height: 3000px !important; overflow: visible !important;
  }
  .slop_radar_linkedin[data-slop-detected="true"]:not([data-sr-revealed]) .sr_blurable {
    opacity: 0.05 !important; filter: blur(6px) !important;
    pointer-events: none !important;
  }
  .slop_radar_linkedin[data-slop-detected="true"][data-sr-revealed] .sr_blurable {
    filter: none !important; opacity: 1 !important; pointer-events: auto !important;
  }

  /* ── UNIVERSAL: same as linkedin ── */
  .slop_radar_universal[data-slop-detected="true"]:not([data-sr-revealed]) {
    max-height: 160px !important; overflow: hidden !important;
  }
  .slop_radar_universal[data-slop-detected="true"][data-sr-revealed] {
    max-height: 3000px !important; overflow: visible !important;
  }
  .slop_radar_universal[data-slop-detected="true"]:not([data-sr-revealed]) .sr_blurable {
    opacity: 0.05 !important; filter: blur(6px) !important;
    pointer-events: none !important;
  }

  /* ── Controls bar ── */
  .slop_radar_controls {
    position: absolute !important;
    left: 12px !important; right: 12px !important; bottom: 8px !important;
    display: flex !important; align-items: center !important; gap: 8px !important;
    z-index: 100001 !important; pointer-events: auto !important;
  }
  /* Twitter controls: below the ribbon, right-aligned */
  .slop_radar_twitter .slop_radar_controls {
    top: 148px !important; bottom: auto !important;
    left: auto !important; right: 12px !important;
    flex-direction: column !important; align-items: flex-end !important;
  }
  .slop_radar_btn {
    font-size: 0.72rem !important; font-weight: 800 !important;
    color: #fff !important; cursor: pointer !important;
    border: none !important; border-radius: 6px !important;
    padding: 5px 12px !important;
    background: var(--sr-red) !important;
    pointer-events: auto !important; z-index: 100002 !important;
    white-space: nowrap !important; transition: opacity 0.12s !important;
    line-height: 1.5 !important; letter-spacing: 0.04rem !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
  }
  .slop_radar_btn:hover { opacity: 0.85 !important; }
  .slop_radar_btn.sr-secondary {
    background: var(--sr-btn-bg) !important;
    color: var(--sr-text2) !important;
    border: 1px solid var(--sr-border) !important;
    box-shadow: none !important;
  }
  .slop_radar_btn.sr-secondary:hover { background: var(--sr-btn-hover) !important; }

  /* Twitter bigger buttons */
  .slop_radar_twitter .slop_radar_btn {
    font-size: 0.8rem !important; padding: 6px 14px !important;
  }

  /* ── NOT SLOP badge (Twitter) ── */
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

  /* ── LinkedIn NOT SLOP trash can ── */
  .not_slop_trash_btn {
    position: absolute !important; top: 140px !important; right: 14px !important;
    pointer-events: auto !important; background: var(--sr-bg) !important;
    border: 1px solid var(--sr-border) !important; border-radius: 50% !important;
    width: 28px !important; height: 28px !important;
    display: flex !important; align-items: center !important; justify-content: center !important;
    font-size: 0.85rem !important; cursor: pointer !important;
    box-shadow: var(--sr-shadow) !important; z-index: 100000 !important;
  }
  .not_slop_trash_btn:hover { background: var(--sr-red-dim) !important; border-color: var(--sr-red-border) !important; }
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
  // Strategy A: direct closest on known card selectors
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
  // Strategy B: walk up 20 levels collecting outermost card-like el
  const INNER = ['__description','__text','__content','segment-list','inline-show'];
  let el = textNode.parentElement, best = null, depth = 0;
  while (el && el.tagName !== 'BODY' && el.tagName !== 'MAIN' && depth < 20) {
    if (el.matches?.(LINKEDIN_MODAL_SEL)) return null;
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const hasUrn = el.hasAttribute('data-urn') || el.hasAttribute('data-activity-urn') || el.hasAttribute('data-id');
    const isInner = INNER.some(c => cls.includes(c));
    if (!isInner && (hasUrn || cls.includes('occludable') || cls.includes('feed-shared-update-v2') || cls.includes('nt-card') || el.tagName === 'ARTICLE' || el.tagName === 'LI')) {
      best = el;
    }
    el = el.parentElement; depth++;
  }
  // Strategy C: 8-level hard climb
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
  // Walk up to find a block-level container with enough text
  let el = textNode.parentElement;
  for (let i = 0; i < 10 && el && el.tagName !== 'BODY'; i++) {
    const tag = el.tagName;
    if (['P','ARTICLE','SECTION','LI','BLOCKQUOTE','DIV'].includes(tag)) {
      const text = el.textContent?.trim() || '';
      if (text.length >= 80) return el;
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
  container.querySelectorAll("video,iframe,audio,source").forEach(m => {
    try { m.pause(); } catch (_) {}
    m.src = ""; m.removeAttribute("src");
    if (typeof m.load === "function") m.load();
    m.remove();
  });
}

// ── Learn ────────────────────────────────────────────────────────────────
function learnFromPost(postText, btn) {
  btn.textContent = "⏳"; btn.disabled = true;
  chrome.runtime.sendMessage({ action: "learnFromSlop", postText }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) { btn.textContent = "🗑️"; btn.disabled = false; return; }
    const n = res.newPatterns?.length ?? 0;
    btn.textContent = n > 0 ? `✓ +${n}` : "✓";
    btn.title = n > 0 ? `Learned ${n} new patterns` : "Already covered";
  });
}

// ── Message author ────────────────────────────────────────────────────────
const NUDGE_MSG = encodeURIComponent(
  `Hey! I noticed your post was caught by SlopRadar — a browser extension that filters AI-generated filler content from feeds.\n\n` +
  `No hard feelings at all — just wanted to share: your audience LOVES hearing the real stuff. What are you actually building? ` +
  `What did you ship this week? A raw screenshot, a quick lesson learned, a specific number — that stuff cuts through so much better.\n\n` +
  `Check out SlopRadar: https://github.com/featureboard/slopradar\n\nKeep building! 🚀`
);
function openMessageAuthor(wrapper) {
  const link = wrapper.querySelector('a[href*="/in/"],.update-components-actor__meta a');
  const m = (link?.getAttribute("href") || "").match(/\/in\/([^/?#]+)/);
  const url = m
    ? `https://www.linkedin.com/messaging/compose/?to=${encodeURIComponent(m[1])}&body=${NUDGE_MSG}`
    : `https://www.linkedin.com/messaging/compose/?body=${NUDGE_MSG}`;
  window.open(url, "_blank");
}

// ── Build dog-ear ─────────────────────────────────────────────────────────
function buildDogEar(isSlop, confidence) {
  const ear = document.createElement("div");
  ear.className = isSlop ? "slop_dog_ear" : "not_slop_dog_ear";
  const ribbon = document.createElement("div");
  ribbon.className = isSlop ? "slop_dog_ear_ribbon" : "not_slop_ribbon";
  const mainSpan = document.createElement("span");
  mainSpan.textContent = isSlop ? "🚫 AI SLOP" : "NOT SLOP! 🫅";
  const subSpan = document.createElement("span");
  subSpan.className = "sr-sub";
  subSpan.textContent = `${confidence}% certainty`;
  ribbon.append(mainSpan, subSpan);
  ear.appendChild(ribbon);
  return ear;
}

// ── Apply SLOP ────────────────────────────────────────────────────────────
function applySlop(wrapper, confidence) {
  if (evaluatedWrappers.has(wrapper)) return;
  if (wrapper.querySelector(".slop_dog_ear")) return;
  wrapper.querySelector(".not_slop_dog_ear")?.remove();
  wrapper.querySelector(".not_slop_tw_wrap")?.remove();

  evaluatedWrappers.add(wrapper);
  postCache.set(wrapper, { isSlop: true, confidence });

  wrapper.classList.add("slop_radar_card", `slop_radar_${PLATFORM}`);
  wrapper.setAttribute("data-slop-detected", "true");
  // Start collapsed (no data-sr-revealed)
  wrapper.removeAttribute("data-sr-revealed");

  if (window.getComputedStyle(wrapper).position === "static") {
    wrapper.style.setProperty("position", "relative", "important");
  }

  if (!IS_TWITTER) {
    killMedia(wrapper);
    wrapper.style.setProperty("overflow", "hidden", "important");
  }

  // Mark blurable children BEFORE injecting our elements
  // Twitter: we can't mutate React tree — instead we inject a sibling overlay div
  if (IS_TWITTER) {
    // Mark existing direct children as blurable via a wrapper div
    // We create a single wrapper div that captures all existing children
    const blurWrap = document.createElement("div");
    blurWrap.className = "sr_blurable";
    blurWrap.style.cssText = "display:contents"; // no layout impact
    // Move all existing children into blurWrap
    while (wrapper.firstChild) blurWrap.appendChild(wrapper.firstChild);
    wrapper.appendChild(blurWrap);
  } else {
    // LinkedIn/universal: mark each existing child
    Array.from(wrapper.children).forEach(ch => {
      if (!ch.classList.contains("slop_dog_ear") && !ch.classList.contains("slop_radar_controls")) {
        ch.classList.add("sr_blurable");
      }
    });
  }

  // Dog-ear
  wrapper.appendChild(buildDogEar(true, confidence));

  // Controls
  const controls = document.createElement("div");
  controls.className = "slop_radar_controls";

  const showBtn = document.createElement("button");
  showBtn.className = "slop_radar_btn";
  showBtn.textContent = "Show anyway";
  showBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const revealed = wrapper.hasAttribute("data-sr-revealed");
    if (revealed) {
      wrapper.removeAttribute("data-sr-revealed");
      showBtn.textContent = "Show anyway";
      if (!IS_TWITTER) wrapper.style.setProperty("overflow", "hidden", "important");
    } else {
      wrapper.setAttribute("data-sr-revealed", "1");
      showBtn.textContent = "Collapse";
      if (!IS_TWITTER) wrapper.style.setProperty("overflow", "visible", "important");
    }
  });
  controls.appendChild(showBtn);

  if (IS_LINKEDIN && settings.showMessageAuthor) {
    const msgBtn = document.createElement("button");
    msgBtn.className = "slop_radar_btn sr-secondary";
    msgBtn.textContent = "✉️ Nudge author";
    msgBtn.addEventListener("click", (e) => { e.stopPropagation(); openMessageAuthor(wrapper); });
    controls.appendChild(msgBtn);
  }

  wrapper.appendChild(controls);
  recordResult(true);
}

// ── Apply NOT SLOP ────────────────────────────────────────────────────────
function applyNotSlop(wrapper, confidence) {
  if (evaluatedWrappers.has(wrapper)) return;
  if (wrapper.getAttribute("data-slop-detected") === "true") return;

  evaluatedWrappers.add(wrapper);
  postCache.set(wrapper, { isSlop: false, confidence });

  wrapper.classList.add("slop_radar_card", `slop_radar_${PLATFORM}`);
  if (window.getComputedStyle(wrapper).position === "static") {
    wrapper.style.setProperty("position", "relative", "important");
  }

  if (IS_TWITTER) {
    if (wrapper.querySelector(".not_slop_tw_wrap")) return;
    const timeEl = wrapper.querySelector("time");
    if (timeEl?.parentElement) {
      const wrap = document.createElement("span");
      wrap.className = "not_slop_tw_wrap";
      const badge = document.createElement("span");
      badge.className = "not_slop_tw_badge";
      badge.textContent = `✓ NOT SLOP! 🫅 ${confidence}%`;
      wrap.appendChild(badge);
      if (settings.showTrashCan) {
        const tb = document.createElement("button");
        tb.className = "not_slop_tw_trash_btn"; tb.textContent = "🗑️";
        tb.title = "Actually slop? Teach SlopRadar";
        const postText = wrapper.textContent?.trim().substring(0, 800) || "";
        tb.addEventListener("click", (e) => { e.stopPropagation(); learnFromPost(postText, tb); });
        wrap.appendChild(tb);
      }
      timeEl.parentElement.insertAdjacentElement("afterend", wrap);
    }
  } else {
    if (wrapper.querySelector(".not_slop_dog_ear")) return;
    const ear = buildDogEar(false, confidence);
    if (settings.showTrashCan) {
      const tb = document.createElement("button");
      tb.className = "not_slop_trash_btn"; tb.textContent = "🗑️";
      tb.title = "Actually slop? Teach SlopRadar";
      const postText = wrapper.textContent?.trim().substring(0, 800) || "";
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
  if (IS_LINKEDIN) return [
    // Modern LinkedIn selectors
    '.update-components-text',
    '.feed-shared-update-v2__description-wrapper',
    '.feed-shared-text-view',
    '.feed-shared-inline-show-more-text',
    '.attributed-text-segment-list__content',
    // Broader fallback — any span with dir=ltr inside a feed card
    '[data-finite-scroll-hotspot] span[dir="ltr"]',
    '.scaffold-finite-scroll__content span[dir="ltr"]',
    '.occludable-update span[dir="ltr"]',
    '.feed-shared-update-v2 span[dir="ltr"]',
  ].join(',');
  // Universal: any paragraph-length text block
  return 'p, [class*="post"] p, [class*="content"] p, article p';
}

// ── Drain loop ────────────────────────────────────────────────────────────
let draining = false;

async function drainOne() {
  if (isPaused || pendingNodes.length === 0) { draining = false; return; }
  draining = true;

  const item = pendingNodes.shift();
  currentQueueSize = pendingNodes.length;
  const { textNode, wrapper } = item;

  if (evaluatedWrappers.has(wrapper) || !document.contains(wrapper)) {
    requestAnimationFrame(drainOne); return;
  }

  // Cache hit — re-apply instantly without inference
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

  console.log(`[SlopRadar] Q:${pendingNodes.length} "${rawText.substring(0,50)}…"`);

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
  if (!draining && !isPaused && pendingNodes.length > 0) {
    draining = true;
    requestAnimationFrame(drainOne);
  }
}

// ── Enqueue ───────────────────────────────────────────────────────────────
function enqueueNode(textNode) {
  if (targetedTextNodes.has(textNode)) return;
  if (isComposerOrInput(textNode)) return;
  const rawText = (textNode.textContent || "").trim();
  if (rawText.length < 40) return;

  const wrapper = getPostWrapper(textNode);
  if (!wrapper || isComposerOrInput(wrapper)) return;
  if (evaluatedWrappers.has(wrapper)) return;

  targetedTextNodes.add(textNode);
  pendingNodes.push({ textNode, wrapper });
}

function queueContainerCheck(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (isComposerOrInput(node)) return;
  if (node.classList?.contains("slop_dog_ear") || node.classList?.contains("not_slop_dog_ear") ||
      node.classList?.contains("slop_radar_controls") || node.classList?.contains("not_slop_tw_wrap") ||
      node.classList?.contains("sr_blurable")) return;

  if (IS_TWITTER) {
    if (node.dataset?.testid === "tweetText") enqueueNode(node);
    else node.querySelectorAll('[data-testid="tweetText"]').forEach(enqueueNode);
  } else {
    const sel = getTextSelectors();
    if (node.matches?.(sel)) enqueueNode(node);
    node.querySelectorAll(sel).forEach(enqueueNode);
  }
}

// ── MutationObserver ──────────────────────────────────────────────────────
const feedObserver = new MutationObserver((mutations) => {
  let added = false;
  for (const m of mutations) {
    for (const n of m.addedNodes) { queueContainerCheck(n); added = true; }
  }
  if (added) { sortPendingByViewport(); scheduleDrain(); }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────
loadSettings(() => {
  applyTheme(IS_TWITTER ? "dark" : (settings.darkMode ? "dark" : "light"));

  document.querySelectorAll(getTextSelectors()).forEach(node => {
    if (!isComposerOrInput(node)) enqueueNode(node);
  });
  sortPendingByViewport();
  scheduleDrain();

  feedObserver.observe(document.body, { childList: true, subtree: true });
});
