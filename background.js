// background.js

// ── Default slop patterns ─────────────────────────────────────────────────
const DEFAULT_PATTERNS = [
  // Structure tricks
  "Single sentences on their own line to fake profundity",
  "Aggressive line breaks to stretch thin content (\"No model.\\nNo agents.\\nNo flashy AI app.\")",
  "Em-dashes used for dramatic effect — like this — constantly",
  "Lists of negatives: \"Not X. Not Y. Not Z.\"",
  "Starting lines with \"Not because\", \"But not\", \"Except\"",
  "Rhetorical \"If you X, you Y\" constructions",
  "\"The X isn't X. It's Y.\" reframings",
  "Trailing \"...\" to imply there's more depth than there is",
  // Linguistic tells
  "\"quietly\" implying hidden agenda (\"OpenAI quietly...\")",
  "\"just dropped\", \"bombshell\", \"massive\", \"game-changer\"",
  "\"The moat is\", \"The real moat\", \"is no longer the moat\"",
  "\"The model is not the X. The Y is.\" sentence pattern",
  "\"is not ... it is\" reframes",
  "\"these aren't just X, they're Y\"",
  "\"What surprised me most:\", \"The hardest part wasn't\"",
  "\"flying blind\", \"expose\", \"buried\", \"contaminating\"",
  "Grand philosophical statements about AI/tech with zero evidence",
  "\"7-figure\", \"8-figure\" as credibility signals",
  "Name-dropping companies with no actual insight",
  "\"I asked him one question, and...\"",
  "\"Yesterday, [impressive title] told me...\"",
  "\"And [Platform] noticed.\" as a mic drop",
  "Vague warnings: \"If you can't see it, you can't fix it\"",
  "\"shallow [profession]\", \"exposing shallow engineering\"",
  "\"No real experience. No original thinking.\"",
  "Repeating the same point 3 times in slightly different words",
  "Ending with implicit call to engage (\"What do you think?\", \"Agree?\", \"Share this if...\")",
  "\"nobody's talking about this\" or \"no one is talking about\"",
  "\"Most companies think...\" or \"Most people think...\" setting up a contrarian take",
  "\"Most founders/leaders/teams don't realize...\"",
  "Referring to a recurring conversation: \"I keep hearing this\", \"I hear this all the time\", \"I get asked this constantly\", \"clients always ask me\", \"everyone keeps telling me\"",
  "Humble-bragging via social proof: \"people reach out to ask me\", \"founders DM me about this\", \"I get this question every week\"",
  // Content patterns
  "Announcing someone else's news as if it's insight (\"Elon just dropped this bombshell\")",
  "Acquisition/funding news padded with fake analysis",
  "\"AI is changing everything\" with no specifics",
  "Motivational reframes of obvious facts",
  "Vague productivity/leadership wisdom",
  "Warnings about AI replacing jobs with zero technical substance",
  "Posts about the state of the feed itself (\"LinkedIn is full of AI slop\")",
  "Tech hype laundered through a narrative arc",
  "Consulting/agency self-promotion disguised as insight",
];

const MAX_PATTERN_TOKENS = 3000; // rough char budget before we compact

// ── Settings defaults ─────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  darkMode: false,
  showTrashCan: true,
  showMessageAuthor: true,
  minConfidence: 60, // only hide if confidence >= this
};

// ── Storage helpers ───────────────────────────────────────────────────────
function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

async function getPatterns() {
  const data = await storageGet(["slopPatterns"]);
  return data.slopPatterns || DEFAULT_PATTERNS;
}

async function savePatterns(patterns) {
  await storageSet({ slopPatterns: patterns });
}

async function getSettings() {
  const data = await storageGet(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function saveSettings(settings) {
  await storageSet({ settings });
}

// ── AI engine ─────────────────────────────────────────────────────────────
let aiSession = null;

async function initEngine() {
  try {
    if (typeof LanguageModel === 'undefined') return;
    aiSession = await LanguageModel.create({
      systemPrompt: "You are a precise assistant. Follow instructions exactly. Output only what is asked for — no preamble, no explanation, no markdown."
    });
    drainQueue();
  } catch (err) {
    console.error("[SlopRadar] Engine init failed:", err);
  }
}

chrome.runtime.onInstalled.addListener(initEngine);
chrome.runtime.onStartup.addListener(initEngine);

// ── Compact patterns when too large ──────────────────────────────────────
async function maybeCompactPatterns() {
  if (!aiSession) return;
  const patterns = await getPatterns();
  const totalChars = patterns.join("\n").length;
  if (totalChars < MAX_PATTERN_TOKENS) return;

  console.log(`[SlopRadar] Compacting ${patterns.length} patterns (${totalChars} chars)...`);
  try {
    const prompt = `Below is a list of slop detection patterns for a social media filter. Some are redundant or overlapping. Merge and deduplicate them into the smallest possible list that preserves all distinct signal. Output ONLY a JSON array of strings — each string is one pattern. No explanation, no markdown, no preamble.

Patterns:
${patterns.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Output (JSON array only):`;

    const result = await aiSession.prompt(prompt);
    const clean = result.replace(/```json|```/g, "").trim();
    const compacted = JSON.parse(clean);
    if (Array.isArray(compacted) && compacted.length > 5) {
      await savePatterns(compacted);
      console.log(`[SlopRadar] Compacted to ${compacted.length} patterns`);
    }
  } catch (err) {
    console.error("[SlopRadar] Compact failed:", err);
  }
}

// ── Learn from a new slop example ────────────────────────────────────────
async function learnFromSlop(postText) {
  if (!aiSession) return;
  try {
    const existing = await getPatterns();
    const prompt = `You are analyzing a social media post that has been identified as AI-generated slop/engagement bait. Extract 1-3 NEW anti-patterns it demonstrates that are NOT already covered by the existing patterns list. Be specific and generalizable. If no new patterns exist, return an empty array.

Existing patterns (do not repeat these):
${existing.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Slop post to analyze:
"""
${postText.substring(0, 800)}
"""

Output ONLY a JSON array of new pattern strings. Empty array if none. No markdown, no explanation.`;

    const result = await aiSession.prompt(prompt);
    const clean = result.replace(/```json|```/g, "").trim();
    const newPatterns = JSON.parse(clean);
    if (Array.isArray(newPatterns) && newPatterns.length > 0) {
      const updated = [...existing, ...newPatterns];
      await savePatterns(updated);
      console.log(`[SlopRadar] Learned ${newPatterns.length} new patterns:`, newPatterns);
      await maybeCompactPatterns();
      return newPatterns;
    }
    return [];
  } catch (err) {
    console.error("[SlopRadar] Learn failed:", err);
    return [];
  }
}

// ── Tab state ─────────────────────────────────────────────────────────────
let activeTabId = null;
const visibleTabIds = new Set();

async function refreshTabState() {
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
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (!isSupportedUrl(tab.url || "")) setBadgeIdle(tabId);
  });
});

chrome.windows.onFocusChanged.addListener(async () => {
  await refreshTabState();
  sortQueue();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  purgeTab(tabId, "closed");
  if (tabId === activeTabId) activeTabId = null;
  visibleTabIds.delete(tabId);
  setBadgeIdle(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") purgeTab(tabId, "navigated");
  if (changeInfo.status === "complete") {
    if (!isSupportedUrl(tab.url || "")) setBadgeIdle(tabId);
  }
});

function purgeTab(tabId, reason) {
  const before = queue.length;
  queue = queue.filter(item => item.tabId !== tabId);
  const purged = before - queue.length;
  if (purged > 0) {
    console.log(`[SlopRadar] Purged ${purged} items for tab ${tabId} (${reason})`);
    broadcastQueueSize();
  }
}

// ── Priority queue ────────────────────────────────────────────────────────
let queue = [];
let draining = false;

function sortQueue() {
  queue.sort((a, b) => {
    const pa = tabPriority(a.tabId);
    const pb = tabPriority(b.tabId);
    if (pa !== pb) return pa - pb;
    return a.enqueuedAt - b.enqueuedAt;
  });
}

function enqueue(tabId, text, sendResponse) {
  queue.push({ tabId, text, sendResponse, enqueuedAt: Date.now() });
  sortQueue();
  broadcastQueueSize();
  drainQueue();
}

function broadcastQueueSize() {
  const size = queue.length;
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id && isSupportedUrl(tab.url || "")) {
        chrome.tabs.sendMessage(tab.id, { action: "queueSize", size }).catch(() => {});
      }
    }
  });
}

async function drainQueue() {
  if (draining || !aiSession) return;
  draining = true;

  while (queue.length > 0) {
    broadcastQueueSize();
    const item = queue.shift();

    let tabStillOpen = false;
    try { await chrome.tabs.get(item.tabId); tabStillOpen = true; } catch (_) {}
    if (!tabStillOpen) { console.log(`[SlopRadar] Skip gone tab ${item.tabId}`); continue; }

    const settings = await getSettings();
    const patterns = await getPatterns();

    try {
      const result = await aiSession.prompt(buildPrompt(item.text, patterns));
      const rawOutput = result.trim();
      let isSlop = false, confidence = 50;
      try {
        const parsed = JSON.parse(rawOutput.replace(/```json|```/g, "").trim());
        isSlop = parsed.slop === 1;
        confidence = Math.min(100, Math.max(1, Math.round(parsed.confidence ?? 50)));
      } catch (_) {
        isSlop = rawOutput.match(/[01]/)?.[0] === "1";
        confidence = 50;
      }
      // Apply min confidence threshold from settings
      if (isSlop && confidence < settings.minConfidence) isSlop = false;
      console.log(`[SlopRadar] tab=${item.tabId} verdict=${isSlop ? "SLOP" : "OK"} conf=${confidence}%`);
      item.sendResponse({ isSlop, confidence });
    } catch (err) {
      console.error("[SlopRadar] Inference error:", err);
      try { item.sendResponse({ isSlop: false, confidence: 50 }); } catch (_) {}
    }
  }

  broadcastQueueSize();
  draining = false;
}

// ── Prompt builder ────────────────────────────────────────────────────────
function buildPrompt(text, patterns) {
  const patternList = patterns.map(p => `- ${p}`).join("\n");
  return `You are an extremely cynical LinkedIn/Twitter slop detector. Classify as slop (1) or authentic (0).

SLOP PATTERNS — classify as 1 if ANY of these are present:
${patternList}

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

// ── Stats ─────────────────────────────────────────────────────────────────
async function getStats() {
  const data = await storageGet(["totalChecked", "totalSlop", "perSite"]);
  return {
    totalChecked: data.totalChecked || 0,
    totalSlop: data.totalSlop || 0,
    perSite: data.perSite || {},
  };
}

async function recordResult(hostname, isSlop) {
  const stats = await getStats();
  stats.totalChecked++;
  if (isSlop) stats.totalSlop++;
  if (!stats.perSite[hostname]) stats.perSite[hostname] = { checked: 0, slop: 0 };
  stats.perSite[hostname].checked++;
  if (isSlop) stats.perSite[hostname].slop++;
  await storageSet({ totalChecked: stats.totalChecked, totalSlop: stats.totalSlop, perSite: stats.perSite });
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

// ── Message handler ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "log") { console.log(request.text); return true; }

  if (request.action === "getTabId") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return true;
  }

  if (request.action === "contentActive") {
    const tabId = sender.tab?.id;
    if (tabId) { setBadgeActive(tabId); refreshTabState(); }
    return true;
  }

  if (request.action === "tabRefreshing") {
    const tabId = request.tabId ?? sender.tab?.id;
    if (tabId) purgeTab(tabId, "page-refresh");
    return true;
  }

  if (request.action === "recordResult") {
    recordResult(request.hostname, request.isSlop);
    return true;
  }

  if (request.action === "getStats") {
    getStats().then(stats => sendResponse(stats));
    return true;
  }

  if (request.action === "getSettings") {
    getSettings().then(s => sendResponse(s));
    return true;
  }

  if (request.action === "saveSettings") {
    saveSettings(request.settings).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.action === "getPatterns") {
    getPatterns().then(p => sendResponse({ patterns: p }));
    return true;
  }

  if (request.action === "savePatterns") {
    savePatterns(request.patterns).then(() => {
      maybeCompactPatterns();
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.action === "resetPatterns") {
    savePatterns(DEFAULT_PATTERNS).then(() => sendResponse({ ok: true, patterns: DEFAULT_PATTERNS }));
    return true;
  }

  if (request.action === "learnFromSlop") {
    learnFromSlop(request.postText).then(newPatterns => sendResponse({ ok: true, newPatterns }));
    return true;
  }

  if (request.action === "compactPatterns") {
    maybeCompactPatterns().then(() => getPatterns()).then(p => sendResponse({ ok: true, patterns: p }));
    return true;
  }

  if (request.action === "evaluatePost") {
    if (!aiSession) { sendResponse({ isSlop: false, confidence: 50 }); return true; }
    const tabId = request.tabId ?? sender.tab?.id ?? -1;
    enqueue(tabId, request.text, sendResponse);
    return true;
  }
});
