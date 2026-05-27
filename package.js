#!/usr/bin/env node
// package.js — builds a distributable Chrome extension .zip
//
// Usage:
//   node package.js              — zips to dist/slopradar-vX.X.X.zip
//   node package.js --open       — also opens the dist/ folder in Explorer
//   node package.js --watch      — rebuilds on any extension file change
//
// The zip is Chrome-compatible: contains exactly the files Chrome expects
// for an unpacked extension load or Chrome Web Store submission.
// Run tests first; packaging is blocked if the last report.json shows failures.

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync, exec } = require("child_process");

const HERE = __dirname;
const DIST_DIR = path.join(HERE, "dist");

// ── Extension files to include in the zip ────────────────────────────────
// Only ship what Chrome needs — no test harness, no build scripts, no icons
// placeholder. Add an icons/ entry if you add real icons later.
const EXTENSION_FILES = [
  "manifest.json",
  "content.js",
  "background.js",
  "options.html",
  "options.js",
];

// Optional directories to include if they exist.
const EXTENSION_DIRS = [
  "icons",
];

// ── Read version from manifest ────────────────────────────────────────────
function getVersion() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
    return m.version || "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}

// ── Gate on test results ──────────────────────────────────────────────────
function checkTests() {
  const reportPath = path.join(HERE, "report.json");
  if (!fs.existsSync(reportPath)) {
    console.log("⚠  No report.json found — run tests first (npm test)");
    console.log("   Packaging anyway (no gate enforced without test report).");
    return true;
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.fail > 0) {
    console.error(`✗  ${report.fail} test(s) failing — fix before packaging.`);
    console.error("   Run: npm test");
    process.exit(1);
  }
  console.log(`✓  All ${report.pass} tests passing (from ${report.generatedAt || "last run"})`);
  return true;
}

// ── Build the zip using Node's built-in zlib + archiver fallback ──────────
// We avoid external deps — use the system zip command (available on macOS/Linux
// and via Git Bash / WSL on Windows) with a fallback error message.
function buildZip(outputPath) {
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

  // Verify all required files exist.
  const missing = EXTENSION_FILES.filter(f => !fs.existsSync(path.join(HERE, f)));
  if (missing.length > 0) {
    console.error("✗  Missing extension files:", missing.join(", "));
    process.exit(1);
  }

  // Build the file list for the zip command.
  const entries = [...EXTENSION_FILES];
  for (const dir of EXTENSION_DIRS) {
    if (fs.existsSync(path.join(HERE, dir))) entries.push(dir);
  }

  // Try zip (unix-style) first, then PowerShell Compress-Archive on Windows.
  const relativeOutput = path.relative(HERE, outputPath);
  const fileList = entries.join(" ");

  let packed = false;

  // Strategy 1: zip command (macOS, Linux, Git Bash)
  try {
    execSync(`zip -r "${relativeOutput}" ${fileList}`, {
      cwd: HERE,
      stdio: "pipe",
    });
    packed = true;
  } catch (_) {}

  // Strategy 2: PowerShell Compress-Archive (native Windows)
  if (!packed) {
    try {
      const absEntries = entries.map(e => path.join(HERE, e));
      // PowerShell needs a comma-separated list of paths
      const psList = absEntries.map(e => `'${e}'`).join(",");
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Force -Path ${psList} -DestinationPath '${outputPath}'"`,
        { cwd: HERE, stdio: "pipe" }
      );
      packed = true;
    } catch (_) {}
  }

  if (!packed) {
    // Strategy 3: pure-JS fallback — write a minimal zip using Node buffers.
    // Covers environments with neither zip nor PowerShell.
    console.log("   (Using built-in JS zip writer — no zip/PowerShell found)");
    buildZipJS(outputPath, entries);
    packed = true;
  }
}

// ── Minimal pure-JS zip writer (no deps) ─────────────────────────────────
// Writes a valid ZIP32 file. Only supports STORE (no compression) for
// simplicity — Chrome doesn't care, and extension files are small.
function buildZipJS(outputPath, entries) {
  const { createDeflateRaw } = require("zlib");
  // Actually use STORED (method 0) — simple enough without zlib.
  const localHeaders = [];
  const chunks = [];
  let offset = 0;

  function u16le(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
  function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  for (const entry of entries) {
    const fullPath = path.join(HERE, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      // Add all files recursively.
      const walk = (dir, base) => {
        for (const name of fs.readdirSync(dir)) {
          const abs = path.join(dir, name);
          const rel = base ? `${base}/${name}` : name;
          if (fs.statSync(abs).isDirectory()) walk(abs, rel);
          else addFile(abs, `${entry}/${rel}`);
        }
      };
      walk(fullPath, "");
    } else {
      addFile(fullPath, entry);
    }
  }

  function addFile(absPath, zipName) {
    const data = fs.readFileSync(absPath);
    const nameBytes = Buffer.from(zipName, "utf8");
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // local file signature
      u16le(20),       // version needed
      u16le(0),        // flags
      u16le(0),        // compression: STORED
      u16le(0),        // mod time
      u16le(0),        // mod date
      u32le(crc),
      u32le(data.length),
      u32le(data.length),
      u16le(nameBytes.length),
      u16le(0),        // extra length
      nameBytes,
    ]);
    localHeaders.push({ nameBytes, crc, size: data.length, offset });
    chunks.push(localHeader, data);
    offset += localHeader.length + data.length;
  }

  // Central directory
  const cdChunks = [];
  for (const h of localHeaders) {
    cdChunks.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), // central dir signature
      u16le(20), u16le(20), u16le(0), u16le(0), u16le(0), u16le(0), u16le(0),
      u32le(h.crc), u32le(h.size), u32le(h.size),
      u16le(h.nameBytes.length), u16le(0), u16le(0), u16le(0), u16le(0),
      u32le(0), u32le(h.offset),
      h.nameBytes,
    ]));
  }
  const cdBuffer = Buffer.concat(cdChunks);
  const cdOffset = offset;

  // End of central directory
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16le(0), u16le(0),
    u16le(localHeaders.length), u16le(localHeaders.length),
    u32le(cdBuffer.length), u32le(cdOffset),
    u16le(0),
  ]);

  fs.writeFileSync(outputPath, Buffer.concat([...chunks, cdBuffer, eocd]));
}

// ── Main ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const doOpen = args.includes("--open");
const doWatch = args.includes("--watch");

function buildOnce() {
  checkTests();
  const version = getVersion();
  const zipName = `slopradar-v${version}.zip`;
  const outputPath = path.join(DIST_DIR, zipName);

  // Remove a stale zip first so we never ship a partial file on failure.
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  console.log(`\n📦 Packaging SlopRadar v${version}…`);
  buildZip(outputPath);

  const bytes = fs.statSync(outputPath).size;
  console.log(`✓  Built: dist/${zipName}  (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`   Load in Chrome: chrome://extensions → Enable Dev Mode → "Load unpacked"`);
  console.log(`   Or submit: chrome://extensions → Pack extension → Upload the .zip`);

  if (doOpen) {
    const distAbs = path.resolve(DIST_DIR);
    if (process.platform === "win32") exec(`explorer "${distAbs}"`);
    else if (process.platform === "darwin") exec(`open "${distAbs}"`);
    else exec(`xdg-open "${distAbs}"`);
  }

  // Write a build-info.json the test report can link to.
  fs.writeFileSync(path.join(DIST_DIR, "build-info.json"), JSON.stringify({
    version,
    zipName,
    bytes,
    builtAt: new Date().toISOString(),
  }, null, 2));

  return { version, zipName, bytes };
}

if (doWatch) {
  console.log("👁  Watching for changes — press Ctrl+C to stop\n");
  buildOnce();
  const WATCH_FILES = EXTENSION_FILES;
  WATCH_FILES.forEach(f => {
    fs.watch(path.join(HERE, f), () => {
      console.log(`\n↺  ${f} changed`);
      buildOnce();
    });
  });
} else {
  buildOnce();
}

module.exports = { buildOnce };
