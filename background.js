// background.js

// ── AI engine ─────────────────────────────────────────────────────────────
let aiSession = null;

async function initEngine() {
  try {
    if (typeof LanguageModel === 'undefined') return;
    aiSession = await LanguageModel.create({
      systemPrompt: "You are a social media feed filter. Respond with a JSON object only: {\"slop\": 1 or 0, \"confidence\": 0-100}. slop=1 means slop/marketing/engagement bait, slop=0 means authentic. confidence is how certain you are (100=completely certain). No other text, no markdown, no explanation."
    });
    drainQueue(); // start processing any items that queued before engine was ready
  } catch (err) {
    console.error("[SlopRadar] Engine init failed:", err);
  }
}

chrome.runtime.onInstalled.addListener(initEngine);
chrome.runtime.onStartup.addListener(initEngine);

// ── Tab state ─────────────────────────────────────────────────────────────
// Priority: 0 = active/focused tab, 1 = visible (other window), 2 = background
let activeTabId = null;
const visibleTabIds = new Set(); // tabs visible in any window

async function refreshTabState() {
  // Get the focused window's active tab
  const windows = await chrome.windows.getAll({ populate: true });
  visibleTabIds.clear();
  activeTabId = null;

  for (const win of windows) {
    for (const tab of win.tabs) {
      if (!tab.audible && tab.discarded) continue;
      if (tab.active) {
        visibleTabIds.add(tab.id);
        if (win.focused) activeTabId = tab.id;
      }
    }
  }
}

function tabPriority(tabId) {
  if (tabId === activeTabId) return 0;
  if (visibleTabIds.has(tabId)) return 1;
  return 2;
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await refreshTabState();
  sortQueue();
  // Badge management
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    const url = tab.url || "";
    const supported = isSupportedUrl(url);
    if (!supported) setBadgeIdle(tabId);
  });
});

chrome.windows.onFocusChanged.addListener(async () => {
  await refreshTabState();
  sortQueue();
});

// Purge queue entries for closed tabs immediately
chrome.tabs.onRemoved.addListener((tabId) => {
  const before = queue.length;
  queue = queue.filter(item => item.tabId !== tabId);
  const purged = before - queue.length;
  if (purged > 0) console.log(`[SlopRadar] Purged ${purged} queued items for closed tab ${tabId}`);
  if (tabId === activeTabId) activeTabId = null;
  visibleTabIds.delete(tabId);
  setBadgeIdle(tabId);
});

// ── Priority queue ────────────────────────────────────────────────────────
// Each item: { tabId, text, sendResponse, enqueuedAt }
let queue = [];
let draining = false;

function sortQueue() {
  queue.sort((a, b) => {
    const pa = tabPriority(a.tabId);
    const pb = tabPriority(b.tabId);
    if (pa !== pb) return pa - pb;          // priority first
    return a.enqueuedAt - b.enqueuedAt;     // then FIFO within same priority
  });
}

function enqueue(tabId, text, sendResponse) {
  queue.push({ tabId, text, sendResponse, enqueuedAt: Date.now() });
  sortQueue();
  drainQueue();
}

async function drainQueue() {
  if (draining) return;
  if (!aiSession) return;
  draining = true;

  while (queue.length > 0) {
    const item = queue.shift();

    // Double-check the tab still exists before spending inference on it
    let tabStillOpen = false;
    try {
      await chrome.tabs.get(item.tabId);
      tabStillOpen = true;
    } catch (_) {
      // tab was closed between enqueue and drain
    }

    if (!tabStillOpen) {
      console.log(`[SlopRadar] Skipping item for gone tab ${item.tabId}`);
      // Don't call sendResponse — the port is dead, it would throw
      continue;
    }

    try {
      const result = await aiSession.prompt(buildPrompt(item.text));
      const rawOutput = result.trim();
      let isSlop = false;
      let confidence = 50;
      try {
        const clean = rawOutput.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);
        isSlop = parsed.slop === 1;
        confidence = Math.min(100, Math.max(1, Math.round(parsed.confidence ?? 50)));
      } catch (_) {
        // fallback: try to find a digit
        isSlop = rawOutput.match(/[01]/)?.[0] === "1";
        confidence = 50;
      }
      console.log(`[SlopRadar] tab=${item.tabId} priority=${tabPriority(item.tabId)} VERDICT=${isSlop ? "SLOP" : "OK"} confidence=${confidence}%`);
      item.sendResponse({ isSlop, confidence });
    } catch (err) {
      console.error("[SlopRadar] Inference error:", err);
      item.sendResponse({ isSlop: false });
    }
  }

  draining = false;
}

// ── Prompt builder ────────────────────────────────────────────────────────
function buildPrompt(text) {
  return `You are an extremely cynical LinkedIn/Twitter slop detector. Classify as slop (1) or authentic (0).

SLOP PATTERNS — classify as 1 if ANY of these are present:

STRUCTURE TRICKS:
- Single sentences on their own line to fake profundity
- Aggressive line breaks to stretch thin content ("No model.\\nNo agents.\\nNo flashy AI app.")
- Em-dashes used for dramatic effect — like this — constantly
- Lists of negatives: "Not X. Not Y. Not Z."
- Starting lines with "Not because", "But not", "Except"
- Rhetorical "If you X, you Y" constructions
- "The X isn't X. It's Y." reframings
- Trailing "..." to imply there's more depth than there is

LINGUISTIC TELLS:
- "quietly" implying hidden agenda ("OpenAI quietly...")
- "just dropped", "bombshell", "massive", "game-changer"
- "The moat is", "The real moat", "is no longer the moat"
- "The model is not the X. The Y is." sentence pattern
- "is not ... it is" reframes
- "these aren't just X, they're Y"
- "What surprised me most:", "The hardest part wasn't"
- "flying blind", "expose", "buried", "contaminating"
- Grand philosophical statements about AI/tech with zero evidence
- "7-figure", "8-figure" as credibility signals
- Name-dropping companies with no actual insight ("Anthropic just acquired X for $300M+")
- "I asked him one question, and..."
- "Yesterday, [person with impressive title] told me..."
- "And [Platform] noticed." as a mic drop
- Vague warnings: "If you can't see it, you can't fix it"
- "shallow [profession]", "exposing shallow engineering"
- "No real experience. No original thinking."
- Repeating the same point 3 times in slightly different words
- Ending with an implicit call to engage ("What do you think?", "Agree?", "Share this if...")

CONTENT PATTERNS:
- Announcing someone else's news as if it's insight ("Elon just dropped this bombshell")
- Acquisition/funding news padded with fake analysis
- "AI is changing everything" with no specifics
- Motivational reframes of obvious facts
- Vague productivity/leadership wisdom
- Warnings about AI replacing jobs with zero technical substance
- Posts that are entirely about the state of the feed itself ("LinkedIn is full of AI slop")
- Tech hype laundered through a narrative arc
- Consulting/agency self-promotion disguised as insight

AUTHENTIC — classify as 0 ONLY if:
- Contains actual code, specific error messages, or technical implementation detail
- Describes a specific thing they personally built, measured, or tested with real numbers
- Makes a narrow, falsifiable claim with evidence
- Is a genuine question with no performance attached
- Contains domain-specific jargon used correctly and precisely (not for show)

Input Text:
"""
${text}
"""

Respond with ONLY a JSON object like {"slop": 1, "confidence": 87}. No other text.`;
}

// ── Badge helpers ─────────────────────────────────────────────────────────
function isSupportedUrl(url) {
  return url.includes("linkedin.com") || url.includes("x.com") || url.includes("twitter.com");
}

function setBadgeActive(tabId) {
  chrome.action.setBadgeText({ text: "ON", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#e02424", tabId });
  chrome.action.setTitle({ title: "SlopRadar — Active", tabId });
}

function setBadgeIdle(tabId) {
  chrome.action.setBadgeText({ text: "", tabId });
  chrome.action.setTitle({ title: "SlopRadar", tabId });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!isSupportedUrl(tab.url || "")) setBadgeIdle(tabId);
});

// ── Message handler ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "log") {
    console.log(request.text);
    return true;
  }

  if (request.action === "getTabId") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return true;
  }

  if (request.action === "contentActive") {
    const tabId = sender.tab?.id;
    if (tabId) {
      setBadgeActive(tabId);
      refreshTabState(); // update priority map when a new supported tab registers
    }
    return true;
  }

  if (request.action === "evaluatePost") {
    if (!aiSession) {
      sendResponse({ isSlop: false });
      return true;
    }
    const tabId = request.tabId ?? sender.tab?.id ?? -1;
    enqueue(tabId, request.text, sendResponse);
    return true; // keep message channel open for async response
  }
});
