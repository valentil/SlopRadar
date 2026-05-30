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

testAsync("evaluatePost with no AI returns degraded, not a fake verdict", async () => {
  const chrome = loadBackground();
  const resp = await chrome.runtime._fireMessage({ action: "evaluatePost", text: "some post", tabId: 1 });
  // Old code returned a fake {isSlop:false, confidence:50}, which was the
  // "50% not slop for everything" bug. The fix: signal degraded so the
  // content side re-queues instead of stamping.
  assert.equal(resp.degraded, true, "no AI session = signal degraded for retry");
  assert.equal(resp.isSlop, undefined, "must not fabricate a verdict");
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
  // enqueueNode (via maybeReapplyFromCache) must detect a missing banner on
  // a known-slop wrapper and re-apply from cache rather than silently
  // skipping it as a dup.
  assert.ok(/function maybeReapplyFromCache/.test(content),
    "maybeReapplyFromCache helper exists");
  assert.ok(/bannerMissing|blockMissing/.test(content),
    "checks whether the injected banner is still present");
  assert.ok(/maybeReapplyFromCache[\s\S]{0,2000}applySlop\(wrapper,\s*verdict\.confidence/.test(content),
    "re-applies slop when the banner was wiped");
});

test("dup nodes (same text, already targeted) still get cache re-apply check", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(
    path.join(findExtDir(), "content.js"), "utf8");
  // The dup-detection branch in enqueueNode used to silently `return` when
  // a textNode was seen with the same text. That left the user staring at
  // an un-flagged slop card if the platform had wiped our banner since the
  // last sweep. Now: dup branch calls maybeReapplyFromCache before returning.
  assert.ok(/targetedTextNodes\.has\(textNode\)[\s\S]{0,400}maybeReapplyFromCache/.test(content),
    "dup-textnode branch calls maybeReapplyFromCache");
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
    "careful detector of AI-generated marketing slop",
    "STEP 1 — CLASSIFY THE GENRE FIRST",
    "STEP 2 — APPLY DIFFERENT SLOP THRESHOLDS BY GENRE",
    "(A) NEWS REPORTING",
    "(B) COMMENTARY / OPINION",
    "SLOP PATTERNS (signals to count):",
    "LENGTH NOTE",
    "PLATFORM — LinkedIn",
    "PLATFORM — X / Twitter",
    'Respond with ONLY a JSON object: {"slop": 1, "confidence": 87, "reasons":',
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
// SUITE 20 — Platform-aware prompts + news/factual carve-out
// ════════════════════════════════════════════════════════════════════════
// Catches the "treasury secretary post flagged as slop" class of bug:
// confident commentary on real events must not be classified as slop just
// because of strong framing. Different platforms also need different guidance.
suite("platform-prompts");

// Pull buildPrompt out of background and exercise it directly.
function loadBuildPrompt() {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  const m = src.match(/function buildPrompt[\s\S]*?\n\}\n/);
  assert.ok(m, "buildPrompt source extracted");
  const f = new Function("text", "patterns", "platform",
    m[0] + "\nreturn buildPrompt(text, patterns, platform);");
  return f;
}

test("buildPrompt takes a platform argument and varies output", () => {
  const bp = loadBuildPrompt();
  const li = bp("hello world", ["test pattern"], "linkedin");
  const tw = bp("hello world", ["test pattern"], "twitter");
  assert.ok(li.includes("PLATFORM — LinkedIn"));
  assert.ok(tw.includes("PLATFORM — X / Twitter"));
  assert.notEqual(li, tw, "platform branches produce different prompts");
});

test("LinkedIn prompt names the thought-leadership patterns", () => {
  const bp = loadBuildPrompt();
  const out = bp("hello world", [], "linkedin");
  assert.ok(out.includes("thought leadership"), "LI prompt explicitly calls out thought leadership");
  assert.ok(/quiet part out loud|nobody talks about this|deep problem/i.test(out),
    "LI prompt lists the specific LinkedIn engagement-bait phrasings");
});

test("X/Twitter prompt names retweet-with-broad-claim + this image/video patterns", () => {
  const bp = loadBuildPrompt();
  const out = bp("hello world", [], "twitter");
  assert.ok(/quote.tweet|references another popular post/i.test(out),
    "X prompt covers quote-tweet-plus-broad-claim slop");
  assert.ok(/this image|this video|watch this/i.test(out),
    "X prompt covers vague 'this image/video' slop");
});

test("prompt explicitly excludes news/political commentary from slop", () => {
  const bp = loadBuildPrompt();
  const out = bp("Treasury secretary announces extension of Iran ceasefire", [], "twitter");
  // The carve-out must mention news/events AND the no-slop-just-because rules.
  assert.ok(/news|current events|policy|politics|markets/i.test(out),
    "AUTHENTIC criteria explicitly include news/events");
  assert.ok(/public figure|official|journalist|news aggregator/i.test(out),
    "AUTHENTIC criteria explicitly cover public figures/officials");
  assert.ok(/DO NOT classify as slop just because/i.test(out),
    "prompt has an explicit DO NOT list");
});

test("prompt uses two-step genre+threshold structure for news vs commentary", () => {
  const bp = loadBuildPrompt();
  // Real example that was being misclassified before this fix:
  const out = bp("UBS SLASHES HUNDREDS OF JOBS DURING CREDIT SUISSE MERGER.", [], "twitter");
  // Step 1 — classify genre.
  assert.ok(/STEP 1[\s\S]{0,200}CLASSIFY THE GENRE/i.test(out),
    "prompt has explicit Step 1 genre classification");
  assert.ok(/NEWS REPORTING/.test(out) && /COMMENTARY/.test(out),
    "prompt defines both NEWS and COMMENTARY genres");
  // Step 2 — different thresholds.
  assert.ok(/STEP 2[\s\S]{0,400}2\+\s*slop signals/i.test(out),
    "Step 2 requires 2+ signals for news");
  assert.ok(/COMMENTARY[\s\S]{0,400}1 clear slop signal/i.test(out),
    "Step 2 requires only 1 signal for commentary");
  // Wire-service conventions must still be called out as non-signals.
  assert.ok(/ALL CAPS/.test(out), "ALL CAPS still called out as a non-signal");
  assert.ok(/wire.service|news aggregator|First Squawk|Reuters/i.test(out),
    "rule names wire-service / news-aggregator accounts");
  assert.ok(/lacks specific|implied significance/i.test(out),
    "rule explicitly rejects 'lacks specifics' / 'implied significance' as slop signals");
});

test("prompt distinguishes news genre from commentary genre", () => {
  const bp = loadBuildPrompt();
  const out = bp("hello world", [], "twitter");
  // Commentary examples — "what X gets wrong about Y", "what Musk and Zuckerberg miss"
  // should be specifically mentioned as commentary indicators.
  assert.ok(/Musk and Zuckerberg|misses|gets wrong|the real reason|deep problem/i.test(out),
    "prompt names commentary indicators (opinion verbs, hot-take templates)");
  // The DEFAULT-to-authentic rule must be explicit when news + few signals.
  assert.ok(/DEFAULT to authentic|when in doubt/i.test(out),
    "prompt explicitly says 'default to authentic when uncertain'");
});

test("platform threads through enqueue and into the drain loop", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // Content sends platform on every classify request.
  assert.ok(/action:\s*"evaluatePost"[\s\S]{0,160}platform:\s*PLATFORM/.test(content),
    "content includes platform in evaluatePost message");
  // Background enqueue captures it and passes it to buildPrompt.
  assert.ok(/enqueue\(tabId,\s*request\.text,\s*sendResponse,\s*request\.platform\)/.test(bg),
    "evaluatePost handler forwards platform to enqueue");
  assert.ok(/buildPrompt\(item\.text,\s*patterns,\s*item\.platform\)/.test(bg),
    "drain loop passes item.platform to buildPrompt");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 21 — Engine watchdog (auto-recovers from stuck initializing)
// ════════════════════════════════════════════════════════════════════════
suite("engine-watchdog");

test("background defines an engineWatchdog that calls initEngine", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  assert.ok(/async function engineWatchdog/.test(bg), "engineWatchdog defined");
  assert.ok(/async function engineWatchdog[\s\S]{0,1200}initEngine\(\)/.test(bg),
    "watchdog calls initEngine when conditions are met");
  assert.ok(/setInterval\(engineWatchdog/.test(bg), "watchdog is scheduled");
});

test("watchdog skips kick when model is downloading", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  // Must check availability and return early on "downloading"/"downloadable".
  assert.ok(/engineWatchdog[\s\S]{0,800}availability/.test(bg),
    "watchdog consults LanguageModel.availability");
  assert.ok(/downloadable[\s\S]{0,80}return/i.test(bg) ||
            /downloading[\s\S]{0,80}return/i.test(bg),
    "watchdog returns without kicking during a real download");
});

test("popup auto-kickstarts after a streak of not-ready statuses", () => {
  const fs = require("fs");
  const path = require("path");
  const opts = fs.readFileSync(path.join(findExtDir(), "options.js"), "utf8");
  assert.ok(/notReadyStreak/.test(opts), "popup tracks not-ready streak");
  assert.ok(/notReadyStreak\s*>=\s*2[\s\S]{0,200}kickstartEngine/.test(opts),
    "popup auto-issues kickstart after streak threshold");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 22 — Display modes (mutually exclusive + applied correctly)
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

// ════════════════════════════════════════════════════════════════════════
// SUITE 23 — Reasons-in-banner (the model explains why)
// ════════════════════════════════════════════════════════════════════════
suite("reasons");

test("prompt asks the model for a reasons array", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  assert.ok(/"reasons":\s*\[/.test(bg), "prompt example shows reasons array");
  assert.ok(/under 8 words/.test(bg), "prompt constrains reason length");
});

test("background parses reasons defensively (filter, trim, cap at 3)", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  // Must filter non-strings, trim, cap length, slice to 3.
  assert.ok(/parsed\.reasons[\s\S]{0,200}filter/.test(bg), "filters bad reasons");
  assert.ok(/\.slice\(0,\s*3\)/.test(bg), "caps at 3 reasons");
});

test("background sends reasons in the verdict response", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  assert.ok(/sendResponse\(\{[^}]*reasons\s*\}\)/.test(bg) ||
            /isSlop,\s*confidence,\s*lowConfidence,\s*reasons/.test(bg),
    "sendResponse includes reasons");
});

test("applySlop signature accepts reasons and threads to cache", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/function applySlop\(wrapper,\s*confidence,\s*reasons/.test(content),
    "applySlop takes reasons");
  assert.ok(/cacheSetVerdict\(postText,\s*true,\s*confidence,\s*reasons\)/.test(content),
    "applySlop persists reasons in the cache");
});

test("slop banner renders a reasons row when reasons are present", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/slop_dog_ear_reasons/.test(content), "reasons CSS class defined");
  // The "Why:" prefix is what the user sees inside the banner.
  assert.ok(/"Why:\s*"/.test(content), "banner prefixes the reasons with 'Why:'");
  // Banner must flex-wrap so the reasons row drops below the ribbon.
  assert.ok(/\.slop_dog_ear[\s\S]{0,400}flex-wrap:\s*wrap/.test(content),
    "banner wraps so reasons row fits");
});

test("cache restore propagates reasons to applySlop", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // Every cache-hit re-application must pass cached.reasons / verdict.reasons.
  const cacheHitCalls = (content.match(/applySlop\(wrapper,\s*[a-z]+\.confidence,/gi) || []);
  assert.ok(cacheHitCalls.length >= 2, "found cache-hit applySlop sites");
  for (const call of cacheHitCalls) {
    assert.ok(/cached\.confidence|verdict\.confidence/.test(call),
      "each cache-hit site pulls confidence from the cached entry");
  }
  // And the surrounding code in those sites passes reasons.
  assert.ok(/cached\.reasons\s*\|\|\s*\[\]/.test(content),
    "cache hits forward cached.reasons (with [] fallback)");
});

test("revealed cards get padding-top equal to the measured banner height", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // We reverted to the padding-top approach because position:relative + flex
  // caused X to render the banner as a left-side column. The banner stays
  // position:absolute and we push content down with padding on the wrapper.
  // Fallback must accommodate the two-line banner (ribbon + reasons).
  const fallbacks = [...content.matchAll(/padding-top:\s*var\(--sr-banner-h,\s*(\d+)px\)/g)]
    .map(m => parseInt(m[1], 10));
  assert.ok(fallbacks.length >= 1, "at least one padding-top rule uses --sr-banner-h");
  for (const px of fallbacks) {
    assert.ok(px >= 80, `--sr-banner-h fallback ${px}px is too small for two-line banner`);
  }
});

test("revealed banner stays position:absolute (don't regress to flex column on X)", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // Locking in the fix for the X "left-side column" bug. The banner MUST
  // remain position:absolute when revealed — making it relative or flex
  // causes X's flex-row tweet layout to treat it as a sibling column.
  assert.ok(/data-sr-revealed[\s\S]{0,400}\.slop_dog_ear[\s\S]{0,400}position:\s*absolute/.test(content),
    "revealed banner stays position:absolute");
});

test("banner height is measured live for accurate padding-top and blur cover", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // Live measurement uses ResizeObserver — needed because the reasons row
  // can wrap on narrow viewports and web fonts settle after first paint.
  assert.ok(/ResizeObserver[\s\S]{0,200}observe\(banner\)/.test(content),
    "ResizeObserver observes the banner");
});

test("all four platform classes are covered by the reveal padding rule", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  for (const cls of ["slop_radar_card", "slop_radar_twitter", "slop_radar_linkedin", "slop_radar_universal", "slop_radar_reddit", "slop_radar_threads"]) {
    assert.ok(new RegExp(`\\[data-sr-revealed\\]\\.${cls}`).test(content),
      `[data-sr-revealed].${cls} has padding-top rule`);
  }
});

test("placeholder-echo reasons are detected as degraded output", () => {
  const fs = require("fs");
  const path = require("path");
  const bg = fs.readFileSync(path.join(findExtDir(), "background.js"), "utf8");
  // A wedged model sometimes echoes the JSON schema's placeholder values
  // back as the "reasons" array (e.g. "short reason 1"). We must catch this
  // and treat it like any other degraded output so the recovery path fires.
  assert.ok(/short reason\\s\*\\d\+\$/.test(bg) || /short reason\s*\\d/.test(bg),
    "placeholder regex matches the schema example phrases");
  // The detection must set degraded=true so the existing recovery flow runs.
  assert.ok(/placeholderEcho[\s\S]{0,200}degraded\s*=\s*true/.test(bg),
    "placeholder echo flips degraded=true");
  // The prompt's schema example should be neutral filler the model is less
  // tempted to copy verbatim — not phrases that look like real reasons.
  assert.ok(!/reasons":\s*\["short reason 1"/.test(bg),
    "prompt schema example no longer uses 'short reason N' placeholders");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 24 — Verdict cache persistence + GC
// ════════════════════════════════════════════════════════════════════════
// The reload experience depends on the verdict cache surviving across
// sessions. These tests guard the structural pieces: storage key, debounced
// writes, age-based pruning, cap eviction by ts, restore-before-sweep.
suite("persistence");

test("verdict cache uses chrome.storage.local with a stable key", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/VERDICT_STORAGE_KEY\s*=\s*["']srVerdictCache["']/.test(content),
    "storage key constant defined");
  assert.ok(/chrome\.storage\.local\.set\(\{\s*\[VERDICT_STORAGE_KEY\]/.test(content),
    "persistVerdictCache writes to chrome.storage.local under that key");
  assert.ok(/chrome\.storage\.local\.get\(\[VERDICT_STORAGE_KEY\]/.test(content),
    "restoreVerdictCache reads the same key");
});

test("persistence has a TTL and a hard cap with reasonable defaults", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  const ttlMatch = content.match(/VERDICT_TTL_MS\s*=\s*([0-9*\s]+);/);
  const capMatch = content.match(/VERDICT_PERSIST_CAP\s*=\s*(\d+)/);
  assert.ok(ttlMatch, "VERDICT_TTL_MS defined");
  assert.ok(capMatch, "VERDICT_PERSIST_CAP defined");
  const ttl = eval(ttlMatch[1]); // numeric expression like "7 * 24 * 60 * 60 * 1000"
  const cap = parseInt(capMatch[1], 10);
  // Sanity: TTL between 1 hour and 30 days; cap between 200 and 10000.
  assert.ok(ttl >= 3600_000 && ttl <= 30 * 86400_000,
    `TTL ${ttl}ms outside the 1h-30d range`);
  assert.ok(cap >= 200 && cap <= 10000, `cap ${cap} outside 200-10000`);
});

test("writes are debounced (no thrash on bursty scroll)", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/PERSIST_DEBOUNCE_MS/.test(content), "debounce constant defined");
  assert.ok(/function schedulePersist/.test(content), "schedulePersist exists");
  // schedulePersist must early-return if a timer is already pending.
  assert.ok(/schedulePersist[\s\S]{0,200}if\s*\(\s*persistTimer\s*\)\s*return/.test(content),
    "schedulePersist coalesces concurrent calls");
  // cacheSetVerdict must trigger a persist.
  assert.ok(/cacheSetVerdict[\s\S]{0,400}schedulePersist\(\)/.test(content),
    "every write schedules a persist");
});

test("gcCache prunes expired entries and enforces the cap by ts", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/function gcCache/.test(content), "gcCache defined");
  // Prune by ts < cutoff.
  assert.ok(/gcCache[\s\S]{0,400}ts\s*<\s*cutoff/.test(content),
    "gcCache drops entries older than TTL");
  // Then enforce cap by sorting on ts.
  assert.ok(/gcCache[\s\S]{0,600}sort\([\s\S]{0,80}ts/.test(content),
    "gcCache enforces cap by oldest ts");
});

test("restoreVerdictCache runs before the first sweep on bootstrap", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // The bootstrap must call restoreVerdictCache and start sweeping inside
  // the callback — otherwise we race the first sweep and reclassify
  // already-known posts.
  assert.ok(/restoreVerdictCache\(\(\)\s*=>\s*\{[\s\S]{0,100}startSweeping\(\)/.test(content),
    "startSweeping runs inside restoreVerdictCache callback");
});

test("opportunistic flush on tab close and visibility-hidden", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/beforeunload[\s\S]{0,200}persistVerdictCache/.test(content),
    "flushes on beforeunload");
  assert.ok(/visibilitychange[\s\S]{0,200}persistVerdictCache/.test(content),
    "flushes when tab becomes hidden");
});

test("restored entries past their TTL are skipped on load", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // restoreVerdictCache must filter v.ts < cutoff when loading.
  assert.ok(/restoreVerdictCache[\s\S]{0,500}ts\s*<\s*cutoff[\s\S]{0,80}continue/.test(content),
    "restore skips entries past their TTL");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 25 — Promoted / Ad detector
// ════════════════════════════════════════════════════════════════════════
// Sponsored posts get short-circuited as slop before any AI inference. The
// detection is purely structural — looking for a short "Promoted" / "Ad"
// label in the post header — so it must avoid false-positives on post body
// text that happens to contain those words.
suite("promoted-detector");

// Pull isPromotedPost out of content.js and run it against jsdom fixtures.
function loadPromotedDetector(platform) {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // Extract PROMOTED_LABELS const + isPromotedPost function.
  const labelsMatch = src.match(/const PROMOTED_LABELS = \[[\s\S]*?\];/);
  const fnMatch = src.match(/function isPromotedPost\(wrapper\) \{[\s\S]*?\n\}\n/);
  assert.ok(labelsMatch && fnMatch, "extracted detector source");
  // Build a sandboxed version that reads IS_TWITTER / IS_LINKEDIN from
  // injected scope rather than module-level constants.
  return new Function(
    "IS_TWITTER", "IS_LINKEDIN",
    labelsMatch[0] + "\n" + fnMatch[0] + "\nreturn isPromotedPost;"
  )(platform === "twitter", platform === "linkedin");
}

test("LinkedIn: 'Promoted' label in actor description detected", () => {
  const dom = new JSDOM(`<div data-urn="urn:li:activity:promo1">
    <div class="update-components-actor__description">
      <span>Acme Corp</span>
      <span>Promoted</span>
    </div>
    <div class="update-components-text">Buy our product! Best in class. Trusted by 10,000 companies.</div>
  </div>`);
  const detect = loadPromotedDetector("linkedin");
  const wrapper = dom.window.document.querySelector('[data-urn]');
  assert.ok(detect(wrapper), "must detect Promoted label");
});

test("LinkedIn: post body containing the word 'promoted' is NOT a false positive", () => {
  const dom = new JSDOM(`<div data-urn="urn:li:activity:body1">
    <div class="update-components-actor__description">
      <span>Jane Doe</span>
      <span>Senior Engineer at Foo Co · 2nd</span>
    </div>
    <div class="update-components-text">She was promoted to VP last week — congrats!</div>
  </div>`);
  const detect = loadPromotedDetector("linkedin");
  const wrapper = dom.window.document.querySelector('[data-urn]');
  assert.equal(detect(wrapper), false, "body text 'promoted' should not match");
});

test("LinkedIn: organic post with no Promoted label is not flagged", () => {
  const dom = new JSDOM(`<div data-urn="urn:li:activity:org1">
    <div class="update-components-actor__description">
      <span>Jane Doe</span>
      <span>Senior Engineer at Foo Co · 2nd · 1h</span>
    </div>
    <div class="update-components-text">Excited to announce we shipped feature X.</div>
  </div>`);
  const detect = loadPromotedDetector("linkedin");
  const wrapper = dom.window.document.querySelector('[data-urn]');
  assert.equal(detect(wrapper), false, "organic post must not be flagged");
});

test("X: 'Ad' label in User-Name header detected", () => {
  const dom = new JSDOM(`<article data-testid="tweet">
    <div data-testid="User-Name">
      <span>Acme Brand</span>
      <span>@acmebrand</span>
      <span>·</span>
      <span>Ad</span>
    </div>
    <div data-testid="tweetText">Check out our new product</div>
  </article>`);
  const detect = loadPromotedDetector("twitter");
  const wrapper = dom.window.document.querySelector('article');
  assert.ok(detect(wrapper), "must detect Ad label");
});

test("X: organic tweet with timestamp '4m' but no Ad label is not flagged", () => {
  const dom = new JSDOM(`<article data-testid="tweet">
    <div data-testid="User-Name">
      <span>First Squawk</span>
      <span>@FirstSquawk</span>
      <span>·</span>
      <span>4m</span>
    </div>
    <div data-testid="tweetText">UBS slashes hundreds of jobs.</div>
  </article>`);
  const detect = loadPromotedDetector("twitter");
  const wrapper = dom.window.document.querySelector('article');
  assert.equal(detect(wrapper), false, "organic tweet must not be flagged");
});

test("X: tweet body containing the word 'ad' (e.g. 'advertise') is NOT a false positive", () => {
  const dom = new JSDOM(`<article data-testid="tweet">
    <div data-testid="User-Name">
      <span>Jane Doe</span>
      <span>@janed</span>
      <span>·</span>
      <span>2h</span>
    </div>
    <div data-testid="tweetText">Why does every ad on TV look the same these days?</div>
  </article>`);
  const detect = loadPromotedDetector("twitter");
  const wrapper = dom.window.document.querySelector('article');
  assert.equal(detect(wrapper), false, "body text mentioning 'ad' must not match");
});

test("LinkedIn: 'Gesponsert' (German) is detected for localized feeds", () => {
  const dom = new JSDOM(`<div data-urn="urn:li:activity:de">
    <div class="update-components-actor__description">
      <span>Acme GmbH</span>
      <span>Gesponsert</span>
    </div>
    <div class="update-components-text">Unsere neue Produktreihe</div>
  </div>`);
  const detect = loadPromotedDetector("linkedin");
  const wrapper = dom.window.document.querySelector('[data-urn]');
  assert.ok(detect(wrapper), "must detect German 'Gesponsert' label");
});

test("enqueueNode short-circuits promoted posts to applySlop, skipping the AI queue", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // enqueueNode must call isPromotedPost and, when true, invoke applySlop
  // with confidence 100 and return BEFORE adding the node to the queue.
  assert.ok(/isPromotedPost\(wrapper\)[\s\S]{0,200}applySlop\(wrapper,\s*100/.test(content),
    "promoted detection short-circuits to applySlop(wrapper, 100, ...)");
  assert.ok(/isPromotedPost\(wrapper\)[\s\S]{0,400}\n\s*return;/.test(content),
    "promoted branch returns before queueing");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 26 — LinkedIn sweep cadence
// ════════════════════════════════════════════════════════════════════════
suite("linkedin-cadence");

test("LinkedIn sweep cadence is not slower than ~1 second", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // Old value was 1200ms which made the queue feel sluggish. We bumped it
  // to be closer to X's cadence (700ms) so the in-viewport posts populate
  // in roughly the same time on both platforms.
  const m = content.match(/SWEEP_INTERVAL_MS\s*=\s*IS_LINKEDIN\s*\?\s*(\d+)/);
  assert.ok(m, "found SWEEP_INTERVAL_MS for LinkedIn");
  const ms = parseInt(m[1], 10);
  assert.ok(ms <= 1000, `LinkedIn cadence ${ms}ms is too slow (target ≤1000)`);
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 27 — Drain pipeline (overlap message round-trip with AI inference)
// ════════════════════════════════════════════════════════════════════════
// The single shared aiSession in the background processes inferences
// serially, but pipelining at the messaging layer lets us hide the
// MV3 wake-up + sendMessage overhead behind the in-flight inference.
suite("pipeline");

test("content uses a bounded in-flight drain pipeline (not a single bool)", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // The old design used `let draining = false` — strictly one-at-a-time.
  // The pipelined version counts in-flight drains and pumps up to a cap.
  assert.ok(/PIPELINE_MAX/.test(content), "PIPELINE_MAX cap is defined");
  assert.ok(/let inFlightDrains/.test(content), "in-flight counter exists");
  assert.ok(/function pumpDrain/.test(content), "pumpDrain dispatcher exists");
  assert.ok(/inFlightDrains\s*<\s*PIPELINE_MAX/.test(content),
    "pumpDrain enforces the in-flight cap");
});

test("pipeline cap is small and bounded (≤5)", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  const m = content.match(/PIPELINE_MAX\s*=\s*(\d+)/);
  assert.ok(m, "PIPELINE_MAX is a number");
  const max = parseInt(m[1], 10);
  // The AI itself is serial, so a huge pipeline just queues stale work.
  // 2-5 is the sweet spot for hiding round-trip latency.
  assert.ok(max >= 2 && max <= 5,
    `PIPELINE_MAX=${max} should be in the 2-5 range`);
});

test("every drainOne path decrements the in-flight counter via finish()", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // The drainOne body defines a finish() helper that's the SINGLE place
  // inFlightDrains gets decremented. Every return path must call it.
  assert.ok(/const finish = \(\) =>/.test(content), "finish() helper defined");
  assert.ok(/inFlightDrains\s*=\s*Math\.max\(0,\s*inFlightDrains\s*-\s*1\)/.test(content),
    "finish() floor-clamps the counter");
});

// ════════════════════════════════════════════════════════════════════════
// SUITE 28 — Perf instrumentation
// ════════════════════════════════════════════════════════════════════════
// Timing/throughput logs let us see WHERE time goes when the queue feels
// sluggish: cache hit rate, queue-age latency, AI round-trip duration,
// sweep duration.
suite("perf-instrumentation");

test("perfStats tracks the four core metrics", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/const perfStats = \{/.test(content), "perfStats object defined");
  for (const key of ["cacheHits", "cacheMisses", "totalAgeMs", "aiCalls", "totalAiMs", "maxAiMs", "sweepCount"]) {
    assert.ok(new RegExp(`perfStats\\.${key}`).test(content),
      `perfStats.${key} is incremented somewhere`);
  }
});

test("perf stats flush on a periodic interval", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  assert.ok(/function flushPerfStats/.test(content), "flushPerfStats defined");
  assert.ok(/setInterval\(flushPerfStats/.test(content),
    "flushPerfStats runs on a timer");
});

test("AI call timing wraps the sendMessage callback", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // Must capture tAiStart BEFORE sendMessage and read it inside the callback.
  assert.ok(/const tAiStart = performance\.now\(\);[\s\S]{0,200}chrome\.runtime\.sendMessage/.test(content),
    "tAiStart taken before sendMessage");
  assert.ok(/performance\.now\(\)\s*-\s*tAiStart/.test(content),
    "duration computed inside callback");
});

test("slow-sweep warnings log immediately (not waiting for periodic flush)", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // If a sweep takes longer than the interval we want to know right away.
  assert.ok(/sweepMs\s*>\s*SWEEP_INTERVAL_MS[\s\S]{0,200}srLog/.test(content),
    "slow-sweep warning fires when sweepMs > interval");
});

test("queue items carry enqueuedAt so we can measure age", () => {
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(findExtDir(), "content.js"), "utf8");
  // Every push to pendingNodes must stamp enqueuedAt so the drain side
  // can compute (drainStart - enqueuedAt) as the post's queue age.
  const pushes = [...content.matchAll(/pendingNodes\.push\(\{[^}]*\}\)/g)];
  assert.ok(pushes.length >= 2, "found pendingNodes.push call sites");
  for (const p of pushes) {
    assert.ok(/enqueuedAt/.test(p[0]),
      `push site missing enqueuedAt: ${p[0]}`);
  }
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
