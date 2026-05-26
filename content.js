// content.js

const IS_TWITTER = location.hostname.includes("x.com") || location.hostname.includes("twitter.com");
const IS_LINKEDIN = location.hostname.includes("linkedin.com");
const PAGE_HOSTNAME = location.hostname;
const PLATFORM = IS_TWITTER ? "twitter" : "linkedin";

// ── Settings (loaded async, safe defaults until loaded) ───────────────────
let settings = {
  darkMode: false,
  showTrashCan: true,
  showMessageAuthor: true,
  minConfidence: 60,
};

function loadSettings(cb) {
  chrome.runtime.sendMessage({ action: "getSettings" }, (s) => {
    if (!chrome.runtime.lastError && s) settings = s;
    if (cb) cb();
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "settingsUpdated") {
    settings = request.settings;
    if (IS_TWITTER) applyTheme("dark");
    else applyTheme(settings.darkMode ? "dark" : "light");
  }
  if (request.action === "queueSize") {
    currentQueueSize = request.size;
  }
  if (request.action === "getPageStats") {
    sendResponse({ pageStats, queueSize: currentQueueSize });
    return true;
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

// ── Page stats ────────────────────────────────────────────────────────────
const pageStats = { checked: 0, slop: 0 };

function recordResult(isSlop) {
  pageStats.checked++;
  if (isSlop) pageStats.slop++;
  chrome.runtime.sendMessage({ action: "recordResult", hostname: PAGE_HOSTNAME, isSlop }).catch(() => {});
}

// ── Shared queue state ────────────────────────────────────────────────────
let processingTimeout = null;
const targetedTextNodes = new Set();
const evaluatedLengths = new WeakMap();
let currentQueueSize = 0;

// ── Theme ─────────────────────────────────────────────────────────────────
// Twitter is always dark; LinkedIn follows settings.darkMode
function applyTheme(mode) {
  document.documentElement.setAttribute("data-sr-theme", mode);
}

// ── Styles ────────────────────────────────────────────────────────────────
const slopStyle = document.createElement("style");
slopStyle.textContent = `
  /* ── CSS vars: light (LinkedIn default) ── */
  :root, [data-sr-theme="light"] {
    --sr-bg: #ffffff;
    --sr-bg2: #f3f4f6;
    --sr-border: #e5e7eb;
    --sr-text: #111827;
    --sr-text2: #6b7280;
    --sr-red: #e02424;
    --sr-red-dim: rgba(224,36,36,0.06);
    --sr-red-border: rgba(224,36,36,0.25);
    --sr-green: #137333;
    --sr-green-bg: #f0fdf4;
    --sr-green-border: #86efac;
    --sr-shadow: 0 1px 3px rgba(0,0,0,0.08);
    --sr-btn-bg: #ffffff;
    --sr-btn-hover: #f9fafb;
    --sr-overlay-bg: rgba(255,255,255,0.97);
    --sr-hud-bg: rgba(15,15,15,0.92);
    --sr-hud-text: #e5e7eb;
    --sr-hud-text2: #6b7280;
  }

  /* ── CSS vars: dark (Twitter default, optional LinkedIn dark) ── */
  [data-sr-theme="dark"] {
    --sr-bg: #16202a;
    --sr-bg2: #1e2732;
    --sr-border: #2f3336;
    --sr-text: #e7e9ea;
    --sr-text2: #71767b;
    --sr-red: #f4212e;
    --sr-red-dim: rgba(244,33,46,0.12);
    --sr-red-border: rgba(244,33,46,0.35);
    --sr-green: #00ba7c;
    --sr-green-bg: rgba(0,186,124,0.1);
    --sr-green-border: rgba(0,186,124,0.35);
    --sr-shadow: 0 1px 4px rgba(0,0,0,0.35);
    --sr-btn-bg: #1e2732;
    --sr-btn-hover: #2f3336;
    --sr-overlay-bg: rgba(22,32,42,0.97);
    --sr-hud-bg: rgba(22,32,42,0.95);
    --sr-hud-text: #e7e9ea;
    --sr-hud-text2: #71767b;
  }

  /* ── Card base ── */
  .slop_radar_card {
    position: relative !important;
    overflow: visible !important;
  }

  /* ── Slop dog-ear container — mirrors NOT SLOP but red ── */
  .slop_dog_ear {
    position: absolute !important;
    top: -100px !important;
    right: 0 !important;
    width: 260px !important;
    height: 260px !important;
    overflow: hidden !important;
    pointer-events: none !important;
    z-index: 99999 !important;
  }
  .slop_dog_ear_ribbon {
    position: absolute !important;
    top: 50px !important;
    right: -65px !important;
    width: 360px !important;
    background: var(--sr-red) !important;
    color: #ffffff !important;
    padding: 10px 0 !important;
    text-align: center !important;
    font-size: 0.95rem !important;
    font-weight: 900 !important;
    transform: rotate(45deg) !important;
    letter-spacing: 0.14rem !important;
    white-space: nowrap !important;
    box-shadow: 0 4px 14px rgba(0,0,0,0.28) !important;
    pointer-events: none !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    gap: 0 !important;
    user-select: none !important;
  }

  /* ── Controls bar — sits on card face below the dog-ear area ── */
  .slop_radar_controls {
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    height: 56px !important;
    display: flex !important;
    align-items: center !important;
    gap: 10px !important;
    padding: 0 16px !important;
    z-index: 99998 !important;
    pointer-events: auto !important;
    box-sizing: border-box !important;
  }
  .slop_radar_conf_tag {
    font-size: 0.65rem !important;
    font-weight: 600 !important;
    color: var(--sr-text2) !important;
    flex-shrink: 0 !important;
    user-select: none !important;
    white-space: nowrap !important;
  }
  .slop_radar_actions {
    display: flex !important;
    align-items: center !important;
    gap: 6px !important;
    margin-left: auto !important;
    flex-shrink: 0 !important;
  }
  .slop_radar_btn {
    font-size: 0.65rem !important;
    font-weight: 700 !important;
    color: var(--sr-text2) !important;
    cursor: pointer !important;
    border: 1px solid var(--sr-border) !important;
    border-radius: 5px !important;
    padding: 3px 9px !important;
    background: var(--sr-btn-bg) !important;
    letter-spacing: 0.03rem !important;
    pointer-events: auto !important;
    z-index: 100000 !important;
    white-space: nowrap !important;
    transition: background 0.12s !important;
    line-height: 1.6 !important;
  }
  .slop_radar_btn:hover { background: var(--sr-btn-hover) !important; }
  .slop_radar_btn.icon-only {
    padding: 3px 7px !important;
    font-size: 0.8rem !important;
  }
  .slop_radar_btn.msg-btn {
    border-color: var(--sr-red-border) !important;
    color: var(--sr-red) !important;
  }
  .slop_radar_btn.msg-btn:hover { background: var(--sr-red-dim) !important; }

  /* ── Collapsed: hide everything below the controls bar ── */
  [data-slop-detected="true"] {
    max-height: 56px !important;
    overflow: hidden !important;
    transition: max-height 0.22s cubic-bezier(0.4,0,0.2,1) !important;
  }
  [data-slop-detected="true"].slop_expanded {
    max-height: 3000px !important;
    overflow: visible !important;
  }

  /* ── Media hidden while collapsed ── */
  [data-slop-detected="true"]:not(.slop_expanded) img,
  [data-slop-detected="true"]:not(.slop_expanded) video,
  [data-slop-detected="true"]:not(.slop_expanded) canvas,
  [data-slop-detected="true"]:not(.slop_expanded) iframe,
  [data-slop-detected="true"]:not(.slop_expanded) [style*="background-image"] {
    display: none !important;
  }
  /* Content blurred when expanded (scoped per-card via data-slop-id) */

  /* ══════════════════════════════════════════════════
     LINKEDIN — big corner ribbon for NOT SLOP
  ══════════════════════════════════════════════════ */
  .slop_radar_linkedin .not_slop_dog_ear {
    position: absolute !important;
    top: -100px !important;
    right: 0 !important;
    width: 260px !important;
    height: 260px !important;
    overflow: hidden !important;
    pointer-events: none !important;
    z-index: 99999 !important;
  }
  .slop_radar_linkedin .not_slop_ribbon {
    position: absolute !important;
    top: 50px !important;
    right: -65px !important;
    width: 360px !important;
    background: var(--sr-green) !important;
    color: #ffffff !important;
    padding: 10px 0 !important;
    text-align: center !important;
    font-size: 0.95rem !important;
    font-weight: 900 !important;
    transform: rotate(45deg) !important;
    letter-spacing: 0.12rem !important;
    white-space: nowrap !important;
    box-shadow: 0 4px 14px rgba(0,0,0,0.28) !important;
    pointer-events: none !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    gap: 0 !important;
    cursor: default !important;
  }
  /* Trash can sits in the dog ear, pointer-events enabled */
  .slop_radar_linkedin .not_slop_dog_ear {
    pointer-events: none !important;
  }
  .slop_radar_linkedin .not_slop_trash_btn {
    position: absolute !important;
    top: 138px !important;
    right: 14px !important;
    pointer-events: auto !important;
    background: var(--sr-bg) !important;
    border: 1px solid var(--sr-border) !important;
    border-radius: 50% !important;
    width: 26px !important;
    height: 26px !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    font-size: 0.8rem !important;
    cursor: pointer !important;
    box-shadow: var(--sr-shadow) !important;
    transition: background 0.12s !important;
    z-index: 100000 !important;
  }
  .slop_radar_linkedin .not_slop_trash_btn:hover {
    background: var(--sr-red-dim) !important;
    border-color: var(--sr-red-border) !important;
  }

  /* ══════════════════════════════════════════════════
     TWITTER — card-style NOT SLOP pill
  ══════════════════════════════════════════════════ */
  .not_slop_tw_wrap {
    display: inline-flex !important;
    align-items: center !important;
    gap: 4px !important;
    margin-left: 6px !important;
    vertical-align: middle !important;
  }
  .not_slop_tw_badge {
    display: inline-flex !important;
    align-items: center !important;
    gap: 3px !important;
    padding: 1px 7px !important;
    background: var(--sr-green-bg) !important;
    border: 1px solid var(--sr-green-border) !important;
    border-radius: 999px !important;
    font-size: 0.62rem !important;
    font-weight: 800 !important;
    color: var(--sr-green) !important;
    letter-spacing: 0.05rem !important;
    user-select: none !important;
    white-space: nowrap !important;
    pointer-events: none !important;
  }
  .not_slop_tw_trash_btn {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    width: 18px !important;
    height: 18px !important;
    border-radius: 50% !important;
    border: 1px solid var(--sr-border) !important;
    background: var(--sr-btn-bg) !important;
    font-size: 0.65rem !important;
    cursor: pointer !important;
    pointer-events: auto !important;
    transition: background 0.12s !important;
    line-height: 1 !important;
  }
  .not_slop_tw_trash_btn:hover {
    background: var(--sr-red-dim) !important;
    border-color: var(--sr-red-border) !important;
  }

`;
document.head.appendChild(slopStyle);


// ── Modal guards ──────────────────────────────────────────────────────────
const LINKEDIN_MODAL_SELECTORS = [
  '[role="dialog"]', '[data-test-modal]', '[data-test-modal-container]',
  '.artdeco-modal', '.artdeco-modal-overlay', '.share-box',
  '.share-box-v2__modal', '.share-creation-state', '.artdeco-modal__content',
  '.media-editor__container', '.share-box-footer',
].join(',');

const TWITTER_MODAL_SELECTORS = [
  '[data-testid="tweetTextarea_0"]',
  '[aria-label="Tweet text"]',
  '[role="dialog"]',
  '.DraftEditor-root',
].join(',');

function isComposerOrInput(element) {
  if (!element) return false;
  const shared = 'input, textarea, [contenteditable="true"], [role="textbox"]';
  const extra = IS_LINKEDIN ? `, ${LINKEDIN_MODAL_SELECTORS}` : IS_TWITTER ? `, ${TWITTER_MODAL_SELECTORS}` : '';
  return !!element.closest(shared + extra);
}

function isInsideModal(element) {
  if (!element) return false;
  if (IS_LINKEDIN) return !!element.closest(LINKEDIN_MODAL_SELECTORS);
  if (IS_TWITTER)  return !!element.closest(TWITTER_MODAL_SELECTORS);
  return false;
}

// ── Wrapper finders ───────────────────────────────────────────────────────
// LinkedIn card detection — ordered from most-specific to most-general.
// Strategy: try closest() with known card selectors first (fast, exact),
// then walk upward collecting every candidate and return the outermost
// one that is still a plausible feed card (not body/main/aside).

const LI_CARD_SELECTORS = [
  // Most specific — actual feed update containers
  '[data-id]',                                   // promoted/sponsored posts
  '[data-urn]',                                  // activity URN on post wrapper
  '[data-activity-urn]',
  '.feed-shared-update-v2',
  '.occludable-update',
  // Notification / suggested / entity cards
  '.nt-card',
  '.scaffold-finite-scroll__content > li',       // top-level feed <li>
  '.feed-shared-update-v2__container',
  // Generic fallbacks
  'article',
].join(', ');

// Classes that indicate we are INSIDE a card's content, not at card level —
// don't stop here, keep climbing.
const LI_INNER_CLASSES = [
  'feed-shared-update-v2__description',
  'feed-shared-text',
  'update-components-text',
  'feed-shared-inline-show-more-text',
  'attributed-text-segment-list',
  'feed-shared-update-v2__content',
  'update-components-update-v2',
];

function getLinkedInWrapper(textNode) {
  if (isInsideModal(textNode)) return null;

  // ── Step 1: closest() fast path ──────────────────────────────────────
  // Try each selector from specific to general; take the OUTERMOST match.
  let best = null;
  let el = textNode.parentElement;
  while (el && el.tagName !== 'BODY' && el.tagName !== 'MAIN' && el.tagName !== 'ASIDE') {
    if (el.matches && el.matches(LINKEDIN_MODAL_SELECTORS)) return null;

    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const hasUrn = el.hasAttribute('data-urn') || el.hasAttribute('data-activity-urn') || el.hasAttribute('data-id');

    // Definitive card signals — these are always the right wrapper
    const isDefinitiveCard = (
      hasUrn ||
      cls.includes('feed-shared-update-v2') && !cls.includes('__') ||  // root, not modifier
      cls.includes('occludable-update') ||
      cls.includes('nt-card') ||
      el.tagName === 'LI' && el.closest('.scaffold-finite-scroll__content, .feed-container, [data-finite-scroll-hotspot]')
    );

    if (isDefinitiveCard) {
      best = el;  // keep climbing — want outermost definitive card
    } else if (!best) {
      // Weaker signal — only accept if we haven't found a definitive card yet
      const isWeakCard = (
        el.tagName === 'ARTICLE' ||
        cls.includes('card') && !cls.includes('card__') ||
        cls.includes('update') && !LI_INNER_CLASSES.some(c => cls.includes(c)) ||
        cls.includes('timeline-item') ||
        cls.includes('feed-item')
      );
      if (isWeakCard) best = el;
    }

    el = el.parentElement;
  }

  if (!best) return null;

  // ── Step 2: bubble up one more level through transparent wrappers ─────
  // e.g. <div class="occludable-update"> is often inside <li> or a
  // data-finite-scroll item — grab that if it adds nothing of its own.
  const parent = best.parentElement;
  if (parent && parent.tagName !== 'BODY' && parent.tagName !== 'MAIN') {
    const pcls = (typeof parent.className === 'string' ? parent.className : '').toLowerCase();
    if (
      parent.tagName === 'LI' ||
      pcls.includes('item-wrapper') ||
      pcls.includes('feed-item') ||
      pcls.includes('scaffold-finite-scroll')
    ) {
      best = parent;
    }
  }

  if (isInsideModal(best)) return null;
  return best;
}

function getTwitterWrapper(textNode) {
  if (isInsideModal(textNode)) return null;
  const article = textNode.closest('article[data-testid="tweet"]');
  if (!article || isInsideModal(article)) return null;
  return article;
}

function getPostWrapper(textNode) {
  return IS_TWITTER ? getTwitterWrapper(textNode) : getLinkedInWrapper(textNode);
}

// ── Media kill ────────────────────────────────────────────────────────────
function killMediaElements(container) {
  container.querySelectorAll("video, iframe, audio, source").forEach(media => {
    try { media.pause(); } catch (e) {}
    media.src = "";
    media.removeAttribute("src");
    if (typeof media.load === "function") media.load();
    media.remove();
  });
}

// ── Learn action (trash can) ──────────────────────────────────────────────
function learnFromPost(postText, btn) {
  btn.textContent = "⏳";
  btn.disabled = true;
  chrome.runtime.sendMessage({ action: "learnFromSlop", postText }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      btn.textContent = "🗑️";
      btn.disabled = false;
      return;
    }
    const count = res.newPatterns?.length ?? 0;
    btn.textContent = count > 0 ? `✓ +${count}` : "✓";
    btn.title = count > 0
      ? `Learned ${count} new pattern${count > 1 ? "s" : ""}`
      : "No new patterns found (already covered)";
  });
}

// ── Message author (LinkedIn only) ───────────────────────────────────────
function getLinkedInMessageUrl(wrapper) {
  // Try to find the profile link of the post author
  const authorLink = wrapper.querySelector(
    'a[href*="/in/"], a[href*="/company/"], .update-components-actor__meta a'
  );
  if (!authorLink) return null;
  const href = authorLink.getAttribute("href") || "";
  const match = href.match(/\/in\/([^/?#]+)/);
  if (!match) return null;
  const profileSlug = match[1];
  return `https://www.linkedin.com/messaging/compose/?to=${encodeURIComponent(profileSlug)}`;
}

const NUDGE_MESSAGE = encodeURIComponent(
  `Hey! I noticed your post was caught by SlopRadar — a browser extension that filters AI-generated filler content from feeds.\n\n` +
  `No hard feelings at all — just wanted to share: your audience LOVES hearing the real stuff. What are you actually building? ` +
  `What did you ship this week? A raw screenshot, a quick lesson learned, a specific number — that stuff cuts through so much better.\n\n` +
  `Check out SlopRadar if you're curious: https://github.com/featureboard/slopradar\n\n` +
  `Keep building! 🚀`
);

function openMessageAuthor(wrapper) {
  const url = getLinkedInMessageUrl(wrapper);
  if (url) {
    window.open(`${url}&body=${NUDGE_MESSAGE}`, "_blank");
  } else {
    // Fallback: open generic compose
    window.open(`https://www.linkedin.com/messaging/compose/?body=${NUDGE_MESSAGE}`, "_blank");
  }
}

// ── Apply SLOP ────────────────────────────────────────────────────────────
function applySlop(wrapper, confidence) {
  wrapper.querySelector(".not_slop_dog_ear")?.remove();
  wrapper.querySelector(".not_slop_tw_wrap")?.remove();
  if (wrapper.querySelector(".slop_dog_ear")) return; // already stamped

  wrapper.classList.add("slop_radar_card", `slop_radar_${PLATFORM}`);
  wrapper.querySelectorAll("[data-slop-detected]").forEach(child => {
    child.removeAttribute("data-slop-detected");
    child.querySelector(".slop_dog_ear")?.remove();
    child.querySelector(".slop_radar_controls")?.remove();
  });

  killMediaElements(wrapper);
  wrapper.setAttribute("data-slop-detected", "true");

  // Force positioning context so absolute children land correctly
  const pos = window.getComputedStyle(wrapper).position;
  if (pos === "static") wrapper.style.setProperty("position", "relative", "important");
  // Override any explicit height LinkedIn sets so max-height collapse works
  wrapper.style.setProperty("overflow", "hidden", "important");

  // Scoped blur when expanded — confidence-driven
  const uid = `sr_${Math.random().toString(36).slice(2, 8)}`;
  wrapper.dataset.slopId = uid;
  const blurStyle = document.createElement("style");
  blurStyle.dataset.slopBlurFor = uid;
  const opacity = Math.max(0.03, 1 - confidence / 100).toFixed(2);
  const blurPx = Math.round(confidence * 0.14);
  blurStyle.textContent = `
    [data-slop-id="${uid}"].slop_expanded > :not(.slop_dog_ear):not(.slop_radar_controls) {
      opacity: ${opacity} !important;
      filter: blur(${blurPx}px) grayscale(0.4) !important;
    }
  `;
  document.head.appendChild(blurStyle);

  const postText = wrapper.textContent?.trim().substring(0, 800) || "";

  // ── Dog-ear ribbon (red, mirrors NOT SLOP) ────────────────────────────
  const dogEar = document.createElement("div");
  dogEar.className = "slop_dog_ear";

  const ribbon = document.createElement("div");
  ribbon.className = "slop_dog_ear_ribbon";
  ribbon.innerHTML = `<span>🚫 AI SLOP</span><span style="font-size:0.7rem;opacity:0.85;font-weight:700;letter-spacing:0.05rem">${confidence}% certainty</span>`;
  dogEar.appendChild(ribbon);

  // ── Controls bar — sits at top of card face ───────────────────────────
  const controls = document.createElement("div");
  controls.className = "slop_radar_controls";

  const conf = document.createElement("span");
  conf.className = "slop_radar_conf_tag";
  // spacer so buttons go right

  const actions = document.createElement("div");
  actions.className = "slop_radar_actions";

  const showBtn = document.createElement("button");
  showBtn.className = "slop_radar_btn";
  showBtn.textContent = "Show anyway";
  showBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const expanded = wrapper.classList.toggle("slop_expanded");
    showBtn.textContent = expanded ? "Collapse" : "Show anyway";
    // Allow card to grow when expanded
    wrapper.style.setProperty("overflow", expanded ? "visible" : "hidden", "important");
  });
  actions.appendChild(showBtn);

  if (IS_LINKEDIN && settings.showMessageAuthor) {
    const msgBtn = document.createElement("button");
    msgBtn.className = "slop_radar_btn msg-btn icon-only";
    msgBtn.textContent = "✉️";
    msgBtn.title = "Message author a friendly nudge";
    msgBtn.addEventListener("click", (e) => { e.stopPropagation(); openMessageAuthor(wrapper); });
    actions.appendChild(msgBtn);
  }

  controls.append(conf, actions);
  wrapper.appendChild(dogEar);
  wrapper.appendChild(controls);

  recordResult(true);
}

// ── Apply NOT SLOP ────────────────────────────────────────────────────────
function applyNotSlop(wrapper, confidence) {
  if (wrapper.getAttribute("data-slop-detected") === "true") return;
  if (wrapper.querySelector(".slop_radar_overlay")) return;

  wrapper.classList.add("slop_radar_card", `slop_radar_${PLATFORM}`);

  const postText = wrapper.textContent?.trim().substring(0, 800) || "";

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
        const trashBtn = document.createElement("button");
        trashBtn.className = "not_slop_tw_trash_btn";
        trashBtn.textContent = "🗑️";
        trashBtn.title = "Actually slop? Teach SlopRadar";
        trashBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          learnFromPost(postText, trashBtn);
        });
        wrap.appendChild(trashBtn);
      }

      timeEl.parentElement.insertAdjacentElement("afterend", wrap);
    }
  } else {
    // LinkedIn — big dog ear ribbon
    if (wrapper.querySelector(".not_slop_dog_ear")) return;

    // Ensure positioning context
    const pos = window.getComputedStyle(wrapper).position;
    if (pos === "static") wrapper.style.setProperty("position", "relative", "important");

    const dogEar = document.createElement("div");
    dogEar.className = "not_slop_dog_ear";

    const ribbon = document.createElement("div");
    ribbon.className = "not_slop_ribbon";
    ribbon.innerHTML = `<span>NOT SLOP! 🫅</span><span style="font-size:0.7rem;opacity:0.82;font-weight:700;letter-spacing:0.06rem">${confidence}%</span>`;

    dogEar.appendChild(ribbon);

    if (settings.showTrashCan) {
      const trashBtn = document.createElement("button");
      trashBtn.className = "not_slop_trash_btn";
      trashBtn.textContent = "🗑️";
      trashBtn.title = "Actually slop? Teach SlopRadar";
      trashBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        learnFromPost(postText, trashBtn);
      });
      dogEar.appendChild(trashBtn);
    }

    wrapper.appendChild(dogEar);
  }

  recordResult(false);
}

// ── Core evaluation loop ──────────────────────────────────────────────────
function processTrackedContainers() {
  if (targetedTextNodes.size === 0) return;

  targetedTextNodes.forEach((textNode) => {
    targetedTextNodes.delete(textNode);
    if (isComposerOrInput(textNode)) return;

    const rawText = (textNode.textContent || "").trim();
    if (rawText.length < 40) return;
    if (evaluatedLengths.get(textNode) === rawText.length) return;
    evaluatedLengths.set(textNode, rawText.length);

    // Resolve wrapper NOW while DOM is fresh, not after async delay
    const wrapper = getPostWrapper(textNode);
    if (!wrapper || isComposerOrInput(wrapper)) {
      console.log("[SlopRadar] No wrapper found for text:", rawText.substring(0, 60));
      return;
    }
    // Skip if already stamped
    if (wrapper.querySelector(".slop_dog_ear") || wrapper.querySelector(".not_slop_dog_ear")) return;

    console.log("[SlopRadar] Evaluating:", rawText.substring(0, 60), "| wrapper:", wrapper.tagName, wrapper.className?.substring?.(0,60));

    chrome.runtime.sendMessage(
      { action: "evaluatePost", text: rawText.substring(0, 1500), tabId: MY_TAB_ID },
      (response) => {
        if (chrome.runtime.lastError) {
          console.log("[SlopRadar] Message error:", chrome.runtime.lastError.message);
          return;
        }
        const confidence = response?.confidence ?? 50;
        console.log("[SlopRadar] Result: isSlop=", response?.isSlop, "conf=", confidence);
        if (response?.isSlop) applySlop(wrapper, confidence);
        else if (response) applyNotSlop(wrapper, confidence);
      }
    );
  });
}

// ── Node queuing ──────────────────────────────────────────────────────────
function getTextSelectors() {
  if (IS_TWITTER) return '[data-testid="tweetText"]';
  // LinkedIn: post body text lives in these containers
  return [
    '.feed-shared-update-v2__description-wrapper',
    '.feed-shared-text-view',
    '.feed-shared-inline-show-more-text',
    '.update-components-text',
    '.attributed-text-segment-list__content',
    // Fallback: any span with substantial dir=ltr inside a feed card
    '.feed-shared-update-v2 span[dir="ltr"]',
    '.occludable-update span[dir="ltr"]',
  ].join(', ');
}

function nodeMatchesTextSelector(node) {
  if (!node.matches) return false;
  const sel = getTextSelectors();
  return node.matches(sel);
}

function queueContainerCheck(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (isComposerOrInput(node)) return;

  // Skip our own injected elements
  if (node.classList?.contains("slop_dog_ear") ||
      node.classList?.contains("slop_radar_controls") ||
      node.classList?.contains("not_slop_dog_ear")) return;

  if (IS_TWITTER) {
    const testId = node.dataset?.testid || "";
    if (testId === "tweetText") {
      if (!isComposerOrInput(node)) targetedTextNodes.add(node);
    } else {
      node.querySelectorAll('[data-testid="tweetText"]').forEach(el => {
        if (!isComposerOrInput(el)) targetedTextNodes.add(el);
      });
    }
  } else {
    // LinkedIn: check if this node itself is a text container
    if (nodeMatchesTextSelector(node)) {
      if (!isComposerOrInput(node)) targetedTextNodes.add(node);
    }
    // Also scan inside for text containers
    node.querySelectorAll(getTextSelectors()).forEach(el => {
      if (!isComposerOrInput(el)) targetedTextNodes.add(el);
    });
  }
}

// ── MutationObserver ──────────────────────────────────────────────────────
const observer = new MutationObserver((mutations) => {
  let hasInjections = false;
  for (const mutation of mutations) {
    for (const added of mutation.addedNodes) {
      queueContainerCheck(added);
      hasInjections = true;
    }
  }
  if (hasInjections) {
    clearTimeout(processingTimeout);
    processingTimeout = setTimeout(processTrackedContainers, 200);
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────
loadSettings(() => {
  // Apply theme immediately
  applyTheme(IS_TWITTER ? "dark" : (settings.darkMode ? "dark" : "light"));

  // Seed queue with existing nodes
  document.querySelectorAll(getTextSelectors()).forEach(node => {
    if (!isComposerOrInput(node)) targetedTextNodes.add(node);
  });
  if (targetedTextNodes.size > 0) processTrackedContainers();

  // Watch for new content
  observer.observe(document.body, { childList: true, subtree: true });
});
