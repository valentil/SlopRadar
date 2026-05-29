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
  minConfidence: 90,
  hideSlop: false, // hide slop cards entirely instead of blur/collapse
  excludedSites: [], // user-added hostnames to skip among supported sites
  showTrainingButtons: true, // show Confirm/Not-slop buttons on slop cards
  nonIntrusiveMode: false,   // quiet mode — hide slop, no banners or buttons
  removeEntirely: false,     // remove slop elements from the DOM completely
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
  // Notify content scripts on supported tabs so they apply the pause locally.
  const tabs = await new Promise(r => chrome.tabs.query({}, r));
  for (const tab of tabs) {
    if (tab.id && isSupportedUrl(tab.url || "")) {
      chrome.tabs.sendMessage(tab.id, { action: "pauseStateChanged", paused }).catch(() => {});
    }
  }
  // Badge: emoji renders inconsistently in the toolbar badge — plain text is
  // reliable across platforms and pinned/unpinned states.
  chrome.action.setTitle({ title: paused ? "SlopRadar — Paused" : "SlopRadar — Active" });
  if (paused) {
    // Global pause: clear per-tab badges and set a default that shows
    // regardless of which tab is active.
    chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    chrome.action.setBadgeText({ text: "OFF" });
    // Also overwrite any per-tab badges so the pinned icon reflects pause
    // immediately on every tab, not just the active one.
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.action.setBadgeText({ text: "OFF", tabId: tab.id });
      chrome.action.setBadgeBackgroundColor({ color: "#6b7280", tabId: tab.id });
    }
  } else {
    // Unpaused: clear the default, restore per-tab state.
    chrome.action.setBadgeText({ text: "" });
    for (const tab of tabs) {
      if (!tab.id) continue;
      if (isSupportedUrl(tab.url || "")) {
        chrome.action.setBadgeText({ text: "ON", tabId: tab.id });
        chrome.action.setBadgeBackgroundColor({ color: "#e02424", tabId: tab.id });
      } else {
        chrome.action.setBadgeText({ text: "", tabId: tab.id });
      }
    }
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
let engineInitInFlight = null;   // de-dupe concurrent (re)inits
let consecutiveInferenceFails = 0; // health counter for the classify loop
const REINIT_AFTER_FAILS = 3;    // recreate the session after this many in a row

async function createSession() {
  if (typeof LanguageModel === 'undefined') {
    console.warn("[SlopRadar] LanguageModel API unavailable in this browser.");
    return null;
  }
  // Check availability so we can distinguish "model downloading" from "broken".
  try {
    if (typeof LanguageModel.availability === "function") {
      const avail = await LanguageModel.availability();
      if (avail === "unavailable") {
        console.warn("[SlopRadar] Gemini Nano unavailable on this device.");
        return null;
      }
      // "downloadable" / "downloading" → create() will trigger/await it.
    }
  } catch (_) {}
  return await LanguageModel.create({
    systemPrompt: "You are a precise assistant. Follow instructions exactly. Output only what is asked for — no preamble, no explanation, no markdown."
  });
}

async function initEngine() {
  // Coalesce — multiple callers (onInstalled, onStartup, recovery) shouldn't
  // each spin up a session.
  if (engineInitInFlight) return engineInitInFlight;
  engineInitInFlight = (async () => {
    try {
      aiSession = await createSession();
      consecutiveInferenceFails = 0;
      if (aiSession) drainQueue();
    } catch (err) {
      console.error("[SlopRadar] Engine init failed:", err);
      aiSession = null;
    } finally {
      engineInitInFlight = null;
    }
  })();
  return engineInitInFlight;
}

// Tear down and rebuild the session — called when inference repeatedly fails,
// which is the classic MV3 "model got into a bad state and returns garbage
// for everything" situation. Recreating the LanguageModel session is the
// reliable kickstart.
async function recoverEngine(reason) {
  console.warn(`[SlopRadar] Recovering Gemini session — ${reason}`);
  try { aiSession?.destroy?.(); } catch (_) {}
  aiSession = null;
  consecutiveInferenceFails = 0;
  await initEngine();
  return !!aiSession;
}

// ── Self-healing watchdog ─────────────────────────────────────────────────
// In practice the model frequently gets stuck in an "initializing" limbo:
// LanguageModel.availability() reports "available" but the LanguageModel.create()
// promise never resolves (or resolved long ago into a broken session). The
// fix that works reliably is: just try again. This watchdog notices when we
// have queued work but no session, and re-kicks initEngine — which is the
// trick the user observed manually fixes things.
let lastWatchdogKick = 0;
async function engineWatchdog() {
  if (aiSession) return;                 // session is up — nothing to do
  if (engineInitInFlight) return;        // init already running — let it finish
  if (!queue || queue.length === 0) return; // no work waiting
  const now = Date.now();
  if (now - lastWatchdogKick < 3000) return; // don't hammer
  lastWatchdogKick = now;

  // Only auto-kick if the model is *supposed* to be available. If it's
  // downloading, the right answer is to wait — not poke it.
  try {
    if (typeof LanguageModel !== "undefined" && typeof LanguageModel.availability === "function") {
      const avail = await LanguageModel.availability();
      if (avail === "unavailable" || avail === "downloadable" || avail === "downloading") return;
    }
  } catch (_) {}

  console.log("[SlopRadar] Watchdog: queue has work but no session — kicking initEngine");
  initEngine();
}
// Run the watchdog every couple of seconds. MV3 will let this fire as long as
// the service worker is alive; if the worker has gone idle we don't care
// because new posts will wake it via the message handlers anyway.
// (setInterval is set up further down, after `queue` is declared, to avoid
// any TDZ surprise.)

chrome.runtime.onInstalled.addListener(initEngine);
chrome.runtime.onStartup.addListener(initEngine);

// ── One-time migrations ────────────────────────────────────────────────────
// v1.5 changed userTaughtPatterns from "prompt-style anti-patterns" to narrow
// page-side text fingerprints. Entries created before 1.5 are the wrong shape
// (long generalized rules rather than short fingerprints) and would never
// match as fingerprints, so we clear them once on upgrade. The core
// slopPatterns list is untouched — only the right-click bucket is reset.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "update") return;
  try {
    const data = await storageGet(["userTaughtPatterns", "srMigratedTo15"]);
    if (data.srMigratedTo15) return;
    const old = Array.isArray(data.userTaughtPatterns) ? data.userTaughtPatterns : [];
    if (old.length > 0) {
      console.log(`[SlopRadar] Migration v1.5: clearing ${old.length} legacy ` +
        `right-click pattern(s) — they predate the page-fingerprint redesign.`);
    }
    await storageSet({ userTaughtPatterns: [], srMigratedTo15: true });
  } catch (err) {
    console.error("[SlopRadar] v1.5 migration failed:", err);
  }
});

// ── Learn from slop (trash-can / confirm-slop button) ─────────────────────
// Writes to slopPatterns so the prompt stays complete.
// Returns { added, covered, reasoning } for rich inline page feedback.
async function learnFromSlop(postText) {
  if (!aiSession) return { added: [], covered: [], reasoning: "AI engine not ready" };
  try {
    const existing = await getPatterns();
    const prompt = `You are analyzing a social media post identified as AI-generated slop or engagement bait. Extract 1-3 NEW anti-patterns it demonstrates that are NOT already covered by the existing list. Be specific and generalizable.

Existing patterns (do not repeat these):
${existing.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Slop post to analyze:
"""
${postText.substring(0, 800)}
"""

Output ONLY a JSON object: { "added": ["new pattern 1", ...], "covered_by": ["existing pattern that already covers this"], "reasoning": "one sentence" }
Empty array for added if nothing new. No markdown.`;

    const result = await aiSession.prompt(prompt);
    const clean = result.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const added = Array.isArray(parsed.added) ? parsed.added.filter(p => p.length > 3) : [];
    const coveredBy = Array.isArray(parsed.covered_by) ? parsed.covered_by : [];
    const reasoning = parsed.reasoning || "";

    if (added.length > 0) {
      await savePatterns([...existing, ...added]);
      await maybeCompactPatterns();
      console.log(`[SlopRadar] learnFromSlop: added ${added.length}:`, added);
    }
    return { added, covered: coveredBy, reasoning };
  } catch (err) {
    console.error("[SlopRadar] learnFromSlop failed:", err);
    return { added: [], covered: [], reasoning: String(err) };
  }
}

// ── Right-click "mark as slop" — page-side text fingerprints ─────────────
// These are NOT sent to the prompt. They live in userTaughtPatterns as
// text fingerprints for quick-matching near-identical posts without an AI call.
async function teachFromMissedPost(postText) {
  if (!aiSession) return { ok: false, reason: "AI engine not ready", patterns: [] };
  try {
    const corePatterns = await getPatterns();
    const userPatterns = await getUserPatterns();
    const alreadyKnown = corePatterns.concat(userPatterns.map(u => u.text));

    const prompt = `A user manually flagged this post as slop the filter missed. Extract 1-2 SHORT, specific text fingerprints that identify this post or very similar ones — narrow unique phrases or structural quirks, not broad rules.

Known patterns (do NOT repeat):
${alreadyKnown.slice(0, 30).map((p, i) => `${i + 1}. ${p}`).join("\n")}

The missed slop post:
"""
${postText.substring(0, 800)}
"""

Output ONLY a JSON array of 1-2 short fingerprint strings. No markdown.`;

    const result = await aiSession.prompt(prompt);
    const clean = result.replace(/```json|```/g, "").trim();
    let extracted = [];
    try { extracted = JSON.parse(clean); } catch (_) { extracted = []; }
    if (!Array.isArray(extracted)) extracted = [];

    const knownLower = new Set(alreadyKnown.map(p => p.toLowerCase().trim()));
    const fresh = extracted.map(p => String(p).trim())
      .filter(p => p.length > 3 && !knownLower.has(p.toLowerCase()));

    if (fresh.length === 0) {
      return { ok: true, patterns: [], note: "No new fingerprints — already covered." };
    }

    const snippet = postText.substring(0, 100).replace(/\s+/g, " ").trim();
    await saveUserPatterns(userPatterns.concat(
      fresh.map(text => ({ text, source: snippet, ts: Date.now() }))
    ));
    console.log(`[SlopRadar] teachFromMissedPost (page fingerprints):`, fresh);
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

// ── Unlearn: narrow/remove patterns that over-matched a NOT-slop post ─────
// Returns rich detail for inline page feedback.
async function unlearnFromPost(postText) {
  if (!aiSession) return { ok: false, removed: 0, narrowed: 0, removedPatterns: [], narrowedPatterns: [], reasoning: "AI engine not ready" };
  try {
    const existing = await getPatterns();
    const prompt = `A social media post was INCORRECTLY flagged as slop — the user says it is authentic. Identify which patterns from the list below are too broad and incorrectly match this post.

Return a JSON object:
{ "remove": [0-based indices to remove], "narrowed": ["replacement text for patterns to make more specific"], "reasoning": "brief explanation" }

If nothing should change, return {"remove":[],"narrowed":[],"reasoning":"post appears borderline, no changes"}.

Patterns:
${existing.map((p, i) => `${i}. ${p}`).join("\n")}

Post (flagged incorrectly as slop):
"""
${postText.substring(0, 800)}
"""

Output ONLY valid JSON. No markdown.`;

    const result = await aiSession.prompt(prompt);
    const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
    const toRemove = new Set((parsed.remove || []).filter(i => typeof i === "number"));
    const narrowed = Array.isArray(parsed.narrowed) ? parsed.narrowed : [];
    const reasoning = parsed.reasoning || "";
    const removedPatterns = existing.filter((_, i) => toRemove.has(i));
    let updated = existing.filter((_, i) => !toRemove.has(i));
    if (narrowed.length) updated = updated.concat(narrowed);
    if (updated.length >= 5 && (toRemove.size > 0 || narrowed.length > 0)) {
      await savePatterns(updated);
      console.log(`[SlopRadar] unlearnFromPost: removed ${toRemove.size}, narrowed ${narrowed.length}`);
      return { ok: true, removed: toRemove.size, narrowed: narrowed.length, removedPatterns, narrowedPatterns: narrowed, reasoning };
    }
    return { ok: true, removed: 0, narrowed: 0, removedPatterns: [], narrowedPatterns: [], reasoning: reasoning || "No changes — patterns appear appropriate." };
  } catch (err) {
    console.error("[SlopRadar] unlearnFromPost failed:", err);
    return { ok: false, removed: 0, narrowed: 0, removedPatterns: [], narrowedPatterns: [], reasoning: String(err) };
  }
}

// ── Not-slop correction log ───────────────────────────────────────────────
const NOT_SLOP_LOG_MAX = 30;
async function getNotSlopLog() {
  const d = await storageGet(["notSlopLog"]);
  return Array.isArray(d.notSlopLog) ? d.notSlopLog : [];
}
async function appendNotSlopLog(entry) {
  const log = await getNotSlopLog();
  log.push({ ...entry, ts: Date.now() });
  await storageSet({ notSlopLog: log.slice(-NOT_SLOP_LOG_MAX) });
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
  tabEpochs.delete(tabId);
  setBadgeIdle(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") purgeTab(tabId, "navigated");
  if (changeInfo.status === "complete") {
    if (!isSupportedUrl(tab.url || "")) setBadgeIdle(tabId);
  }
});

function purgeTab(tabId, reason) {
  // Bump the epoch first — anything still in flight for this tab is now
  // stale and will be skipped by drainQueue even if it was already shifted.
  bumpTabEpoch(tabId);
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

// Now that `queue` is declared, set up the engine watchdog timer that
// auto-recovers from the "model stuck initializing" limbo.
setInterval(engineWatchdog, 2000);
let draining = false;

// Per-tab epoch. Every time a tab navigates or reloads we bump its epoch.
// Queued items capture the epoch they were enqueued under; on drain we skip
// any item whose epoch is stale — so a reload reliably drops in-flight work
// for that tab even though the tabId stays the same.
const tabEpochs = new Map();
function getTabEpoch(tabId) {
  return tabEpochs.get(tabId) || 0;
}
function bumpTabEpoch(tabId) {
  tabEpochs.set(tabId, getTabEpoch(tabId) + 1);
}

function sortQueue() {
  queue.sort((a, b) => {
    const pa = tabPriority(a.tabId);
    const pb = tabPriority(b.tabId);
    if (pa !== pb) return pa - pb;
    return a.enqueuedAt - b.enqueuedAt;
  });
}

function enqueue(tabId, text, sendResponse, platform) {
  queue.push({
    tabId, text, sendResponse, platform,
    enqueuedAt: Date.now(),
    epoch: getTabEpoch(tabId),
  });
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

    // Skip items enqueued before the tab navigated/reloaded. The tabId is
    // unchanged on reload, so the open-tab check above passes — the epoch
    // is what actually tells us this work belongs to a now-dead page.
    if (item.epoch !== getTabEpoch(item.tabId)) {
      console.log(`[SlopRadar] Skip stale item for tab ${item.tabId} ` +
        `(epoch ${item.epoch} != ${getTabEpoch(item.tabId)})`);
      try { item.sendResponse({ isSlop: false, confidence: 0, stale: true }); } catch (_) {}
      continue;
    }

    const settings = await getSettings();
    const patterns = await getPatterns();

    try {
      const result = await aiSession.prompt(buildPrompt(item.text, patterns, item.platform));
      const rawOutput = (result || "").trim();

      // Parse the verdict. Critically, we distinguish three outcomes:
      //  • clean JSON with a real confidence → a genuine verdict
      //  • parseable-ish but no confidence / garbage → DEGRADED (don't trust)
      //  • empty output → DEGRADED
      // A degraded model returns junk for everything, which used to be
      // silently stamped as {isSlop:false, confidence:50} — the "50% not
      // slop for everything" bug. We now flag it so the page won't stamp it
      // and we can kickstart the session.
      let isSlop = false, confidence = null, degraded = false, reasons = [];

      if (!rawOutput) {
        degraded = true;
      } else {
        try {
          const parsed = JSON.parse(rawOutput.replace(/```json|```/g, "").trim());
          if (typeof parsed.slop === "undefined" || typeof parsed.confidence === "undefined") {
            degraded = true; // model returned JSON but not OUR schema
          } else {
            isSlop = parsed.slop === 1;
            confidence = Math.min(100, Math.max(1, Math.round(parsed.confidence)));
            // Reasons: 1-3 short phrases. Defensively clean & cap.
            if (Array.isArray(parsed.reasons)) {
              reasons = parsed.reasons
                .filter(r => typeof r === "string")
                .map(r => r.trim().replace(/^[-•·]\s*/, ""))
                .filter(r => r.length > 0 && r.length <= 80)
                .slice(0, 3);
            }
            // Placeholder-echo detection: the model is supposed to produce
            // its OWN reasons, but a wedged session sometimes echoes back the
            // "short reason 1/2/3" placeholders from the prompt schema verbatim.
            // Those phrases would never appear in a real classification, so
            // they're a reliable wedge-signal. We treat the whole verdict as
            // degraded — same recovery path as empty/unparseable output —
            // and the engine will be recreated after the failure streak.
            // (Note: we do NOT blacklist the "vague 'this image' framing" /
            // "engagement-bait opener" examples — those are legitimate X-platform
            // categories a healthy model might genuinely produce.)
            if (isSlop && reasons.length > 0) {
              // Placeholders we'd see if the model is echoing the schema
              // rather than actually classifying: "short reason 1",
              // "reason 1", "...", literal "string", etc.
              const isPlaceholder = (r) => {
                const t = r.trim().toLowerCase();
                return /^short reason\s*\d+$/.test(t) ||
                       /^reason\s*\d+$/.test(t) ||
                       /^\.+$/.test(t) ||                 // "..." or "...."
                       t === "string" ||
                       t === "..." ||
                       t === "example" ||
                       t === "placeholder";
              };
              const placeholderEcho = reasons.some(isPlaceholder);
              if (placeholderEcho) {
                console.warn(`[SlopRadar] Model echoed prompt placeholders in reasons: ${JSON.stringify(reasons)}`);
                degraded = true;
                isSlop = false;
                confidence = null;
                reasons = [];
              }
            }
          }
        } catch (_) {
          // Couldn't parse at all. Only trust a bare 0/1 if it's basically the
          // entire output — otherwise treat as degraded rather than guessing 50.
          const m = rawOutput.match(/^[^01]*([01])[^0-9]*$/);
          if (m) { isSlop = m[1] === "1"; confidence = 70; }
          else { degraded = true; }
        }
      }

      if (degraded) {
        consecutiveInferenceFails++;
        console.warn(`[SlopRadar] Degraded model output (streak ${consecutiveInferenceFails}): ${JSON.stringify(rawOutput).slice(0, 120)}`);
        item.sendResponse({ degraded: true });
        if (consecutiveInferenceFails >= REINIT_AFTER_FAILS) {
          // Don't block this loop iteration on recovery; kick it off and bail.
          recoverEngine(`${consecutiveInferenceFails} consecutive degraded outputs`);
          draining = false;
          return;
        }
        continue;
      }

      // Healthy verdict.
      consecutiveInferenceFails = 0;
      // A slop post below the user's confidence bar is downgraded to "not
      // shown" — but it is NOT a confident "authentic" verdict. Flag it so
      // the page doesn't cache it as a settled not-slop result; if the user
      // later lowers the threshold it should be re-evaluated.
      let lowConfidence = false;
      if (isSlop && confidence < settings.minConfidence) {
        isSlop = false;
        lowConfidence = true;
      }
      console.log(`[SlopRadar] tab=${item.tabId} verdict=${isSlop ? "SLOP" : "OK"} conf=${confidence}%${lowConfidence ? " (downgraded)" : ""}`);
      item.sendResponse({ isSlop, confidence, lowConfidence, reasons });
    } catch (err) {
      console.error("[SlopRadar] Inference error:", err);
      consecutiveInferenceFails++;
      // Tell the page this was a failure, not a real "not slop" verdict.
      try { item.sendResponse({ degraded: true }); } catch (_) {}
      if (consecutiveInferenceFails >= REINIT_AFTER_FAILS) {
        recoverEngine(`${consecutiveInferenceFails} consecutive inference errors`);
        draining = false;
        return;
      }
    }
  }

  broadcastQueueSize();
  draining = false;
}

// ── Prompt builder ────────────────────────────────────────────────────────
// ── Prompt builder ────────────────────────────────────────────────────────
// Only slopPatterns go into the prompt. userTaughtPatterns are page-side
// heuristics (text fingerprints for quick-matching), NOT prompt content.
function buildPrompt(text, patterns, platform) {
  const patternList = patterns.map(p => `- ${p}`).join("\n");
  const charCount = text.length;

  // ── Length-aware tier ──
  // Short posts (replies, casual chatter) lack the surface area for our
  // "rich content" authentic signals, so default to authentic unless a
  // pattern matches unambiguously. Medium posts get moderate skepticism.
  let lengthGuidance = "";
  if (charCount < 80) {
    lengthGuidance = `

LENGTH NOTE — this post is short (${charCount} chars). Short posts are usually replies or casual chatter and don't carry enough signal for confident slop detection. Default to authentic (0) UNLESS the text contains an unambiguous slop signature from the pattern list. Do NOT mark short genuine reactions, questions, agreement, jokes, or short opinions as slop.`;
  } else if (charCount < 200) {
    lengthGuidance = `

LENGTH NOTE — this post is medium-length (${charCount} chars). Apply moderate skepticism: require a clear pattern match, not just one weak signal.`;
  }

  // ── Platform-specific guidance ──
  // LinkedIn is overwhelmingly thought-leadership templates — the heuristics
  // there can be aggressive. X has more news, commentary, and quoted-tweet
  // dynamics, so the patterns that matter are different: AI hype layered on
  // a retweet, vague "this image/video" claims with no specifics, etc.
  let platformGuidance = "";
  if (platform === "linkedin") {
    platformGuidance = `

PLATFORM — LinkedIn. The dominant slop genre here is engagement-bait thought leadership: "here's the deep problem with X", "I'll say the quiet part out loud", "nobody talks about this but…", "the real reason X failed", motivational/career-advice posts with no specific claims, manufactured vulnerability ("I got rejected 47 times and here's what it taught me"). Classify these as slop with high confidence. Recruiters posting roles, people sharing genuine company news, technical content, or specific personal experiences with concrete details are NOT slop.`;
  } else if (platform === "twitter") {
    platformGuidance = `

PLATFORM — X / Twitter. The slop dynamics here differ from LinkedIn:
- A short post that quote-tweets or references another popular post AND wraps it in a broad AI/tech/society claim is usually slop ("this is the future", "everything has changed").
- Posts referring to "this image", "this video", "watch this", "look at this" without describing the specific content, paired with a vague sweeping claim, are usually slop.
- Threads opening with "🧵" or "a thread on…" followed by generic claims are often slop.
- BUT: news commentary, political opinions, personal takes on current events, financial/policy analysis, sports reactions, jokes, and ordinary opinions are NOT slop just because they're confident. People posting about real events (ceasefires, elections, market moves, official statements) — including officials and reporters — are NOT slop, even with strong framing. Slop requires generic engagement-bait structure, not just confident opinion.`;
  } else if (platform === "reddit" || platform === "threads") {
    platformGuidance = `

PLATFORM — ${platform}. Be conservative: this surface has more genuine discussion than LinkedIn. Require a clear engagement-bait or generic-AI-hype signal — confident opinions, news takes, or personal commentary are NOT slop on their own.`;
  }

  return `You are a careful detector of AI-generated marketing slop and engagement bait on social media. Classify as slop (1) or authentic (0).

STEP 1 — CLASSIFY THE GENRE FIRST:
Before considering slop, decide which genre this post belongs to:

  (A) NEWS REPORTING — a post stating that a named event, statement, action, or announcement HAPPENED, involving real people, institutions, countries, companies, or markets. The author is reporting what occurred, not editorializing about it. Signals: named entity + action verb + specific event. Example: "UBS slashes jobs during Credit Suisse merger." "Netanyahu announces troop movement." "Fed's Paulson says consumers are spending." ALL CAPS, terse, breaking-news style — these are wire-service conventions, NOT slop signals.

  (B) COMMENTARY / OPINION — a post where the main point is the AUTHOR'S take, framing, or interpretation rather than a real event. Often: "what X gets wrong about Y", "the deep problem with Z", "here's what Musk and Zuckerberg miss", uses the news as a springboard for the author's hot take. Signals: opinion verbs ("misses", "gets wrong", "doesn't realize", "the real reason"), value-laden framing, no clear new event being reported.

  (C) OTHER — neither news nor commentary (jokes, replies, questions, conversations, product posts, etc.)

STEP 2 — APPLY DIFFERENT SLOP THRESHOLDS BY GENRE:
The bar for "slop" depends on the genre. A news report needs MULTIPLE slop signals to be flagged; commentary can be flagged on a single clear signal.

  (A) NEWS REPORTING — require 2+ slop signals from the pattern list. A single weakly-matching pattern is NOT enough. If in doubt, classify as authentic (0). Genuine wire-service news with no real engagement-bait structure is ALWAYS authentic.

  (B) COMMENTARY / OPINION — require 1 clear slop signal. Commentary is where engagement bait usually lives, so be more willing to flag. Templates like "here's the deep problem with X", "what they don't tell you about Y", "the real reason Z failed" are slop with high confidence.

  (C) OTHER — require 1 clear slop signal, but use length-aware judgment (see LENGTH NOTE).

SLOP PATTERNS (signals to count):
${patternList}

AUTHENTIC (0) — DEFAULT to authentic when:
- The post is news reporting and has fewer than 2 clear slop signals.
- The post reports a named event, statement, or action by a real entity.
- The post contains specific details: code, error messages, real numbers, named entities, dates, or first-hand experience.
- The post is a genuine question, joke, reaction, or short opinion without engagement-bait structure.
- You are uncertain — when in doubt, choose 0.

DO NOT classify as slop just because:
- The headline is in ALL CAPS or terse wire-service style.
- The post names an institution, official, country, or market without elaboration.
- The author writes confidently or with strong framing.
- The post is about a current event or politically charged topic.
- The author is a public figure, official, journalist, or news aggregator.
- The post is short (see LENGTH NOTE).
- The post "lacks specific data points" or "implied significance" — those are normal features of news, NOT slop signals.${platformGuidance}${lengthGuidance}

Input Text:
"""
${text}
"""

Respond with ONLY a JSON object: {"slop": 1, "confidence": 87, "reasons": ["...", "..."]}.
- "reasons" is an array of 1-3 SHORT phrases (each under 8 words) explaining WHY the post triggered as slop. Each phrase MUST describe something specific about THIS post — never copy or paraphrase the schema example above. Good examples for slop posts: "vague 'this image' framing", "engagement-bait opener", "no specific claims".
- For authentic posts (slop: 0), "reasons" may be empty [].
- No markdown, no preamble, no explanation outside the JSON.`;
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
  if (pausedState) {
    chrome.action.setBadgeText({ text: "OFF", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#6b7280", tabId });
    chrome.action.setTitle({ title: "SlopRadar — Paused", tabId });
    return;
  }
  chrome.action.setBadgeText({ text: "ON", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#e02424", tabId });
  chrome.action.setTitle({ title: "SlopRadar — Active", tabId });
}
function setBadgeIdle(tabId) {
  if (pausedState) {
    chrome.action.setBadgeText({ text: "OFF", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#6b7280", tabId });
    return;
  }
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

  // Engine health — lets the popup show whether the local model is ready and
  // whether it has been struggling (consecutive failures).
  if (request.action === "getEngineStatus") {
    let availability = "unknown";
    (async () => {
      try {
        if (typeof LanguageModel !== "undefined" && typeof LanguageModel.availability === "function") {
          availability = await LanguageModel.availability();
        } else if (typeof LanguageModel === "undefined") {
          availability = "unsupported";
        }
      } catch (_) {}
      sendResponse({
        ready: !!aiSession,
        availability,
        recentFailures: consecutiveInferenceFails,
      });
    })();
    return true;
  }

  // Manual kickstart — user-triggered session rebuild from the popup, for
  // when the model gets wedged and they don't want to wait for the auto-retry.
  if (request.action === "kickstartEngine") {
    recoverEngine("manual kickstart from popup").then(ok => {
      // Nudge any open supported tabs to retry their pending queues.
      if (ok) drainQueue();
      sendResponse({ ok });
    });
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
    learnFromSlop(request.postText).then(res => sendResponse({ ok: true, ...res }));
    return true;
  }

  // Right-click "mark as slop" — page-side text fingerprints into userTaughtPatterns
  if (request.action === "teachMissedPost") {
    teachFromMissedPost(request.postText).then(res => sendResponse(res));
    return true;
  }

  // confirm-slop button — same as learnFromSlop, writes to slopPatterns
  if (request.action === "confirmSlop") {
    learnFromSlop(request.postText).then(res => sendResponse({ ok: true, ...res }));
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
    unlearnFromPost(request.postText).then(async res => {
      if (res.ok && (res.removed > 0 || res.narrowed > 0)) {
        await appendNotSlopLog({
          snippet: (request.postText || "").substring(0, 80),
          removed: res.removed,
          narrowed: res.narrowed,
          removedPatterns: res.removedPatterns || [],
          narrowedPatterns: res.narrowedPatterns || [],
          reasoning: res.reasoning || "",
        });
      }
      sendResponse(res);
    });
    return true;
  }

  if (request.action === "getNotSlopLog") {
    getNotSlopLog().then(log => sendResponse({ log }));
    return true;
  }

  if (request.action === "clearNotSlopLog") {
    storageSet({ notSlopLog: [] }).then(() => sendResponse({ ok: true }));
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
    if (!aiSession) {
      // Engine not ready — tell the content side to retry rather than
      // stamping a fake confidence-50 verdict (the bug we fixed in the
      // drain loop, repeated here). Kick init in case it never started.
      initEngine();
      sendResponse({ degraded: true });
      return true;
    }
    const tabId = request.tabId ?? sender.tab?.id ?? -1;
    enqueue(tabId, request.text, sendResponse, request.platform);
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
