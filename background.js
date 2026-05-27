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
  minConfidence: 60,
  universalMode: true,
  hideSlop: false, // hide slop cards entirely instead of blur/collapse
  excludedSites: [], // extra user-added hostnames to skip in universal mode
};

// ── Storage helpers ───────────────────────────────────────────────────────
function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

// ── Pause state ──────────────────────────────────────────────────────────
let pausedState = false;

async function getPauseState() {
  const d = await storageGet(["paused"]);
  pausedState = !!d.paused;
  return pausedState;
}

async function setPauseState(paused) {
  pausedState = paused;
  await storageSet({ paused });
  // Update badge
  const tabs = await new Promise(r => chrome.tabs.query({}, r));
  for (const tab of tabs) {
    if (tab.id && isSupportedUrl(tab.url || "")) {
      chrome.tabs.sendMessage(tab.id, { action: "pauseStateChanged", paused }).catch(() => {});
    }
  }
  // Reflect in extension icon title
  chrome.action.setTitle({ title: paused ? "SlopRadar — Paused" : "SlopRadar — Active" });
  if (paused) {
    // Show P badge on all active tabs
    tabs.filter(t => isSupportedUrl(t.url || "")).forEach(t => {
      chrome.action.setBadgeText({ text: "⏸", tabId: t.id });
      chrome.action.setBadgeBackgroundColor({ color: "#6b7280", tabId: t.id });
    });
  } else {
    tabs.filter(t => isSupportedUrl(t.url || "")).forEach(t => {
      chrome.action.setBadgeText({ text: "ON", tabId: t.id });
      chrome.action.setBadgeBackgroundColor({ color: "#e02424", tabId: t.id });
    });
  }
}

async function getPatterns() {
  const data = await storageGet(["slopPatterns"]);
  return data.slopPatterns || DEFAULT_PATTERNS;
}

async function savePatterns(patterns) {
  await storageSet({ slopPatterns: patterns });
}

// ── User-taught patterns (modular) ────────────────────────────────────────
// Patterns the user explicitly taught via right-click "mark as slop" are
// kept in their OWN bucket, separate from the core slopPatterns list. This
// keeps them modular: they are never merged into the main list by the
// compactor, and the prompt presents them as a distinct, recent signal so
// a freshly-taught pattern doesn't dilute or override the established ones.
// Each entry: { text, source, ts } — source is a short snippet of the post
// it was taught from, for display + dedup.
const MAX_USER_PATTERNS = 60;

async function getUserPatterns() {
  const data = await storageGet(["userTaughtPatterns"]);
  return Array.isArray(data.userTaughtPatterns) ? data.userTaughtPatterns : [];
}

async function saveUserPatterns(list) {
  // Keep newest, cap the list.
  const capped = list.slice(-MAX_USER_PATTERNS);
  await storageSet({ userTaughtPatterns: capped });
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

// ── Teach from a missed post (right-click "mark as slop") ────────────────
// Modular by design: the model extracts patterns FROM THIS SPECIFIC POST
// only, and they land in the separate userTaughtPatterns bucket. We pass
// the existing patterns purely so the model avoids duplicating them — the
// new ones never get merged into the core list.
async function teachFromMissedPost(postText) {
  if (!aiSession) return { ok: false, reason: "AI engine not ready", patterns: [] };
  try {
    const corePatterns = await getPatterns();
    const userPatterns = await getUserPatterns();
    const alreadyKnown = corePatterns.concat(userPatterns.map(u => u.text));

    const prompt = `A user manually flagged the social media post below as AI slop that the filter MISSED. Identify 1-2 specific, generalizable anti-patterns this post demonstrates — focus on what makes THIS post slop. Do not repeat anything already in the known list. Keep each pattern a short phrase (under 12 words), specific enough to catch similar posts but not so broad it would catch genuine content.

Known patterns (do NOT repeat):
${alreadyKnown.map((p, i) => `${i + 1}. ${p}`).join("\n")}

The missed slop post:
"""
${postText.substring(0, 800)}
"""

Output ONLY a JSON array of 1-2 new pattern strings. No markdown, no explanation.`;

    const result = await aiSession.prompt(prompt);
    const clean = result.replace(/```json|```/g, "").trim();
    let extracted = [];
    try { extracted = JSON.parse(clean); } catch (_) { extracted = []; }
    if (!Array.isArray(extracted)) extracted = [];

    // Filter out empties and anything that duplicates a known pattern.
    const knownLower = new Set(alreadyKnown.map(p => p.toLowerCase().trim()));
    const fresh = extracted
      .map(p => String(p).trim())
      .filter(p => p.length > 3 && !knownLower.has(p.toLowerCase()));

    if (fresh.length === 0) {
      return { ok: true, patterns: [], note: "No new patterns — already covered." };
    }

    const snippet = postText.substring(0, 100).replace(/\s+/g, " ").trim();
    const userPatternsNext = userPatterns.concat(
      fresh.map(text => ({ text, source: snippet, ts: Date.now() }))
    );
    await saveUserPatterns(userPatternsNext);
    console.log(`[SlopRadar] Taught ${fresh.length} user pattern(s):`, fresh);
    return { ok: true, patterns: fresh };
  } catch (err) {
    console.error("[SlopRadar] teachFromMissedPost failed:", err);
    return { ok: false, reason: String(err), patterns: [] };
  }
}

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

// ── Unlearn: remove patterns that match a NOT-slop post ─────────────────
async function unlearnFromPost(postText) {
  if (!aiSession) return [];
  try {
    const existing = await getPatterns();
    const prompt = `A social media post was incorrectly flagged as slop. Identify which patterns from the list below INCORRECTLY match this post and should be removed or narrowed. Return a JSON object: { "remove": [indices to remove, 0-based], "narrowed": ["replacement text for any patterns that should be more specific rather than removed"] }. If the post is genuinely not slop and certain patterns are too broad, list them.

Patterns:
${existing.map((p, i) => `${i}. ${p}`).join("\n")}

Post (flagged incorrectly as slop):
"""
${postText.substring(0, 800)}
"""

Output ONLY valid JSON like {"remove":[2,7],"narrowed":[]}. No markdown.`;

    const result = await aiSession.prompt(prompt);
    const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
    const toRemove = new Set(parsed.remove || []);
    let updated = existing.filter((_, i) => !toRemove.has(i));
    if (parsed.narrowed?.length) updated = updated.concat(parsed.narrowed);
    if (updated.length > 5 && updated.length !== existing.length) {
      await savePatterns(updated);
      console.log(`[SlopRadar] Unlearned: removed ${toRemove.size}, narrowed ${parsed.narrowed?.length || 0}`);
      return { removed: toRemove.size, narrowed: parsed.narrowed?.length || 0 };
    }
    return { removed: 0, narrowed: 0 };
  } catch (err) {
    console.error("[SlopRadar] Unlearn failed:", err);
    return { removed: 0, narrowed: 0 };
  }
}

// ── Site pause (per-hostname) ─────────────────────────────────────────────
async function getSitePause(hostname) {
  const d = await storageGet(["pausedSites"]);
  const sites = d.pausedSites || {};
  return !!sites[hostname];
}

async function setSitePause(hostname, forever) {
  if (forever) {
    const d = await storageGet(["pausedSites"]);
    const sites = d.pausedSites || {};
    sites[hostname] = true;
    await storageSet({ pausedSites: sites });
  }
  // Session pause is handled purely in content script memory
}

async function clearSitePause(hostname) {
  const d = await storageGet(["pausedSites"]);
  const sites = d.pausedSites || {};
  delete sites[hostname];
  await storageSet({ pausedSites: sites });
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
  if (draining || !aiSession || pausedState) return;
  draining = true;

  while (queue.length > 0) {
    broadcastQueueSize();
    const item = queue.shift();

    let tabStillOpen = false;
    try { await chrome.tabs.get(item.tabId); tabStillOpen = true; } catch (_) {}
    if (!tabStillOpen) { console.log(`[SlopRadar] Skip gone tab ${item.tabId}`); continue; }

    const settings = await getSettings();
    const patterns = await getPatterns();
    const userPatterns = await getUserPatterns();

    try {
      const result = await aiSession.prompt(buildPrompt(item.text, patterns, userPatterns));
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
function buildPrompt(text, patterns, userPatterns) {
  const patternList = patterns.map(p => `- ${p}`).join("\n");
  // User-taught patterns get their own clearly-labeled section so the model
  // treats them as targeted, recent signals rather than folding them into
  // the general rule set.
  let userSection = "";
  if (userPatterns && userPatterns.length > 0) {
    const userList = userPatterns.map(u => `- ${u.text}`).join("\n");
    userSection = `

RECENTLY USER-FLAGGED PATTERNS — the user explicitly flagged posts with these traits as slop the filter missed. Treat a match here as strong evidence of slop:
${userList}`;
  }
  return `You are an extremely cynical LinkedIn/Twitter slop detector. Classify as slop (1) or authentic (0).

SLOP PATTERNS — classify as 1 if ANY of these are present:
${patternList}${userSection}

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

// ── Log ring buffer ───────────────────────────────────────────────────────
// The content scripts forward their scraper/sweep logs here; the Settings
// page polls getLogs to render a live log window.
const LOG_BUFFER_MAX = 300;
let logBuffer = [];

function pushLog(line, host, ts) {
  logBuffer.push({
    line: String(line || ""),
    host: host || "",
    ts: ts || Date.now(),
  });
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer = logBuffer.slice(-LOG_BUFFER_MAX);
  }
}

// ── Message handler ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "log") {
    pushLog(request.line ?? request.text, request.host, request.ts);
    return false;
  }

  if (request.action === "getLogs") {
    sendResponse({ logs: logBuffer });
    return true;
  }

  if (request.action === "clearLogs") {
    logBuffer = [];
    sendResponse({ ok: true });
    return true;
  }

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

  // Right-click "mark as slop" — modular teaching into userTaughtPatterns
  if (request.action === "teachMissedPost") {
    teachFromMissedPost(request.postText).then(res => sendResponse(res));
    return true;
  }

  if (request.action === "getUserPatterns") {
    getUserPatterns().then(list => sendResponse({ patterns: list }));
    return true;
  }

  if (request.action === "removeUserPattern") {
    getUserPatterns().then(list => {
      const next = list.filter((u, i) => i !== request.index);
      return saveUserPatterns(next).then(() => sendResponse({ ok: true, patterns: next }));
    });
    return true;
  }

  if (request.action === "clearUserPatterns") {
    saveUserPatterns([]).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.action === "compactPatterns") {
    maybeCompactPatterns().then(() => getPatterns()).then(p => sendResponse({ ok: true, patterns: p }));
    return true;
  }

  if (request.action === "getPauseState") {
    getPauseState().then(paused => sendResponse({ paused }));
    return true;
  }

  if (request.action === "setPauseState") {
    setPauseState(request.paused).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.action === "unlearn") {
    unlearnFromPost(request.postText).then(res => sendResponse({ ok: true, ...res }));
    return true;
  }

  if (request.action === "getSitePause") {
    getSitePause(request.hostname).then(paused => sendResponse({ paused }));
    return true;
  }

  if (request.action === "setSitePause") {
    setSitePause(request.hostname, request.forever).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.action === "clearSitePause") {
    clearSitePause(request.hostname).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (request.action === "evaluatePost") {
    if (!aiSession) { sendResponse({ isSlop: false, confidence: 50 }); return true; }
    const tabId = request.tabId ?? sender.tab?.id ?? -1;
    enqueue(tabId, request.text, sendResponse);
    return true;
  }
});

// ── Context menu — right-click "mark as slop" ────────────────────────────
// Mirrors AdBlock's "Block this ad" UX: right-click a post the filter
// missed → teach SlopRadar from it → the post is removed immediately.
const CTX_MENU_ID = "slopradar_mark_slop";

function createContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: CTX_MENU_ID,
        title: "SlopRadar: mark this as slop",
        contexts: ["page", "selection", "link", "image"],
        documentUrlPatterns: [
          "*://*.x.com/*", "*://*.twitter.com/*", "*://*.linkedin.com/*",
        ],
      });
    });
  } catch (err) {
    console.error("[SlopRadar] context menu create failed:", err);
  }
}

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CTX_MENU_ID || !tab?.id) return;
  // Tell the content script to act on the element that was right-clicked.
  // The content script tracks the last contextmenu target itself.
  chrome.tabs.sendMessage(tab.id, {
    action: "markRightClickedAsSlop",
    selectionText: info.selectionText || "",
  }).catch(() => {});
});
