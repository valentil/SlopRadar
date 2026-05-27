// framework.js — minimal test framework, no deps
// Collects results and can emit a JSON report.

const results = [];
let currentSuite = "default";

function suite(name) { currentSuite = name; }

function test(name, fn) {
  const entry = { suite: currentSuite, name, status: "pass", error: null, durationMs: 0 };
  const t0 = Date.now();
  try {
    fn();
  } catch (err) {
    entry.status = "fail";
    entry.error = err && err.message ? err.message : String(err);
  }
  entry.durationMs = Date.now() - t0;
  results.push(entry);
  const icon = entry.status === "pass" ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m";
  console.log(`${icon} [${entry.suite}] ${name}` +
    (entry.status === "fail" ? `\n      \x1b[31m${entry.error}\x1b[0m` : ""));
}

async function testAsync(name, fn) {
  const entry = { suite: currentSuite, name, status: "pass", error: null, durationMs: 0 };
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    entry.status = "fail";
    entry.error = err && err.message ? err.message : String(err);
  }
  entry.durationMs = Date.now() - t0;
  results.push(entry);
  const icon = entry.status === "pass" ? "  \x1b[32m✓\x1b[0m" : "  \x1b[31m✗\x1b[0m";
  console.log(`${icon} [${entry.suite}] ${name}` +
    (entry.status === "fail" ? `\n      \x1b[31m${entry.error}\x1b[0m` : ""));
}

// ── Assertions ──────────────────────────────────────────────────────────
const assert = {
  ok(v, msg) {
    if (!v) throw new Error(msg || `Expected truthy, got ${JSON.stringify(v)}`);
  },
  equal(a, b, msg) {
    if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  },
  notEqual(a, b, msg) {
    if (a === b) throw new Error(msg || `Expected not ${JSON.stringify(b)}`);
  },
  deepEqual(a, b, msg) {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  },
  includes(haystack, needle, msg) {
    if (!haystack || !haystack.includes(needle))
      throw new Error(msg || `Expected to include ${JSON.stringify(needle)}`);
  },
  match(str, re, msg) {
    if (!re.test(str)) throw new Error(msg || `Expected ${str} to match ${re}`);
  },
  throws(fn, msg) {
    let threw = false;
    try { fn(); } catch (_) { threw = true; }
    if (!threw) throw new Error(msg || "Expected function to throw");
  },
  greater(a, b, msg) {
    if (!(a > b)) throw new Error(msg || `Expected ${a} > ${b}`);
  },
};

function summary() {
  const pass = results.filter(r => r.status === "pass").length;
  const fail = results.filter(r => r.status === "fail").length;
  return { total: results.length, pass, fail, results };
}

function printSummary() {
  const s = summary();
  console.log("\n" + "─".repeat(50));
  if (s.fail === 0) {
    console.log(`\x1b[32m  ALL ${s.total} TESTS PASSED\x1b[0m`);
  } else {
    console.log(`\x1b[31m  ${s.fail} FAILED\x1b[0m, \x1b[32m${s.pass} passed\x1b[0m (of ${s.total})`);
  }
  console.log("─".repeat(50) + "\n");
  return s;
}

module.exports = { suite, test, testAsync, assert, summary, printSummary };
