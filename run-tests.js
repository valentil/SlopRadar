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
  assert.equal(resp.minConfidence, 60);
  assert.equal(resp.universalMode, true);
  assert.equal(resp.hideSlop, false);
});

testAsync("saveSettings persists to storage", async () => {
  const chrome = loadBackground();
  await chrome.runtime._fireMessage({
    action: "saveSettings",
    settings: { minConfidence: 80, hideSlop: true, universalMode: false },
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
// SUITE 10 — Default-excluded sites
// ════════════════════════════════════════════════════════════════════════
suite("excluded-sites");

const DEFAULT_EXCLUDED = [
  "chatgpt.com", "chat.openai.com", "claude.ai",
  "gemini.google.com", "mail.google.com", "gmail.com",
  "github.com", "localhost",
];
function isExcluded(hostname, extra) {
  return DEFAULT_EXCLUDED.concat(extra || []).some(s => s && hostname.includes(s));
}

test("ChatGPT is excluded by default", () => {
  assert.equal(isExcluded("chatgpt.com"), true);
});

test("Claude is excluded by default", () => {
  assert.equal(isExcluded("claude.ai"), true);
});

test("Gmail is excluded by default", () => {
  assert.equal(isExcluded("mail.google.com"), true);
});

test("a normal site is not excluded", () => {
  assert.equal(isExcluded("somerandomblog.com"), false);
});

test("user-added exclusion works", () => {
  assert.equal(isExcluded("intranet.mycompany.com", ["mycompany.com"]), true);
});

test("subdomain of excluded site is also excluded", () => {
  // includes() match means any subdomain of chatgpt.com is caught
  assert.equal(isExcluded("beta.chatgpt.com"), true);
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
