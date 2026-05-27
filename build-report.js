// build-report.js — turns report.json into a self-contained report.html
// and copies fixtures so they can be previewed in an iframe.

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const report = JSON.parse(fs.readFileSync(path.join(HERE, "report.json"), "utf8"));

// Group results by suite
const bySuite = {};
for (const r of report.results) {
  (bySuite[r.suite] = bySuite[r.suite] || []).push(r);
}

const allPass = report.fail === 0;
const statusColor = allPass ? "#137333" : "#e02424";
const statusText = allPass ? "ALL TESTS PASSED" : `${report.fail} FAILED`;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const suitesHtml = Object.entries(bySuite).map(([suite, tests]) => {
  const pass = tests.filter(t => t.status === "pass").length;
  const fail = tests.length - pass;
  const rows = tests.map(t => `
    <div class="test-row ${t.status}">
      <span class="test-icon">${t.status === "pass" ? "✓" : "✗"}</span>
      <span class="test-name">${esc(t.name)}</span>
      <span class="test-dur">${t.durationMs}ms</span>
      ${t.error ? `<div class="test-error">${esc(t.error)}</div>` : ""}
    </div>`).join("");
  return `
    <div class="suite">
      <div class="suite-header">
        <span class="suite-name">${esc(suite)}</span>
        <span class="suite-stats">
          <span class="badge pass">${pass} pass</span>
          ${fail > 0 ? `<span class="badge fail">${fail} fail</span>` : ""}
        </span>
      </div>
      ${rows}
    </div>`;
}).join("");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>SlopRadar — Test Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f9fafb; color: #111827; padding: 0 0 80px;
  }
  .header {
    background: ${statusColor}; color: #fff;
    padding: 24px 32px; display: flex; align-items: center; gap: 16px;
  }
  .header h1 { font-size: 1.3rem; font-weight: 900; letter-spacing: 0.1rem; }
  .header .status {
    margin-left: auto; font-size: 1rem; font-weight: 800;
    background: rgba(255,255,255,0.18); padding: 6px 16px; border-radius: 6px;
  }
  .meta { padding: 12px 32px; font-size: 0.78rem; color: #6b7280; background: #fff; border-bottom: 1px solid #e5e7eb; }
  .container { max-width: 980px; margin: 0 auto; padding: 24px 32px; }
  .summary-grid {
    display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; margin-bottom: 24px;
  }
  .sum-card {
    background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;
    padding: 16px; text-align: center;
  }
  .sum-card .num { font-size: 2rem; font-weight: 900; }
  .sum-card .lbl { font-size: 0.7rem; color: #6b7280; text-transform: uppercase; letter-spacing: 0.08rem; }
  .num.green { color: #137333; } .num.red { color: #e02424; }

  .suite { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .suite-header {
    display: flex; align-items: center; padding: 10px 16px;
    background: #f3f4f6; border-bottom: 1px solid #e5e7eb;
  }
  .suite-name { font-weight: 800; font-size: 0.82rem; letter-spacing: 0.05rem; }
  .suite-stats { margin-left: auto; display: flex; gap: 6px; }
  .badge { font-size: 0.65rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
  .badge.pass { background: #f0fdf4; color: #137333; }
  .badge.fail { background: #fef2f2; color: #e02424; }

  .test-row {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 16px; font-size: 0.8rem; border-bottom: 1px solid #f3f4f6;
    flex-wrap: wrap;
  }
  .test-row:last-child { border-bottom: none; }
  .test-icon { font-weight: 900; width: 16px; }
  .test-row.pass .test-icon { color: #137333; }
  .test-row.fail .test-icon { color: #e02424; }
  .test-row.fail { background: #fef2f2; }
  .test-name { flex: 1; }
  .test-dur { color: #9ca3af; font-size: 0.7rem; }
  .test-error {
    width: 100%; margin: 4px 0 0 26px; padding: 6px 10px;
    background: #fff; border-left: 3px solid #e02424;
    font-family: ui-monospace, monospace; font-size: 0.72rem; color: #b91c1c;
  }

  h2.section { font-size: 0.95rem; margin: 28px 0 12px; font-weight: 800; }
  .fixtures { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .fixture-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  .fixture-card .fc-head {
    padding: 8px 14px; font-weight: 700; font-size: 0.78rem;
    background: #f3f4f6; border-bottom: 1px solid #e5e7eb;
  }
  .fixture-card iframe { width: 100%; height: 420px; border: none; display: block; }

  .footer-bar {
    position: fixed; bottom: 0; left: 0; right: 0;
    background: #111827; padding: 12px 32px;
    display: flex; align-items: center; gap: 16px;
    box-shadow: 0 -4px 16px rgba(0,0,0,0.2); z-index: 100;
  }
  .footer-bar .fb-status { color: #9ca3af; font-size: 0.78rem; }
  #push-btn {
    margin-left: auto; font-size: 0.82rem; font-weight: 800;
    padding: 9px 22px; border-radius: 6px; border: none; cursor: pointer;
    letter-spacing: 0.04rem; transition: opacity 0.15s;
  }
  #push-btn.ready { background: #137333; color: #fff; }
  #push-btn.blocked { background: #6b7280; color: #d1d5db; cursor: not-allowed; }
  #push-btn.ready:hover { opacity: 0.88; }
  #push-out {
    font-family: ui-monospace, monospace; font-size: 0.72rem;
    color: #9ca3af; max-width: 380px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
</style>
</head>
<body>
<div class="header">
  <h1>🚫 SLOPRADAR — TEST REPORT</h1>
  <span class="status">${statusText}</span>
</div>
<div class="meta">Generated ${esc(report.generatedAt)}</div>

<div class="container">
  <div class="summary-grid">
    <div class="sum-card"><div class="num">${report.total}</div><div class="lbl">Total</div></div>
    <div class="sum-card"><div class="num green">${report.pass}</div><div class="lbl">Passed</div></div>
    <div class="sum-card"><div class="num ${report.fail ? "red" : "green"}">${report.fail}</div><div class="lbl">Failed</div></div>
  </div>

  <h2 class="section">Test results</h2>
  ${suitesHtml}

  <h2 class="section">Feed fixtures (live preview)</h2>
  <div class="fixtures">
    <div class="fixture-card">
      <div class="fc-head">LinkedIn fixture</div>
      <iframe src="fixtures/linkedin.html"></iframe>
    </div>
    <div class="fixture-card">
      <div class="fc-head">X / Twitter fixture</div>
      <iframe src="fixtures/x.html"></iframe>
    </div>
  </div>
</div>

<div class="footer-bar">
  <span class="fb-status">${allPass
    ? "✓ All tests green — safe to push"
    : "✗ Tests failing — fix before pushing"}</span>
  <span id="push-out"></span>
  <button id="push-btn" class="${allPass ? "ready" : "blocked"}"
          ${allPass ? "" : "disabled"}>
    ${allPass ? "▲ Push to git" : "Push blocked"}
  </button>
</div>

<script>
  const btn = document.getElementById("push-btn");
  const out = document.getElementById("push-out");
  const canPush = ${allPass ? "true" : "false"};

  btn.addEventListener("click", async () => {
    if (!canPush) return;
    btn.disabled = true;
    btn.textContent = "Pushing…";
    out.textContent = "";
    try {
      const res = await fetch("/__push", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        btn.textContent = "✓ Pushed";
        btn.style.background = "#137333";
        out.textContent = data.message || "Pushed successfully";
      } else {
        btn.textContent = "✗ Push failed";
        btn.style.background = "#e02424";
        out.textContent = data.message || "Unknown error";
        btn.disabled = false;
      }
    } catch (err) {
      btn.textContent = "✗ Error";
      btn.style.background = "#e02424";
      out.textContent = String(err);
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;

fs.writeFileSync(path.join(HERE, "report.html"), html);
console.log("report.html written");
