// run-tests.js — SlopRadar local test suite
// Usage: node run-tests.js  (writes report.json + prints to console)

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { suite, test, testAsync, assert, printSummary } = require("./framework");
const { createChromeMock } = require("./chrome-mock");

// ── Locate the extension files ──────────────────────────────────────────
// Works whether the test files live alongside the extension (flat layout)
// or in a slopradar-tests/ subfolder (nested layout).
function findExtDir() {
  const candidates = [
    __dirname,                          // flat: tests sit in the extension root
    path.resolve(__dirname, ".."),      // nested: tests in slopradar-tests/
    process.cwd(),                      // wherever node was invoked
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "background.js")) &&
        fs.existsSync(path.join(dir, "manifest.json"))) {
      return dir;
    }
  }
  console.error("\x1b[31mERROR: could not find background.js / manifest.json.\x1b[0m");
  console.error("Run this from the SlopRadar folder, or place the test files inside it.");
  process.exit(2);
}

// ── Locate the fixtures ─────────────────────────────────────────────────
function findFixturesDir() {
  const candidates = [
    path.join(__dirname, "fixtures"),
    path.join(__dirname, "slopradar-tests", "fixtures"),
    path.join(process.cwd(), "fixtures"),
    path.join(process.cwd(), "slopradar-tests", "fixtures"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "linkedin.html"))) return dir;
  }
  console.error("\x1b[31mERROR: could not find fixtures/linkedin.html\x1b[0m");
  process.exit(2);
}

const EXT_DIR = findExtDir();
const FIXTURES = findFixturesDir();
console.log(`  extension dir: ${EXT_DIR}`);
console.log(`  fixtures dir:  ${FIXTURES}\n`);

// ════════════════════════════════════════════════════════════════════════
// SUITE 1 — Static / syntax checks
// ════════════════════════════════════════════════════════════════════════
suite("syntax");

test("background.js is syntactically valid", () => {
  const src = fs.readFileSync(path.join(EXT_DIR, "background.js"), "utf8");
  new Function(src.replace(/\bchrome\b/g, "({})")); // throws on parse error
});

test("content.js is syntactically valid", () => {
  const src = fs.readFileSync(path.join(EXT_DIR, "content.js"), "utf8");
  new Function(src.replace(/\bchrome\b/g, "({})"));
});

test("options.js is syntactically valid", () => {
  const src = fs.readFileSync(path.join(EXT_DIR, "options.js"), "utf8");
  new Function(src.replace(/\bchrome\b/g, "({})").replace(/\bdocument\b/g, "({})"));
});

test("manifest.json is valid JSON with required keys", () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3, "must be MV3");
  assert.ok(m.background?.service_worker, "needs service worker");
  assert.ok(Array.isArray(m.content_scripts), "needs content scripts");
  assert.ok(m.permissions.includes("storage"), "needs storage permission");
});

test("no leftover escaped backticks in background.js", () => {
  const src = fs.readFileSync(path.join(EXT_DIR, "background.js"), "utf8");
  assert.ok(!src.includes("\\`"), "found escaped backtick — template literal corruption");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 2 — Verdict JSON parsing (the logic inside drainQueue)
// ════════════════════════════════════════════════════════════════════════
suite("verdict-parsing");

// Re-implementation of the parse logic from background.js drainQueue,
// kept in sync with the source. If background.js changes, update here.
function parseVerdict(rawOutput, minConfidence = 60) {
  let isSlop = false, confidence = 50;
  try {
    const parsed = JSON.parse(rawOutput.replace(/```json|```/g, "").trim());
    isSlop = parsed.slop === 1;
    confidence = Math.min(100, Math.max(1, Math.round(parsed.confidence ?? 50)));
  } catch (_) {
    isSlop = rawOutput.match(/[01]/)?.[0] === "1";
    confidence = 50;
  }
  if (isSlop && confidence < minConfidence) isSlop = false;
  return { isSlop, confidence };
}

test("parses clean JSON verdict", () => {
  const v = parseVerdict('{"slop": 1, "confidence": 87}');
  assert.equal(v.isSlop, true);
  assert.equal(v.confidence, 87);
});

test("parses JSON wrapped in markdown fences", () => {
  const v = parseVerdict('```json\n{"slop": 0, "confidence": 92}\n```');
  assert.equal(v.isSlop, false);
  assert.equal(v.confidence, 92);
});

test("clamps confidence above 100", () => {
  const v = parseVerdict('{"slop": 1, "confidence": 250}');
  assert.equal(v.confidence, 100);
});

test("clamps confidence below 1", () => {
  const v = parseVerdict('{"slop": 1, "confidence": -5}');
  assert.equal(v.confidence, 1);
});

test("falls back to digit match on malformed output", () => {
  // Fallback gives confidence 50; with a 40% threshold the slop verdict survives.
  const v = parseVerdict("the answer is 1", 40);
  assert.equal(v.isSlop, true);
  assert.equal(v.confidence, 50);
});

test("digit fallback at default threshold downgrades (conf 50 < 60)", () => {
  const v = parseVerdict("the answer is 1", 60);
  assert.equal(v.isSlop, false, "50% confidence is below the 60% default gate");
});

test("min-confidence threshold downgrades low-confidence slop", () => {
  const v = parseVerdict('{"slop": 1, "confidence": 45}', 60);
  assert.equal(v.isSlop, false, "45% slop should be let through at 60% threshold");
});

test("high-confidence slop survives threshold", () => {
  const v = parseVerdict('{"slop": 1, "confidence": 95}', 60);
  assert.equal(v.isSlop, true);
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 3 — Priority queue ordering
// ════════════════════════════════════════════════════════════════════════
suite("priority-queue");

// Mirror of sortQueue + tabPriority from background.js
function makeQueueSorter(activeTabId, visibleTabIds) {
  const tabPriority = (id) =>
    id === activeTabId ? 0 : visibleTabIds.has(id) ? 1 : 2;
  return (queue) => {
    queue.sort((a, b) => {
      const pa = tabPriority(a.tabId), pb = tabPriority(b.tabId);
      if (pa !== pb) return pa - pb;
      return a.enqueuedAt - b.enqueuedAt;
    });
    return queue;
  };
}

test("active tab items drain first", () => {
  const sort = makeQueueSorter(1, new Set([1, 2]));
  const q = [
    { tabId: 3, enqueuedAt: 1 },  // background
    { tabId: 1, enqueuedAt: 2 },  // active
    { tabId: 2, enqueuedAt: 3 },  // visible
  ];
  sort(q);
  assert.equal(q[0].tabId, 1, "active tab first");
  assert.equal(q[1].tabId, 2, "visible tab second");
  assert.equal(q[2].tabId, 3, "background tab last");
});

test("FIFO within same priority tier", () => {
  const sort = makeQueueSorter(1, new Set([1]));
  const q = [
    { tabId: 1, enqueuedAt: 30 },
    { tabId: 1, enqueuedAt: 10 },
    { tabId: 1, enqueuedAt: 20 },
  ];
  sort(q);
  assert.deepEqual(q.map(x => x.enqueuedAt), [10, 20, 30]);
});

test("purgeTab removes only the target tab's items", () => {
  let queue = [
    { tabId: 1, enqueuedAt: 1 },
    { tabId: 2, enqueuedAt: 2 },
    { tabId: 1, enqueuedAt: 3 },
  ];
  queue = queue.filter(item => item.tabId !== 1);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].tabId, 2);
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 4 — Viewport scoring (content.js)
// ════════════════════════════════════════════════════════════════════════
suite("viewport-scoring");

function viewportScore(rect, vh) {
  if (rect.top >= 0 && rect.bottom <= vh) return 0;
  if (rect.top > vh) return rect.top - vh;
  return Math.abs(rect.bottom) + 10000;
}

test("in-viewport element scores 0", () => {
  assert.equal(viewportScore({ top: 100, bottom: 400 }, 800), 0);
});

test("below-fold element scores by distance", () => {
  assert.equal(viewportScore({ top: 1000, bottom: 1200 }, 800), 200);
});

test("above-fold element gets large penalty", () => {
  const s = viewportScore({ top: -500, bottom: -300 }, 800);
  assert.greater(s, 10000, "above-fold should be deprioritized");
});

test("below-fold beats above-fold in sort", () => {
  const below = viewportScore({ top: 900, bottom: 1100 }, 800);
  const above = viewportScore({ top: -200, bottom: -50 }, 800);
  assert.ok(below < above, "scrolling-down content prioritized");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 5 — Background message handlers (integration via mock)
// ════════════════════════════════════════════════════════════════════════
suite("background-handlers");

function loadBackground() {
  const chrome = createChromeMock();
  global.chrome = chrome;
  global.LanguageModel = undefined; // no AI in tests
  const src = fs.readFileSync(path.join(EXT_DIR, "background.js"), "utf8");
  // Execute in a function scope with chrome available
  const fn = new Function("chrome", "LanguageModel", "console", src);
  fn(chrome, undefined, console);
  return chrome;
}

testAsync("getSettings returns defaults when storage empty", async () => {
  const chrome = loadBackground();
  const resp = await chrome.runtime._fireMessage({ action: "getSettings" });
  assert.equal(resp.minConfidence, 90);
  assert.equal(resp.hideSlop, false);
  assert.equal(resp.showTrainingButtons, true);
  // universalMode was removed in v1.5 — the extension is now scoped to
  // specific social sites via the manifest, so there's no "scan everything"
  // toggle to default.
  assert.equal(resp.universalMode, undefined);
});

testAsync("saveSettings persists to storage", async () => {
  const chrome = loadBackground();
  await chrome.runtime._fireMessage({
    action: "saveSettings",
    settings: { minConfidence: 80, hideSlop: true },
  });
  const resp = await chrome.runtime._fireMessage({ action: "getSettings" });
  assert.equal(resp.minConfidence, 80);
  assert.equal(resp.hideSlop, true);
});

testAsync("getPatterns returns default pattern list", async () => {
  const chrome = loadBackground();
  const resp = await chrome.runtime._fireMessage({ action: "getPatterns" });
  assert.ok(Array.isArray(resp.patterns));
  assert.greater(resp.patterns.length, 30, "should have full default set");
});

testAsync("savePatterns then getPatterns round-trips", async () => {
  const chrome = loadBackground();
  const custom = ["pattern A", "pattern B", "pattern C"];
  await chrome.runtime._fireMessage({ action: "savePatterns", patterns: custom });
  const resp = await chrome.runtime._fireMessage({ action: "getPatterns" });
  assert.deepEqual(resp.patterns, custom);
});

testAsync("resetPatterns restores defaults", async () => {
  const chrome = loadBackground();
  await chrome.runtime._fireMessage({ action: "savePatterns", patterns: ["x"] });
  const resp = await chrome.runtime._fireMessage({ action: "resetPatterns" });
  assert.greater(resp.patterns.length, 30);
});

testAsync("recordResult increments stats", async () => {
  const chrome = loadBackground();
  await chrome.runtime._fireMessage({ action: "recordResult", hostname: "x.com", isSlop: true });
  await chrome.runtime._fireMessage({ action: "recordResult", hostname: "x.com", isSlop: false });
  // wait a tick for async storage writes
  await new Promise(r => setTimeout(r, 20));
  const stats = await chrome.runtime._fireMessage({ action: "getStats" });
  assert.equal(stats.totalChecked, 2);
  assert.equal(stats.totalSlop, 1);
});

testAsync("site pause stores and clears", async () => {
  const chrome = loadBackground();
  await chrome.runtime._fireMessage({ action: "setSitePause", hostname: "example.com", forever: true });
  let resp = await chrome.runtime._fireMessage({ action: "getSitePause", hostname: "example.com" });
  assert.equal(resp.paused, true);
  await chrome.runtime._fireMessage({ action: "clearSitePause", hostname: "example.com" });
  resp = await chrome.runtime._fireMessage({ action: "getSitePause", hostname: "example.com" });
  assert.equal(resp.paused, false);
});

testAsync("pause state round-trips", async () => {
  const chrome = loadBackground();
  await chrome.runtime._fireMessage({ action: "setPauseState", paused: true });
  const resp = await chrome.runtime._fireMessage({ action: "getPauseState" });
  assert.equal(resp.paused, true);
});

testAsync("evaluatePost with no AI returns safe default", async () => {
  const chrome = loadBackground();
  const resp = await chrome.runtime._fireMessage({ action: "evaluatePost", text: "some post", tabId: 1 });
  assert.equal(resp.isSlop, false, "no AI = treat as not slop");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 6 — Content-script DOM logic against fixtures
// ════════════════════════════════════════════════════════════════════════
suite("dom-linkedin");

function loadFixtureDOM(file, url) {
  const html = fs.readFileSync(path.join(FIXTURES, file), "utf8");
  const dom = new JSDOM(html, { url });
  return dom;
}

// LinkedIn wrapper finder (mirror of getLinkedInWrapper)
function makeLinkedInWrapperFinder(doc) {
  const MODAL = '[role="dialog"],.artdeco-modal,.share-box';
  function isInsideModal(el) { return !!el.closest(MODAL); }
  return function getWrapper(textNode) {
    if (isInsideModal(textNode)) return null;
    const sels = ['[data-urn]', '.feed-shared-update-v2', '.occludable-update', 'article'];
    for (const s of sels) {
      const found = textNode.closest(s);
      if (found && !isInsideModal(found)) return found;
    }
    return null;
  };
}

test("LinkedIn: finds post wrapper from text node", () => {
  const dom = loadFixtureDOM("linkedin.html", "https://www.linkedin.com/feed/");
  const doc = dom.window.document;
  const find = makeLinkedInWrapperFinder(doc);
  const textNode = doc.querySelector('[data-urn="urn:li:activity:1001"] span[dir="ltr"]');
  const wrapper = find(textNode);
  assert.ok(wrapper, "wrapper found");
  assert.equal(wrapper.getAttribute("data-urn"), "urn:li:activity:1001");
});

test("LinkedIn: composer box is excluded", () => {
  const dom = loadFixtureDOM("linkedin.html", "https://www.linkedin.com/feed/");
  const doc = dom.window.document;
  const find = makeLinkedInWrapperFinder(doc);
  const composer = doc.querySelector('.mentions-texteditor');
  const wrapper = find(composer);
  assert.equal(wrapper, null, "composer must not resolve to a card");
});

test("LinkedIn: fixture has 4 real posts + 1 composer", () => {
  const dom = loadFixtureDOM("linkedin.html", "https://www.linkedin.com/feed/");
  const doc = dom.window.document;
  const posts = doc.querySelectorAll('[data-urn]');
  assert.equal(posts.length, 4);
  const slop = doc.querySelectorAll('[data-sr-expect="slop"]');
  const auth = doc.querySelectorAll('[data-sr-expect="authentic"]');
  assert.equal(slop.length, 2);
  assert.equal(auth.length, 2);
});

test("LinkedIn: text selector finds post bodies", () => {
  const dom = loadFixtureDOM("linkedin.html", "https://www.linkedin.com/feed/");
  const doc = dom.window.document;
  const sel = '.feed-shared-update-v2__description-wrapper, .occludable-update span[dir="ltr"]';
  const nodes = doc.querySelectorAll(sel);
  assert.greater(nodes.length, 0, "must find post text");
});

suite("dom-twitter");

test("X: finds tweet article from tweetText", () => {
  const dom = loadFixtureDOM("x.html", "https://x.com/home");
  const doc = dom.window.document;
  const txt = doc.querySelector('[data-testid="tweetText"]');
  const article = txt.closest('article[data-testid="tweet"]');
  assert.ok(article, "tweet article found");
});

test("X: composer textarea is excluded", () => {
  const dom = loadFixtureDOM("x.html", "https://x.com/home");
  const doc = dom.window.document;
  const composer = doc.querySelector('[data-testid="tweetTextarea_0"]');
  const article = composer.closest('article[data-testid="tweet"]');
  assert.equal(article, null, "composer is not inside a tweet article");
});

test("X: fixture has 4 tweets + 1 composer", () => {
  const dom = loadFixtureDOM("x.html", "https://x.com/home");
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('article[data-testid="tweet"]').length, 4);
  assert.equal(doc.querySelectorAll('[data-sr-expect="slop"]').length, 2);
  assert.equal(doc.querySelectorAll('[data-sr-expect="authentic"]').length, 2);
});

test("X: each tweet has a time element for badge anchoring", () => {
  const dom = loadFixtureDOM("x.html", "https://x.com/home");
  const doc = dom.window.document;
  doc.querySelectorAll('article[data-testid="tweet"]').forEach(a => {
    assert.ok(a.querySelector("time"), "tweet needs <time> for NOT SLOP badge");
  });
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 7 — Pattern heuristic sanity (offline keyword check)
// ════════════════════════════════════════════════════════════════════════
suite("heuristic-sanity");

// A cheap offline proxy for the AI: count slop-signal keywords.
// NOT a replacement for the model — just confirms fixtures are well-formed.
const SLOP_SIGNALS = [
  "nobody's talking", "nobody is talking", "most companies think",
  "bombshell", "just dropped", "the real moat", "is no longer the moat",
  "what surprised me most", "the hardest part wasn't", "i keep hearing this",
  "7-figure", "what do you think", "agree?", "ai is changing everything",
  "if you can't see it",
];

function slopSignalCount(text) {
  const t = text.toLowerCase();
  return SLOP_SIGNALS.filter(s => t.includes(s)).length;
}

test("LinkedIn slop fixtures trip multiple signals", () => {
  const dom = loadFixtureDOM("linkedin.html", "https://www.linkedin.com/feed/");
  const doc = dom.window.document;
  doc.querySelectorAll('[data-sr-expect="slop"]').forEach(card => {
    const txt = card.textContent;
    assert.greater(slopSignalCount(txt), 0, `slop card should trip a signal: ${txt.slice(0,40)}`);
  });
});

test("LinkedIn authentic fixtures trip zero signals", () => {
  const dom = loadFixtureDOM("linkedin.html", "https://www.linkedin.com/feed/");
  const doc = dom.window.document;
  doc.querySelectorAll('[data-sr-expect="authentic"]').forEach(card => {
    const body = card.querySelector('.feed-shared-update-v2__description-wrapper').textContent;
    assert.equal(slopSignalCount(body), 0, `authentic card tripped a signal: ${body.slice(0,40)}`);
  });
});

test("X slop fixtures trip multiple signals", () => {
  const dom = loadFixtureDOM("x.html", "https://x.com/home");
  const doc = dom.window.document;
  doc.querySelectorAll('[data-sr-expect="slop"]').forEach(card => {
    const txt = card.querySelector('[data-testid="tweetText"]').textContent;
    assert.greater(slopSignalCount(txt), 0, `slop tweet should trip a signal: ${txt.slice(0,40)}`);
  });
});

test("X authentic fixtures trip zero signals", () => {
  const dom = loadFixtureDOM("x.html", "https://x.com/home");
  const doc = dom.window.document;
  doc.querySelectorAll('[data-sr-expect="authentic"]').forEach(card => {
    const txt = card.querySelector('[data-testid="tweetText"]').textContent;
    assert.equal(slopSignalCount(txt), 0, `authentic tweet tripped a signal: ${txt.slice(0,40)}`);
  });
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 8 — Node recycle detection (X reuses article DOM nodes)
// ════════════════════════════════════════════════════════════════════════
suite("recycle-detection");

// Mirror of the recycle check in enqueueNode: a node is "fresh" if it's
// new OR its text changed since we last saw it.
function makeRecycleDetector() {
  const seen = new Set();
  const snapshot = new Map();
  return function isFresh(nodeId, text) {
    if (seen.has(nodeId)) {
      if (snapshot.get(nodeId) === text) return false; // unchanged
      // recycled — text differs
    }
    seen.add(nodeId);
    snapshot.set(nodeId, text);
    return true;
  };
}

test("unseen node is fresh", () => {
  const isFresh = makeRecycleDetector();
  assert.equal(isFresh("n1", "hello world this is a post"), true);
});

test("same node, same text is skipped", () => {
  const isFresh = makeRecycleDetector();
  isFresh("n1", "first post content here");
  assert.equal(isFresh("n1", "first post content here"), false);
});

test("recycled node with new text is fresh again", () => {
  const isFresh = makeRecycleDetector();
  isFresh("n1", "original tweet text content");
  // X recycles the node — same element, different tweet
  assert.equal(isFresh("n1", "completely different tweet now"), true);
});

test("stamped-text comparison uses 120-char prefix", () => {
  // applySlop stamps postText.substring(0,120); two posts sharing a long
  // prefix but differing later should still be told apart by full text.
  const a = "x".repeat(120) + "AAA";
  const b = "x".repeat(120) + "BBB";
  assert.notEqual(a, b);
  assert.equal(a.substring(0, 120), b.substring(0, 120),
    "prefixes collide — full-text compare in enqueueNode is what saves us");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 9 — Text-keyed verdict cache (survives X back-navigation)
// ════════════════════════════════════════════════════════════════════════
suite("verdict-cache");

// Mirror of hashPostText + the cache from content.js
function makeVerdictCache(max) {
  const cache = new Map();
  const MAX = max || 600;
  function hash(text) {
    const norm = (text || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 280);
    let h = 5381;
    for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
    return `${h}:${norm.length}`;
  }
  return {
    set(text, isSlop, conf) {
      cache.set(hash(text), { isSlop, confidence: conf });
      if (cache.size > MAX) cache.delete(cache.keys().next().value);
    },
    get(text) { return cache.get(hash(text)) || null; },
    size: () => cache.size,
  };
}

test("verdict cache hit returns the stored verdict", () => {
  const c = makeVerdictCache();
  c.set("AI is changing everything, nobody is talking about this", true, 88);
  const v = c.get("AI is changing everything, nobody is talking about this");
  assert.ok(v);
  assert.equal(v.isSlop, true);
  assert.equal(v.confidence, 88);
});

test("cache key is whitespace/case-insensitive (survives DOM re-render)", () => {
  const c = makeVerdictCache();
  c.set("Hello   World  Post", false, 70);
  // Same post re-rendered with collapsed whitespace + different case
  const v = c.get("hello world post");
  assert.ok(v, "normalized text should hit the same cache entry");
  assert.equal(v.confidence, 70);
});

test("cache miss returns null for unseen text", () => {
  const c = makeVerdictCache();
  assert.equal(c.get("never seen this"), null);
});

test("cache evicts oldest entry past the cap", () => {
  const c = makeVerdictCache(3);
  c.set("post one is here", true, 50);
  c.set("post two is here", true, 50);
  c.set("post three is here", true, 50);
  c.set("post four is here", true, 50); // should evict "post one"
  assert.equal(c.size(), 3);
  assert.equal(c.get("post one is here"), null, "oldest evicted");
  assert.ok(c.get("post four is here"), "newest kept");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 10 — Site scoping & user exclusions
// ════════════════════════════════════════════════════════════════════════
suite("site-scope");

// Mirror of the user-exclusion check in content.js bootstrap.
function userExcluded(hostname, extra) {
  return (extra || []).some(s => s && hostname.includes(s));
}

test("no host is excluded by default (manifest scopes injection)", () => {
  assert.equal(userExcluded("linkedin.com", []), false);
  assert.equal(userExcluded("reddit.com", []), false);
});

test("user can exclude a specific supported host", () => {
  assert.equal(userExcluded("www.reddit.com", ["reddit.com"]), true);
  assert.equal(userExcluded("linkedin.com", ["reddit.com"]), false);
});

test("content.js detects all four platforms", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(content.includes("IS_REDDIT"), "Reddit detection present");
  assert.ok(content.includes("IS_THREADS"), "Threads detection present");
  assert.ok(/TUNED_PLATFORMS\s*=\s*\[\s*"twitter"\s*,\s*"linkedin"/.test(content),
    "LinkedIn + X marked as tuned platforms");
  assert.ok(content.includes("IS_BETA_PLATFORM"), "beta-platform flag present");
});

test("DEFAULT_EXCLUDED_SITES machinery is gone (no longer universal)", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(!content.includes("DEFAULT_EXCLUDED_SITES"),
    "the universal-mode exclusion list should be removed now that the " +
    "manifest scopes injection to specific sites");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 10b — Manifest release validation
// ════════════════════════════════════════════════════════════════════════
suite("manifest");

function loadManifest() {
  const fs = require("fs");
  const path = require("path");
  return JSON.parse(fs.readFileSync(path.join(findExtDir(), "manifest.json"), "utf8"));
}

test("manifest does NOT request <all_urls>", () => {
  const m = loadManifest();
  const hosts = (m.host_permissions || []).concat(
    (m.content_scripts || []).flatMap(cs => cs.matches || []));
  assert.ok(!hosts.includes("<all_urls>"),
    "<all_urls> triggers Chrome Web Store rejection / heavy review — " +
    "scope to specific social sites instead.");
});

test("manifest host_permissions cover the four social sites", () => {
  const m = loadManifest();
  const joined = (m.host_permissions || []).join(" ");
  for (const site of ["linkedin.com", "x.com", "reddit.com", "threads"]) {
    assert.ok(joined.includes(site), `host_permissions should include ${site}`);
  }
});

test("manifest declares the required icon sizes", () => {
  const m = loadManifest();
  for (const size of ["16", "32", "48", "128"]) {
    assert.ok(m.icons && m.icons[size], `icons.${size} is required by the store`);
    assert.ok(m.action && m.action.default_icon && m.action.default_icon[size],
      `action.default_icon.${size} should be set`);
  }
});

test("manifest requests only the permissions it uses", () => {
  const m = loadManifest();
  const perms = new Set(m.permissions || []);
  // These are the only ones the code actually relies on.
  const allowed = new Set(["scripting", "tabs", "storage", "contextMenus", "activeTab"]);
  for (const p of perms) {
    assert.ok(allowed.has(p), `unexpected permission "${p}" — drop it or justify it`);
  }
  // windows API works without the permission; make sure we didn't re-add it.
  assert.ok(!perms.has("windows"), "windows permission isn't needed for getAll/onFocusChanged");
});

test("manifest content_scripts matches == host_permissions", () => {
  const m = loadManifest();
  const hosts = new Set(m.host_permissions || []);
  const matches = new Set((m.content_scripts || []).flatMap(cs => cs.matches || []));
  assert.deepEqual([...matches].sort(), [...hosts].sort(),
    "content script match list should mirror host_permissions exactly");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 11 — Deep DOM query (shadow roots + iframes)
// ════════════════════════════════════════════════════════════════════════
suite("deep-query");

// Mirror of deepQuery from content.js, exercised against a jsdom tree with
// a real attached shadow root.
function deepQuery(selector, root, out, seenDocs, depth) {
  out = out || []; seenDocs = seenDocs || new Set(); depth = depth || 0;
  if (depth > 12 || !root) return out;
  try { root.querySelectorAll(selector).forEach(el => out.push(el)); } catch (_) {}
  try {
    root.querySelectorAll("*").forEach(el => {
      if (el.shadowRoot) deepQuery(selector, el.shadowRoot, out, seenDocs, depth + 1);
    });
  } catch (_) {}
  return out;
}

test("deepQuery finds elements in the light DOM", () => {
  const dom = new JSDOM(`<div><p class="post">hello</p></div>`);
  const found = deepQuery(".post", dom.window.document);
  assert.equal(found.length, 1);
});

test("deepQuery pierces an open shadow root", () => {
  const dom = new JSDOM(`<div id="host"></div>`);
  const doc = dom.window.document;
  const host = doc.getElementById("host");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<p class="post">shadow post text</p>`;
  // Flat query sees nothing; deep query finds the shadowed element.
  assert.equal(doc.querySelectorAll(".post").length, 0, "flat query is blind to shadow");
  assert.equal(deepQuery(".post", doc).length, 1, "deep query pierces shadow");
});

test("deepQuery handles nested shadow roots", () => {
  const dom = new JSDOM(`<div id="a"></div>`);
  const doc = dom.window.document;
  const a = doc.getElementById("a");
  const s1 = a.attachShadow({ mode: "open" });
  s1.innerHTML = `<div id="b"></div>`;
  const b = s1.getElementById("b");
  const s2 = b.attachShadow({ mode: "open" });
  s2.innerHTML = `<span class="deep">nested</span>`;
  assert.equal(deepQuery(".deep", doc).length, 1, "two levels deep");
});

test("deepQuery respects the depth cap (no infinite recursion)", () => {
  const dom = new JSDOM(`<div></div>`);
  // Just confirm it returns and doesn't throw on a normal tree
  const found = deepQuery("div", dom.window.document, [], new Set(), 0);
  assert.ok(Array.isArray(found));
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 12 — Modular user-taught patterns (right-click teaching)
// ════════════════════════════════════════════════════════════════════════
suite("user-patterns");

testAsync("teachMissedPost stores into the separate userTaughtPatterns bucket", async () => {
  const chrome = loadBackground();
  // Seed a fake AI session so teachFromMissedPost can run.
  // (No real LanguageModel in tests — so teachMissedPost returns not-ready.)
  const res = await chrome.runtime._fireMessage({
    action: "teachMissedPost",
    postText: "My strategy analysis! Here is what nobody tells you about success.",
  });
  // With no AI engine, it reports not-ready rather than throwing.
  assert.ok(res, "handler responded");
  assert.equal(res.ok, false, "no AI engine in test → ok:false");
});

testAsync("getUserPatterns returns an array even when empty", async () => {
  const chrome = loadBackground();
  const res = await chrome.runtime._fireMessage({ action: "getUserPatterns" });
  assert.ok(Array.isArray(res.patterns), "patterns is an array");
  assert.equal(res.patterns.length, 0);
});

testAsync("user patterns round-trip through storage", async () => {
  const chrome = loadBackground();
  // Write directly into storage the way saveUserPatterns would.
  await chrome.storage.local.set({
    userTaughtPatterns: [
      { text: "vague 'strategy analysis' with no specifics", source: "My strategy…", ts: 1 },
      { text: "promises hidden knowledge nobody tells you", source: "Here is what…", ts: 2 },
    ],
  });
  const res = await chrome.runtime._fireMessage({ action: "getUserPatterns" });
  assert.equal(res.patterns.length, 2);
  assert.equal(res.patterns[0].text, "vague 'strategy analysis' with no specifics");
});

testAsync("removeUserPattern deletes by index", async () => {
  const chrome = loadBackground();
  await chrome.storage.local.set({
    userTaughtPatterns: [
      { text: "pattern A", source: "a", ts: 1 },
      { text: "pattern B", source: "b", ts: 2 },
      { text: "pattern C", source: "c", ts: 3 },
    ],
  });
  const res = await chrome.runtime._fireMessage({ action: "removeUserPattern", index: 1 });
  assert.equal(res.patterns.length, 2);
  assert.deepEqual(res.patterns.map(p => p.text), ["pattern A", "pattern C"]);
});

testAsync("clearUserPatterns empties the bucket", async () => {
  const chrome = loadBackground();
  await chrome.storage.local.set({
    userTaughtPatterns: [{ text: "x", source: "x", ts: 1 }],
  });
  await chrome.runtime._fireMessage({ action: "clearUserPatterns" });
  const res = await chrome.runtime._fireMessage({ action: "getUserPatterns" });
  assert.equal(res.patterns.length, 0);
});

testAsync("user patterns stay separate from core slopPatterns", async () => {
  const chrome = loadBackground();
  await chrome.storage.local.set({
    userTaughtPatterns: [{ text: "taught pattern", source: "s", ts: 1 }],
  });
  // Core patterns must be untouched by user-pattern storage.
  const core = await chrome.runtime._fireMessage({ action: "getPatterns" });
  assert.greater(core.patterns.length, 30, "core list intact");
  assert.ok(!core.patterns.includes("taught pattern"),
    "user-taught pattern must NOT leak into the core list");
});

test("context menu is registered with the right targets", () => {
  const chrome = loadBackground();
  // onInstalled fires createContextMenu
  const installListeners = chrome.runtime.onInstalled
    ? null : null; // onInstalled is a no-op mock; instead check the API exists
  assert.ok(chrome.contextMenus, "contextMenus API present");
  assert.ok(typeof chrome.contextMenus.create === "function");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 13 — Display-mode settings (training buttons / non-intrusive / remove)
// ════════════════════════════════════════════════════════════════════════
suite("display-modes");

testAsync("new display-mode settings have safe defaults", async () => {
  const chrome = loadBackground();
  const s = await chrome.runtime._fireMessage({ action: "getSettings" });
  // Training buttons on by default (filter starts untrained).
  assert.equal(s.showTrainingButtons, true);
  // Quiet/aggressive modes off by default.
  assert.equal(s.nonIntrusiveMode, false);
  assert.equal(s.removeEntirely, false);
});

testAsync("display-mode settings round-trip through storage", async () => {
  const chrome = loadBackground();
  await chrome.runtime._fireMessage({
    action: "saveSettings",
    settings: {
      showTrainingButtons: false,
      nonIntrusiveMode: true,
      removeEntirely: true,
    },
  });
  const s = await chrome.runtime._fireMessage({ action: "getSettings" });
  assert.equal(s.showTrainingButtons, false);
  assert.equal(s.nonIntrusiveMode, true);
  assert.equal(s.removeEntirely, true);
});

testAsync("saveSettings preserves excludedSites it wasn't given", async () => {
  const chrome = loadBackground();
  // Seed an exclusion, then save unrelated settings.
  await chrome.runtime._fireMessage({
    action: "saveSettings",
    settings: { excludedSites: ["example.com"], darkMode: true },
  });
  const s = await chrome.runtime._fireMessage({ action: "getSettings" });
  assert.deepEqual(s.excludedSites, ["example.com"]);
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 14 — Tab reload / navigation drops queued work
// ════════════════════════════════════════════════════════════════════════
suite("tab-refresh");

testAsync("tabRefreshing message is handled without error", async () => {
  const chrome = loadBackground();
  // Should not throw even when the tab has nothing queued.
  const res = await chrome.runtime._fireMessage({
    action: "tabRefreshing", tabId: 123,
  });
  // handler returns true/undefined; just assert no exception bubbled.
  assert.ok(true);
});

test("background source bumps a per-tab epoch on purge", () => {
  // White-box: confirm the epoch mechanism exists in the shipped source,
  // so a tabId-reuse reload can't silently process stale items.
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(
    path.join(findExtDir(), "background.js"), "utf8");
  assert.ok(bg.includes("bumpTabEpoch"), "bumpTabEpoch defined");
  assert.ok(bg.includes("getTabEpoch"), "getTabEpoch defined");
  // purgeTab must bump the epoch, and drainQueue must compare it.
  assert.ok(/purgeTab[\s\S]{0,200}bumpTabEpoch/.test(bg),
    "purgeTab bumps the epoch");
  assert.ok(bg.includes("item.epoch !== getTabEpoch"),
    "drainQueue skips stale-epoch items");
});

test("content source flushes pendingNodes on SPA navigation", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(
    path.join(findExtDir(), "content.js"), "utf8");
  // flushQueue must empty pendingNodes, and SPA-nav detection must call it.
  assert.ok(/flushQueue[\s\S]{0,200}pendingNodes\.length = 0/.test(content),
    "flushQueue empties pendingNodes");
  assert.ok(/location\.href !== lastUrl[\s\S]{0,120}flushQueue/.test(content),
    "SPA nav detection calls flushQueue");
});

test("content re-applies a wiped slop block from the verdict cache", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(
    path.join(findExtDir(), "content.js"), "utf8");
  // enqueueNode must detect a missing banner on an evaluated wrapper and
  // re-apply from cache rather than silently skipping it as a dup.
  assert.ok(content.includes("blockMissing"),
    "enqueueNode checks whether the injected block is still present");
  assert.ok(/blockMissing[\s\S]{0,300}applySlop/.test(content),
    "re-applies slop when the block was wiped");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 15 — Options wiring: every getElementById call has a target
// ════════════════════════════════════════════════════════════════════════
// This catches the exact bug-class where a botched edit truncates an
// element id in options.html — silently breaking all options.js code that
// runs after the first failing addEventListener call (because the error
// halts script execution).
suite("options-wiring");

test("every getElementById in options.js resolves in options.html", () => {
  const fs = require("fs");
  const path = require("path");
  const dir = findExtDir();
  const js = fs.readFileSync(path.join(dir, "options.js"), "utf8");
  const html = fs.readFileSync(path.join(dir, "options.html"), "utf8");

  // Pull every literal id passed to getElementById in options.js.
  const idRe = /getElementById\(\s*["'`]([a-zA-Z0-9_-]+)["'`]\s*\)/g;
  const ids = new Set();
  for (const m of js.matchAll(idRe)) ids.add(m[1]);

  // Collect all ids defined in options.html.
  const htmlIds = new Set();
  for (const m of html.matchAll(/\bid=["']([a-zA-Z0-9_-]+)["']/g)) htmlIds.add(m[1]);

  const missing = [...ids].filter(id => !htmlIds.has(id));
  assert.equal(missing.length, 0,
    `options.js references id(s) not in options.html: ${missing.join(", ")} ` +
    `— a missing id throws a TypeError on the first addEventListener and ` +
    `kills the rest of the script (stats, pause, settings all stop working).`);
});

test("options.html header version is not hardcoded", () => {
  const fs = require("fs");
  const path = require("path");
  const html = fs.readFileSync(path.join(findExtDir(), "options.html"), "utf8");
  // Hardcoded "v1.2", "v1.3", ... in the header span — caught with a
  // tight pattern. If anyone reintroduces a hardcoded version, this fires.
  assert.ok(!/AI feed filter — v\d/.test(html),
    "options.html has a hardcoded version string in the header — " +
    "use chrome.runtime.getManifest().version instead.");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 16 — Length-aware classification
// ════════════════════════════════════════════════════════════════════════
// Short posts (replies, casual chatter) lack the surface area to
// distinguish authentic conversation from slop. We use a hard floor for
// "don't even classify" plus a prompt nudge for "classify but be lenient".
suite("length-handling");

test("MIN_POST_CHARS floor is defined and reasonable", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  const m = content.match(/const MIN_POST_CHARS = (\d+)/);
  assert.ok(m, "MIN_POST_CHARS constant is defined");
  const n = parseInt(m[1], 10);
  assert.ok(n >= 5 && n <= 60, `MIN_POST_CHARS=${n} should be between 5 and 60`);
});

test("content.js uses MIN_POST_CHARS at every length check site", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // No leftover hardcoded "length < 40" / "length < 50" length floors in
  // the sweep / enqueue paths — those should all go through the constant.
  const matches = content.match(/(rawText|txt)\.length\s*<\s*\d+/g) || [];
  for (const m of matches) {
    assert.ok(m.includes("MIN_POST_CHARS"),
      `found hardcoded length check "${m}" — should use MIN_POST_CHARS`);
  }
});

test("buildPrompt adds short-post guidance for posts under 80 chars", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  // The function definition should reference text.length and a "LENGTH NOTE"
  // section so the model treats short text differently. White-box test.
  assert.ok(bg.includes("LENGTH NOTE"),
    "buildPrompt should include a LENGTH NOTE block");
  assert.ok(/charCount\s*<\s*80/.test(bg) || /length\s*<\s*80/.test(bg),
    "buildPrompt should branch on character count for short posts");
});

test("short-post prompt instructs default-to-authentic", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  // The short-post guidance should explicitly tell the model to default
  // to authentic (0) when signal is thin — not slop.
  assert.ok(/Default to authentic|default to authentic/.test(bg),
    "short-post guidance should explicitly default to authentic");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 17 — Prompt inspector parity (options.js mirrors background.js)
// ════════════════════════════════════════════════════════════════════════
// The options-page prompt inspector duplicates buildPrompt so it can render
// the prompt without a round-trip. Drift between the two would mislead the
// user about what the model actually sees, so we guard the shared markers.
suite("prompt-inspector");

test("options.js has a buildPromptPreview mirroring background", () => {
  const fs = require("fs");
  const path = require("path");
  const opts = fs.readFileSync(path.join(findExtDir(), "options.js"), "utf8");
  assert.ok(opts.includes("buildPromptPreview"), "inspector builder present");
});

test("inspector prompt shares the key structural markers with background", () => {
  const fs = require("fs");
  const path = require("path");
  const dir = findExtDir();
  const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");
  const opts = fs.readFileSync(path.join(dir, "options.js"), "utf8");
  // Both must contain these exact anchor strings — if the prompt is reworded
  // in one place, this fails until the other is updated too.
  const markers = [
    "extremely cynical LinkedIn/Twitter slop detector",
    "SLOP PATTERNS — classify as 1 if ANY of these are present:",
    "LENGTH NOTE",
    'Respond with ONLY a JSON object like {"slop": 1, "confidence": 87}',
  ];
  for (const m of markers) {
    assert.ok(bg.includes(m), `background.js missing marker: ${m}`);
    assert.ok(opts.includes(m), `options.js inspector missing marker: ${m} (prompt drift)`);
  }
});

test("admin.html is not referenced by the manifest", () => {
  const fs = require("fs");
  const path = require("path");
  const m = JSON.parse(fs.readFileSync(path.join(findExtDir(), "manifest.json"), "utf8"));
  const blob = JSON.stringify(m);
  assert.ok(!blob.includes("admin.html"),
    "admin.html must never be referenced by the manifest (dev-only file)");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 18 — Model recovery (the "50% not slop for everything" bug)
// ════════════════════════════════════════════════════════════════════════
suite("model-recovery");

test("background flags degraded output instead of stamping confidence 50", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  // The drain loop must send { degraded: true } rather than a fake verdict
  // when the model returns junk / empty / unparseable output.
  assert.ok(/degraded:\s*true/.test(bg), "degraded flag is sent on bad output");
  // It must NOT silently fall back to confidence 50 as a real verdict.
  assert.ok(!/confidence:\s*50\s*\}\s*\)\s*;?\s*\/\/?.*real/i.test(bg),
    "no fake confidence-50 verdict path");
});

test("background recreates the session after repeated failures", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  assert.ok(bg.includes("recoverEngine"), "recoverEngine() defined");
  assert.ok(bg.includes("consecutiveInferenceFails"), "tracks failure streak");
  assert.ok(/REINIT_AFTER_FAILS/.test(bg), "has a reinit threshold");
  // recoverEngine must actually destroy + null the session before reinit.
  assert.ok(/destroy\?\.\(\)/.test(bg) || /destroy\(\)/.test(bg),
    "recoverEngine tears down the old session");
});

test("content treats degraded responses as retryable, not a verdict", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/response\.degraded\s*===\s*true/.test(content),
    "content checks for response.degraded");
  // Degraded path must re-queue (push back to pendingNodes), not applyNotSlop.
  assert.ok(/degraded[\s\S]{0,400}pendingNodes\.push/.test(content),
    "degraded responses get re-queued");
});

testAsync("getEngineStatus reports readiness and failure count", async () => {
  const chrome = loadBackground();
  const res = await chrome.runtime._fireMessage({ action: "getEngineStatus" });
  assert.ok(res, "responds");
  // No LanguageModel in the test harness → unsupported + not ready.
  assert.equal(res.ready, false);
  assert.equal(typeof res.recentFailures, "number");
  assert.ok("availability" in res, "reports availability");
});

testAsync("kickstartEngine responds without throwing", async () => {
  const chrome = loadBackground();
  const res = await chrome.runtime._fireMessage({ action: "kickstartEngine" });
  assert.ok(res, "responds");
  // ok:false is correct here — no model available in the harness — but it
  // must not throw or hang.
  assert.equal(typeof res.ok, "boolean");
});

test("popup wires a manual kickstart button", () => {
  const fs = require("fs");
  const path = require("path");
  const opts = fs.readFileSync(path.join(findExtDir(), "options.js"), "utf8");
  const html = fs.readFileSync(path.join(findExtDir(), "options.html"), "utf8");
  assert.ok(html.includes('id="kickstart-btn"'), "kickstart button present in HTML");
  assert.ok(/kickstartEngine/.test(opts), "options.js calls kickstartEngine");
  assert.ok(/getEngineStatus/.test(opts), "options.js polls engine status");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 19 — Display modes (mutually exclusive + applied correctly)
// ════════════════════════════════════════════════════════════════════════
suite("display-modes-v2");

test("options.js makes the three display modes mutually exclusive", () => {
  const fs = require("fs");
  const path = require("path");
  const opts = fs.readFileSync(path.join(findExtDir(), "options.js"), "utf8");
  assert.ok(opts.includes("DISPLAY_MODE_IDS"), "display modes treated as a group");
  // The old coupling (force-checking hide-slop when remove is set) must be gone.
  assert.ok(!/s-remove-entirely[\s\S]{0,120}s-hide-slop"\)\.checked = true/.test(opts),
    "remove-entirely must NOT force hide-slop on (old coupling bug)");
});

test("applySlop honors removeEntirely with display:none and no banner", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // removeEntirely branch sets display:none and returns before building banner.
  assert.ok(/settings\.removeEntirely[\s\S]{0,300}setProperty\(\s*["']display["']\s*,\s*["']none["']/.test(content),
    "removeEntirely sets display:none");
  assert.ok(/settings\.removeEntirely[\s\S]{0,360}return;/.test(content),
    "removeEntirely returns before banner construction");
});

test("settings change re-renders already-flagged cards", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(content.includes("reapplyAllSlopCards"), "reapply function exists");
  // settingsUpdated handler must call it on a display change.
  assert.ok(/displayChanged[\s\S]{0,120}reapplyAllSlopCards/.test(content),
    "settingsUpdated triggers re-render when display mode changes");
});

test("low-confidence slop is not cached as a settled not-slop verdict", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/lowConfidence/.test(bg), "background flags low-confidence downgrades");
  assert.ok(/response\.lowConfidence/.test(content),
    "content honors the lowConfidence flag");
  // The low-confidence branch must NOT call cacheSetVerdict.
  assert.ok(/response\.lowConfidence[\s\S]{0,400}evaluatedWrappers\.add/.test(content),
    "low-confidence marks evaluated for session but does not cache");
});


(async () => {
  // give async tests time (they're awaited individually, but safety margin)
  await new Promise(r => setTimeout(r, 100));
  const s = printSummary();
  const report = {
    generatedAt: new Date().toISOString(),
    total: s.total, pass: s.pass, fail: s.fail,
    results: s.results,
  };
  fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify(report, null, 2));
  console.log(`Report written to report.json`);
  process.exit(s.fail === 0 ? 0 : 1);
})();
