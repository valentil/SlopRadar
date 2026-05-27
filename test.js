#!/usr/bin/env node
// test.js — the single entry point.
//   node test.js
// Runs the suite, builds the report, starts the server, opens Chrome.

const { execFileSync, spawn, execFile } = require("child_process");
const path = require("path");
const os = require("os");

const HERE = __dirname;
const PORT = 8731;

function step(msg) { console.log("\n\x1b[36m▸ " + msg + "\x1b[0m"); }

// ── 1. Run the test suite ────────────────────────────────────────────────
step("Running test suite");
let testsPassed = true;
try {
  execFileSync("node", [path.join(HERE, "run-tests.js")], { stdio: "inherit" });
} catch (_) {
  testsPassed = false; // run-tests.js exits 1 on failure
}

// ── 2. Build the HTML report ─────────────────────────────────────────────
step("Building report.html");
execFileSync("node", [path.join(HERE, "build-report.js")], { stdio: "inherit" });

// ── 3. Start the report server ───────────────────────────────────────────
step("Starting report server on port " + PORT);
const server = spawn("node", [path.join(HERE, "serve-report.js"), "--port", String(PORT)], {
  stdio: "inherit",
});

// ── 4. Open Chrome at the report ─────────────────────────────────────────
function openBrowser(url) {
  const platform = os.platform();
  let cmd, args;
  if (platform === "darwin") { cmd = "open"; args = [url]; }
  else if (platform === "win32") { cmd = "cmd"; args = ["/c", "start", "", url]; }
  else {
    // Linux — try common Chrome binaries, fall back to xdg-open
    const candidates = ["google-chrome", "chromium", "chromium-browser", "xdg-open"];
    cmd = candidates[0]; args = [url];
    for (const c of candidates) {
      try { execFileSync("which", [c]); cmd = c; break; } catch (_) {}
    }
  }
  execFile(cmd, args, (err) => {
    if (err) console.log("  (could not auto-open browser — visit " + url + " manually)");
  });
}

setTimeout(() => {
  const url = `http://localhost:${PORT}`;
  step("Opening " + url + " in browser");
  openBrowser(url);
  console.log("\n  " + (testsPassed
    ? "\x1b[32mTests passed — the report page has a working 'Push to git' button.\x1b[0m"
    : "\x1b[31mTests failed — push is blocked until they are green.\x1b[0m"));
  console.log("  Press Ctrl+C to stop the server.\n");
}, 800);

// ── Cleanup ──────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  server.kill();
  process.exit(0);
});
