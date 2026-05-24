// content.js
let processingTimeout = null;
const targetedTextNodes = new Set();
const evaluatedLengths = new WeakMap();

const slopStyle = document.createElement("style");
slopStyle.textContent = `
  .slop_radar_card {
    position: relative !important;
  }
  [data-slop-detected="true"] > :not(.slop_radar_overlay) {
    opacity: 0.01 !important;
    filter: blur(15px) grayscale(1) !important;
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
  .slop_radar_overlay {
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    width: 100% !important;
    height: 100% !important;
    min-height: 350px !important;
    background: #fdfdfd !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    z-index: 99999 !important;
    pointer-events: auto !important;
  }
  .slop_radar_overlay_text {
    color: #e02424 !important;
    font-size: 7rem !important;
    font-weight: 900 !important;
    letter-spacing: 0.9rem !important;
    transform: rotate(-12deg) !important;
    text-shadow: 5px 5px 0px #ffffff, -5px -5px 0px #ffffff, 5px -5px 0px #ffffff, -5px 5px 0px #ffffff, 0px 0px 20px rgba(0,0,0,0.15) !important;
    user-select: none !important;
  }
  .not_slop_ribbon_container {
    position: absolute !important;
    top: -100px !important;
    right: 0 !important;
    width: 260px !important;
    height: 260px !important;
    overflow: hidden !important;
    pointer-events: none !important;
    z-index: 99999 !important;
  }
  .not_slop_ribbon {
    position: absolute !important;
    top: 50px !important;
    right: -65px !important;
    width: 360px !important;
    background: #137333 !important;
    color: #ffffff !important;
    border: 1px solid #0f5b26 !important;
    padding: 10px 0 !important;
    text-align: center !important;
    font-size: 1.25rem !important;
    font-weight: 900 !important;
    transform: rotate(45deg) !important;
    letter-spacing: 0.18rem !important;
    white-space: nowrap !important;
    box-shadow: 0 5px 15px rgba(0,0,0,0.3) !important;
    pointer-events: none !important;
  }
`;
document.head.appendChild(slopStyle);

function logToBackground(text) {
  chrome.runtime.sendMessage({ action: "log", text }).catch(() => {});
}

function getPostWrapper(textNode) {
  let current = textNode;
  let outermostCard = null;

  while (current && current.tagName !== "BODY" && current.tagName !== "MAIN") {
    if (current.tagName === "ARTICLE" || (current.getAttribute && current.getAttribute("data-testid") === "tweet")) {
      outermostCard = current;
    }
    if (current.className && typeof current.className === "string") {
      const cls = current.className.toLowerCase();
      if (
        cls.includes("feed-shared-update-v2") || 
        cls.includes("occludable-update") || 
        cls.includes("feed-shared-update-v2__container") ||
        cls.includes("update-components-actor")
      ) {
        outermostCard = current;
      }
      if (cls.includes("update") || cls.includes("card") || cls.includes("post") || cls.includes("timeline-item")) {
        if (!outermostCard || current.contains(outermostCard)) {
          outermostCard = current;
        }
      }
    }
    if (current.hasAttribute && (current.hasAttribute("data-urn") || current.hasAttribute("data-activity-urn"))) {
      outermostCard = current;
    }
    current = current.parentElement;
  }
  
  if (outermostCard && outermostCard.parentElement && typeof outermostCard.parentElement.className === "string") {
    const parentCls = outermostCard.parentElement.className.toLowerCase();
    if (parentCls.includes("item-wrapper") || parentCls.includes("feed-item")) {
      outermostCard = outermostCard.parentElement;
    }
  }

  return outermostCard || textNode.parentElement;
}

function killMediaElements(container) {
  container.querySelectorAll("video, iframe, audio, source").forEach(media => {
    try {
      media.pause();
    } catch (e) {}
    media.src = "";
    media.removeAttribute("src");
    if (typeof media.load === "function") {
      media.load();
    }
    media.remove();
  });
}

function processTrackedContainers() {
  if (targetedTextNodes.size === 0) return;

  targetedTextNodes.forEach((textNode) => {
    targetedTextNodes.delete(textNode);

    const rawText = (textNode.textContent || "").trim();
    if (rawText.length < 40) return;

    if (evaluatedLengths.get(textNode) === rawText.length) return;
    evaluatedLengths.set(textNode, rawText.length);

    const payloadText = rawText.substring(0, 1500);

    chrome.runtime.sendMessage(
      { action: "evaluatePost", text: payloadText },
      (response) => {
        if (chrome.runtime.lastError) return;

        const wrapper = getPostWrapper(textNode);
        if (!wrapper) return;

        wrapper.classList.add("slop_radar_card");

        if (response && response.isSlop) {
          wrapper.removeAttribute("data-slop-detected");
          const existingBadge = wrapper.querySelector(".not_slop_ribbon_container");
          if (existingBadge) existingBadge.remove();

          killMediaElements(wrapper);

          wrapper.querySelectorAll("[data-slop-detected]").forEach(child => {
            child.removeAttribute("data-slop-detected");
            const childOverlay = child.querySelector(".slop_radar_overlay");
            if (childOverlay) childOverlay.remove();
          });
          wrapper.querySelectorAll(".not_slop_ribbon_container").forEach(el => el.remove());

          if (!wrapper.querySelector(".slop_radar_overlay")) {
            wrapper.setAttribute("data-slop-detected", "true");
            
            const overlay = document.createElement("div");
            overlay.className = "slop_radar_overlay";
            
            const overlayText = document.createElement("div");
            overlayText.className = "slop_radar_overlay_text";
            overlayText.textContent = "AI SLOP";
            
            overlay.appendChild(overlayText);
            wrapper.appendChild(overlay);
          }
        } else if (response && !response.isSlop) {
          if (wrapper.getAttribute("data-slop-detected") === "true" || wrapper.querySelector(".slop_radar_overlay")) {
            return;
          }

          const existingOverlay = wrapper.querySelector(".slop_radar_overlay");
          if (existingOverlay) existingOverlay.remove();
          wrapper.removeAttribute("data-slop-detected");

          if (!wrapper.querySelector(".not_slop_ribbon_container")) {
            const container = document.createElement("div");
            container.className = "not_slop_ribbon_container";
            
            const ribbon = document.createElement("div");
            ribbon.className = "not_slop_ribbon";
            ribbon.textContent = "NOT SLOP! 🫅";
            
            container.appendChild(ribbon);
            wrapper.appendChild(container);
          }
        }
      }
    );
  });
}

function queueContainerCheck(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const testId = node.dataset.testid || "";
  if (testId.includes("text") || testId.includes("box")) {
    targetedTextNodes.add(node);
  } else {
    const elements = node.querySelectorAll("[data-testid*='text'], [data-testid*='box']");
    elements.forEach(el => targetedTextNodes.add(el));
  }
}

const observer = new MutationObserver((mutations) => {
  let hasInjections = false;
  for (let i = 0; i < mutations.length; i++) {
    const addedNodes = mutations[i].addedNodes;
    for (let j = 0; j < addedNodes.length; j++) {
      queueContainerCheck(addedNodes[j]);
      hasInjections = true;
    }
  }
  if (hasInjections) {
    clearTimeout(processingTimeout);
    processingTimeout = setTimeout(processTrackedContainers, 200);
  }
});

const initialTextNodes = document.querySelectorAll("[data-testid*='text'], [data-testid*='box']");
initialTextNodes.forEach(node => targetedTextNodes.add(node));

if (targetedTextNodes.size > 0) {
  processTrackedContainers();
}

observer.observe(document.body, { childList: true, subtree: true });