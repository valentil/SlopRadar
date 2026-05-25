// content.js

const IS_TWITTER = location.hostname.includes("x.com") || location.hostname.includes("twitter.com");
const IS_LINKEDIN = location.hostname.includes("linkedin.com");

// Fetch our own tabId from background, then signal active
let MY_TAB_ID = -1;
chrome.runtime.sendMessage({ action: "getTabId" }, (res) => {
  if (chrome.runtime.lastError) return;
  MY_TAB_ID = res?.tabId ?? -1;
  chrome.runtime.sendMessage({ action: "contentActive" }).catch(() => {});
});

// ── Shared state ──────────────────────────────────────────────────────────
let processingTimeout = null;
const targetedTextNodes = new Set();
const evaluatedLengths = new WeakMap();

// ── Styles ────────────────────────────────────────────────────────────────
const slopStyle = document.createElement("style");
slopStyle.textContent = `
  .slop_radar_card {
    position: relative !important;
    overflow: visible !important;
  }

  /* ── Shared overlay (used by both platforms) ── */
  .slop_radar_overlay {
    position: absolute !important;
    inset: 0 !important;
    background: #fdfdfd !important;
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 16px !important;
    z-index: 99999 !important;
    pointer-events: auto !important;
    min-height: 120px !important;
  }
  .slop_radar_overlay_text {
    color: #e02424 !important;
    font-size: 7rem !important;
    font-weight: 900 !important;
    letter-spacing: 0.9rem !important;
    transform: rotate(-12deg) !important;
    text-shadow: 5px 5px 0px #ffffff, -5px -5px 0px #ffffff,
                 5px -5px 0px #ffffff, -5px 5px 0px #ffffff,
                 0px 0px 20px rgba(0,0,0,0.15) !important;
    user-select: none !important;
    line-height: 1 !important;
  }
  /* Twitter overlay text smaller to fit tweet width */
  .slop_radar_twitter .slop_radar_overlay_text {
    font-size: 3.5rem !important;
    letter-spacing: 0.5rem !important;
  }
  .slop_radar_show_btn {
    font-size: 0.75rem !important;
    color: #6b7280 !important;
    cursor: pointer !important;
    border: 1px solid #d1d5db !important;
    border-radius: 6px !important;
    padding: 4px 14px !important;
    background: #ffffff !important;
    font-weight: 600 !important;
    letter-spacing: 0.04rem !important;
    pointer-events: auto !important;
    z-index: 100000 !important;
  }
  .slop_radar_show_btn:hover {
    background: #f3f4f6 !important;
  }

  /* ── Hidden content when slop detected ── */
  [data-slop-detected="true"] > :not(.slop_radar_overlay) {
    pointer-events: none !important;
  }
  [data-slop-detected="true"] img,
  [data-slop-detected="true"] video,
  [data-slop-detected="true"] canvas,
  [data-slop-detected="true"] iframe,
  [data-slop-detected="true"] [style*="background-image"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
  }

  /* ══════════════════════════════════════════════════
     LINKEDIN — big corner ribbon for NOT SLOP
  ══════════════════════════════════════════════════ */
  .slop_radar_linkedin .not_slop_ribbon_container {
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
    background: #137333 !important;
    color: #ffffff !important;
    border: 1px solid #0f5b26 !important;
    padding: 10px 0 !important;
    text-align: center !important;
    font-size: 1.1rem !important;
    font-weight: 900 !important;
    transform: rotate(45deg) !important;
    letter-spacing: 0.15rem !important;
    white-space: nowrap !important;
    box-shadow: 0 5px 15px rgba(0,0,0,0.3) !important;
    pointer-events: none !important;
  }

  /* ══════════════════════════════════════════════════
     TWITTER — card-style overlay + pill badge
  ══════════════════════════════════════════════════ */

  /* Twitter NOT SLOP pill next to timestamp */
  .not_slop_tw_badge {
    display: inline-flex !important;
    align-items: center !important;
    gap: 3px !important;
    margin-left: 6px !important;
    padding: 1px 7px !important;
    background: #dcfce7 !important;
    border: 1px solid #86efac !important;
    border-radius: 999px !important;
    font-size: 0.62rem !important;
    font-weight: 800 !important;
    color: #166534 !important;
    letter-spacing: 0.05rem !important;
    vertical-align: middle !important;
    user-select: none !important;
    white-space: nowrap !important;
    pointer-events: none !important;
  }
`;
document.head.appendChild(slopStyle);

// ── Modal / composer guards ───────────────────────────────────────────────
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
  const liModal = IS_LINKEDIN ? `, ${LINKEDIN_MODAL_SELECTORS}` : '';
  const twModal = IS_TWITTER ? `, ${TWITTER_MODAL_SELECTORS}` : '';
  return !!element.closest(shared + liModal + twModal);
}

function isInsideModal(element) {
  if (!element) return false;
  if (IS_LINKEDIN) return !!element.closest(LINKEDIN_MODAL_SELECTORS);
  if (IS_TWITTER)  return !!element.closest(TWITTER_MODAL_SELECTORS);
  return false;
}

// ── LinkedIn: walk up to outermost feed card ──────────────────────────────
function getLinkedInWrapper(textNode) {
  if (isInsideModal(textNode)) return null;
  let current = textNode;
  let outermostCard = null;

  while (current && current.tagName !== "BODY" && current.tagName !== "MAIN") {
    if (current.matches && current.matches(LINKEDIN_MODAL_SELECTORS)) return null;
    if (current.tagName === "ARTICLE") outermostCard = current;
    if (current.className && typeof current.className === "string") {
      const cls = current.className.toLowerCase();
      if (
        cls.includes("feed-shared-update-v2") ||
        cls.includes("occludable-update") ||
        cls.includes("feed-shared-update-v2__container") ||
        cls.includes("update-components-actor")
      ) { outermostCard = current; }
      if (cls.includes("update") || cls.includes("card") || cls.includes("post") || cls.includes("timeline-item")) {
        if (!outermostCard || current.contains(outermostCard)) outermostCard = current;
      }
    }
    if (current.hasAttribute && (current.hasAttribute("data-urn") || current.hasAttribute("data-activity-urn"))) {
      outermostCard = current;
    }
    current = current.parentElement;
  }

  if (outermostCard?.parentElement) {
    const parentCls = (outermostCard.parentElement.className || "").toLowerCase();
    if (parentCls.includes("item-wrapper") || parentCls.includes("feed-item")) {
      outermostCard = outermostCard.parentElement;
    }
  }

  const result = outermostCard || textNode.parentElement;
  if (result && isInsideModal(result)) return null;
  return result;
}

// ── Twitter: the article[data-testid="tweet"] IS the card ─────────────────
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

// ── Confidence → blur opacity ─────────────────────────────────────────────
// confidence 100 = fully blurred (opacity 0.01), 50 = half blur (opacity ~0.5)
function confidenceToBlurOpacity(confidence) {
  // invert: high confidence slop = very hidden
  // opacity range: 0.01 (fully hidden) to 0.55 (barely hidden)
  const t = confidence / 100;
  return Math.max(0.01, 1 - t).toFixed(2);
}

// ── Apply SLOP ────────────────────────────────────────────────────────────
function applySlop(wrapper, confidence, platform) {
  wrapper.querySelector(".not_slop_ribbon_container")?.remove();
  wrapper.querySelector(".not_slop_tw_badge")?.remove();
  if (wrapper.querySelector(".slop_radar_overlay")) return; // already stamped

  wrapper.classList.add("slop_radar_card", `slop_radar_${platform}`);

  // Clean up nested slop marks
  wrapper.querySelectorAll("[data-slop-detected]").forEach(child => {
    child.removeAttribute("data-slop-detected");
    child.querySelector(".slop_radar_overlay")?.remove();
  });
  wrapper.querySelectorAll(".not_slop_ribbon_container, .not_slop_tw_badge").forEach(el => el.remove());

  killMediaElements(wrapper);
  wrapper.setAttribute("data-slop-detected", "true");

  // Blur remaining children proportional to confidence
  const blurOpacity = confidenceToBlurOpacity(confidence);
  const blurStyle = document.createElement("style");
  const uid = `sr_${Math.random().toString(36).slice(2, 8)}`;
  wrapper.dataset.slopId = uid;
  blurStyle.textContent = `
    [data-slop-id="${uid}"][data-slop-detected="true"] > :not(.slop_radar_overlay) {
      opacity: ${blurOpacity} !important;
      filter: blur(${Math.round(confidence * 0.18)}px) grayscale(1) !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(blurStyle);

  // Build overlay
  const overlay = document.createElement("div");
  overlay.className = "slop_radar_overlay";

  const label = document.createElement("div");
  label.className = "slop_radar_overlay_text";
  label.textContent = platform === "twitter"
    ? `AI SLOP ${confidence}%`
    : "AI SLOP";

  // Confidence sub-label for LinkedIn (sits below the big text)
  if (platform === "linkedin") {
    const conf = document.createElement("div");
    conf.style.cssText = `
      color: #e02424 !important;
      font-size: 1rem !important;
      font-weight: 800 !important;
      letter-spacing: 0.2rem !important;
      opacity: 0.7 !important;
      margin-top: -8px !important;
      user-select: none !important;
    `;
    conf.textContent = `${confidence}% certainty`;
    overlay.append(label, conf);
  } else {
    overlay.append(label);
  }

  // "Show anyway" button
  const showBtn = document.createElement("button");
  showBtn.className = "slop_radar_show_btn";
  showBtn.textContent = "Show anyway";
  showBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    wrapper.removeAttribute("data-slop-detected");
    blurStyle.remove();
    overlay.remove();
  });
  overlay.appendChild(showBtn);

  wrapper.appendChild(overlay);
}

// ── Apply NOT SLOP ────────────────────────────────────────────────────────
function applyNotSlop(wrapper, confidence, platform) {
  if (wrapper.getAttribute("data-slop-detected") === "true") return;
  if (wrapper.querySelector(".slop_radar_overlay")) return;

  wrapper.classList.add("slop_radar_card", `slop_radar_${platform}`);

  if (platform === "twitter") {
    if (wrapper.querySelector(".not_slop_tw_badge")) return;
    const timeEl = wrapper.querySelector("time");
    if (timeEl?.parentElement) {
      const badge = document.createElement("span");
      badge.className = "not_slop_tw_badge";
      badge.textContent = `✓ NOT SLOP! 🫅 ${confidence}%`;
      timeEl.parentElement.insertAdjacentElement("afterend", badge);
    }
  } else {
    // LinkedIn big corner ribbon
    if (wrapper.querySelector(".not_slop_ribbon_container")) return;
    const container = document.createElement("div");
    container.className = "not_slop_ribbon_container";
    const ribbon = document.createElement("div");
    ribbon.className = "not_slop_ribbon";
    ribbon.textContent = `NOT SLOP! 🫅 ${confidence}%`;
    container.appendChild(ribbon);
    wrapper.appendChild(container);
  }
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

    chrome.runtime.sendMessage(
      { action: "evaluatePost", text: rawText.substring(0, 1500), tabId: MY_TAB_ID },
      (response) => {
        if (chrome.runtime.lastError) return;
        const wrapper = getPostWrapper(textNode);
        if (!wrapper || isComposerOrInput(wrapper)) return;

        const confidence = response?.confidence ?? 50;
        const platform = IS_TWITTER ? "twitter" : "linkedin";

        if (response?.isSlop) {
          applySlop(wrapper, confidence, platform);
        } else if (response && !response.isSlop) {
          applyNotSlop(wrapper, confidence, platform);
        }
      }
    );
  });
}

// ── Node queuing ──────────────────────────────────────────────────────────
function getTextSelectors() {
  return IS_TWITTER
    ? '[data-testid="tweetText"]'
    : "[data-testid*='text'], [data-testid*='box']";
}

function queueContainerCheck(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (isComposerOrInput(node)) return;

  const sel = getTextSelectors();
  const testId = node.dataset?.testid || "";

  if (IS_TWITTER) {
    if (testId === "tweetText") targetedTextNodes.add(node);
    else node.querySelectorAll(sel).forEach(el => { if (!isComposerOrInput(el)) targetedTextNodes.add(el); });
  } else {
    if (testId.includes("text") || testId.includes("box")) targetedTextNodes.add(node);
    else node.querySelectorAll(sel).forEach(el => { if (!isComposerOrInput(el)) targetedTextNodes.add(el); });
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
document.querySelectorAll(getTextSelectors()).forEach(node => {
  if (!isComposerOrInput(node)) targetedTextNodes.add(node);
});
if (targetedTextNodes.size > 0) processTrackedContainers();
observer.observe(document.body, { childList: true, subtree: true });
