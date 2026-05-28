// options.js

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg, duration = 2200) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), duration);
}

// ── Tab navigation ────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");
  });
});

// ── Dark mode ─────────────────────────────────────────────────────────────
function applyDark(on) {
  if (on) document.documentElement.setAttribute("data-dark", "");
  else document.documentElement.removeAttribute("data-dark");
}

// ── Stats panel ───────────────────────────────────────────────────────────
function renderStats(stats, pageStats) {
  const checked = stats.totalChecked || 0;
  const slop = stats.totalSlop || 0;
  const rate = checked > 0 ? Math.round((slop / checked) * 100) : 0;

  document.getElementById("st-total-checked").textContent = checked.toLocaleString();
  document.getElementById("st-total-slop").textContent = slop.toLocaleString();
  document.getElementById("st-block-rate").textContent = `${rate}%`;

  // Page stats row
  const ps = pageStats || { checked: 0, slop: 0 };
  const pgEl = document.getElementById("st-page-row");
  if (pgEl) {
    pgEl.innerHTML = `
      <td style="font-weight:600;color:var(--text2);font-style:italic">this page</td>
      <td>${ps.checked.toLocaleString()}</td>
      <td style="color:var(--red);font-weight:700">${ps.slop.toLocaleString()}</td>
      <td>
        <div class="pct-bar">
          <div class="pct-track"><div class="pct-fill" style="width:${ps.checked > 0 ? Math.round((ps.slop/ps.checked)*100) : 0}%"></div></div>
          <span style="font-size:0.72rem;color:var(--text2);min-width:30px">${ps.checked > 0 ? Math.round((ps.slop/ps.checked)*100) : 0}%</span>
        </div>
      </td>`;
  }

  const tbody = document.getElementById("site-tbody");
  const sites = Object.entries(stats.perSite || {})
    .sort((a, b) => b[1].checked - a[1].checked);

  if (sites.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--text2);padding:16px 10px">No data yet — visit LinkedIn or X to start scanning</td></tr>`;
    return;
  }

  tbody.innerHTML = sites.map(([host, s]) => {
    const pct = s.checked > 0 ? Math.round((s.slop / s.checked) * 100) : 0;
    return `
      <tr>
        <td style="font-weight:600">${host}</td>
        <td>${s.checked.toLocaleString()}</td>
        <td style="color:var(--red);font-weight:700">${s.slop.toLocaleString()}</td>
        <td>
          <div class="pct-bar">
            <div class="pct-track"><div class="pct-fill" style="width:${pct}%"></div></div>
            <span style="font-size:0.72rem;color:var(--text2);min-width:30px">${pct}%</span>
          </div>
        </td>
      </tr>`;
  }).join("");
}

let pageStatsCache = { checked: 0, slop: 0 };
let queueSizeCache = 0;

function loadPageStats() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: "getPageStats" }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      pageStatsCache = res.pageStats ?? { checked: 0, slop: 0 };
      queueSizeCache = res.queueSize ?? 0;
      updateQueuePill(queueSizeCache);
      // Rerender stats with fresh page data
      chrome.runtime.sendMessage({ action: "getStats" }, (stats) => {
        if (chrome.runtime.lastError || !stats) return;
        renderStats(stats, pageStatsCache);
      });
    });
  });
}

function loadStats() {
  chrome.runtime.sendMessage({ action: "getStats" }, (stats) => {
    if (chrome.runtime.lastError || !stats) return;
    renderStats(stats, pageStatsCache);
  });
  loadPageStats();
}

function updateQueuePill(size) {
  const pill = document.getElementById("queue-pill");
  const label = document.getElementById("queue-label");
  const card = document.getElementById("st-queue");
  if (pill && label) {
    if (size > 0) {
      pill.classList.add("active");
      label.textContent = `${size} queued`;
    } else {
      pill.classList.remove("active");
      label.textContent = "Queue idle";
    }
  }
  if (card) {
    card.textContent = size > 0 ? size.toLocaleString() : "—";
    card.style.color = size > 0 ? "var(--red)" : "";
  }
}

// Queue size also pushed from background
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "queueSize") {
    queueSizeCache = request.size;
    updateQueuePill(request.size);
  }
});

// ── Settings panel ────────────────────────────────────────────────────────
let currentSettings = {};

function loadSettings() {
  chrome.runtime.sendMessage({ action: "getSettings" }, (s) => {
    if (chrome.runtime.lastError || !s) return;
    currentSettings = s;
    document.getElementById("s-dark-mode").checked = !!s.darkMode;
    document.getElementById("s-trash-can").checked = s.showTrashCan !== false;
    document.getElementById("s-hide-slop").checked = !!s.hideSlop;
    document.getElementById("s-remove-entirely").checked = !!s.removeEntirely;
    document.getElementById("s-noninstrusive").checked = !!s.nonIntrusiveMode;
    document.getElementById("s-training-buttons").checked = s.showTrainingButtons !== false;
    document.getElementById("s-min-conf").value = s.minConfidence ?? 90;
    document.getElementById("s-min-conf-val").textContent = `${s.minConfidence ?? 90}%`;
    applyDark(!!s.darkMode);
  });
}

document.getElementById("s-dark-mode").addEventListener("change", (e) => {
  applyDark(e.target.checked);
});

document.getElementById("s-min-conf").addEventListener("input", (e) => {
  document.getElementById("s-min-conf-val").textContent = `${e.target.value}%`;
});

// "Hide slop entirely", "Remove slop entirely", and "Non-intrusive" are
// three DISTINCT, mutually-exclusive display modes — not independent flags.
// Turning one on turns the others off (radio-like), but each can also be
// turned fully off to return to the default blur/banner treatment.
const DISPLAY_MODE_IDS = ["s-hide-slop", "s-remove-entirely", "s-noninstrusive"];
DISPLAY_MODE_IDS.forEach(id => {
  document.getElementById(id).addEventListener("change", (e) => {
    if (e.target.checked) {
      // Uncheck the other display modes — only one can be active.
      DISPLAY_MODE_IDS.filter(o => o !== id)
        .forEach(o => { document.getElementById(o).checked = false; });
      // Non-intrusive additionally hides training buttons (they'd be pointless).
      if (id === "s-noninstrusive") {
        document.getElementById("s-training-buttons").checked = false;
      }
    }
  });
});

document.getElementById("save-settings-btn").addEventListener("click", () => {
  const settings = {
    // preserve fields not exposed as toggles here (e.g. excludedSites)
    ...currentSettings,
    darkMode: document.getElementById("s-dark-mode").checked,
    showTrashCan: document.getElementById("s-trash-can").checked,
    hideSlop: document.getElementById("s-hide-slop").checked,
    removeEntirely: document.getElementById("s-remove-entirely").checked,
    nonIntrusiveMode: document.getElementById("s-noninstrusive").checked,
    showTrainingButtons: document.getElementById("s-training-buttons").checked,
    minConfidence: parseInt(document.getElementById("s-min-conf").value, 10),
  };
  chrome.runtime.sendMessage({ action: "saveSettings", settings }, () => {
    toast("✓ Settings saved");
    currentSettings = settings;
    // Notify all content scripts settings changed
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { action: "settingsUpdated", settings }).catch(() => {});
      });
    });
  });
});

// ── Patterns panel ────────────────────────────────────────────────────────
let patterns = [];

function renderPatterns() {
  const list = document.getElementById("pattern-list");
  document.getElementById("patterns-count").textContent = `${patterns.length} patterns`;

  list.innerHTML = "";
  patterns.forEach((p, i) => {
    const tag = document.createElement("div");
    tag.className = "pattern-tag";
    tag.innerHTML = `
      <span class="ptxt">${escHtml(p)}</span>
      <button class="pdel" title="Remove" data-idx="${i}">✕</button>
    `;
    list.appendChild(tag);
  });

  list.querySelectorAll(".pdel").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      patterns.splice(idx, 1);
      saveCurrentPatterns();
      renderPatterns();
    });
  });
}

function saveCurrentPatterns(silent = false) {
  chrome.runtime.sendMessage({ action: "savePatterns", patterns }, () => {
    if (!silent) toast("✓ Patterns saved");
  });
}

function loadPatterns() {
  chrome.runtime.sendMessage({ action: "getPatterns" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    patterns = res.patterns || [];
    renderPatterns();
    renderPromptInspector();
  });
}

// ── Prompt inspector ──────────────────────────────────────────────────────
// Mirrors buildPrompt() in background.js so the user can see exactly what the
// model receives. Keep this in sync with background.js if the prompt changes.
function buildPromptPreview(text, pats, platform) {
  const patternList = pats.map(p => `- ${p}`).join("\n");
  const charCount = text.length;

  let lengthGuidance = "";
  if (text && charCount < 80) {
    lengthGuidance = `\n\nLENGTH NOTE — this post is short (${charCount} chars). Short posts are usually replies or casual chatter and don't carry enough signal for confident slop detection. Default to authentic (0) UNLESS the text contains an unambiguous slop signature from the pattern list. Do NOT mark short genuine reactions, questions, agreement, jokes, or short opinions as slop.`;
  } else if (text && charCount < 200) {
    lengthGuidance = `\n\nLENGTH NOTE — this post is medium-length (${charCount} chars). Apply moderate skepticism: require a clear pattern match, not just one weak signal.`;
  }

  let platformGuidance = "";
  if (platform === "linkedin") {
    platformGuidance = `\n\nPLATFORM — LinkedIn. The dominant slop genre here is engagement-bait thought leadership: "here's the deep problem with X", "I'll say the quiet part out loud", "nobody talks about this but…", "the real reason X failed", motivational/career-advice posts with no specific claims, manufactured vulnerability ("I got rejected 47 times and here's what it taught me"). Classify these as slop with high confidence. Recruiters posting roles, people sharing genuine company news, technical content, or specific personal experiences with concrete details are NOT slop.`;
  } else if (platform === "twitter") {
    platformGuidance = `\n\nPLATFORM — X / Twitter. The slop dynamics here differ from LinkedIn:\n- A short post that quote-tweets or references another popular post AND wraps it in a broad AI/tech/society claim is usually slop ("this is the future", "everything has changed").\n- Posts referring to "this image", "this video", "watch this", "look at this" without describing the specific content, paired with a vague sweeping claim, are usually slop.\n- Threads opening with "🧵" or "a thread on…" followed by generic claims are often slop.\n- BUT: news commentary, political opinions, personal takes on current events, financial/policy analysis, sports reactions, jokes, and ordinary opinions are NOT slop just because they're confident. People posting about real events (ceasefires, elections, market moves, official statements) — including officials and reporters — are NOT slop, even with strong framing. Slop requires generic engagement-bait structure, not just confident opinion.`;
  } else if (platform === "reddit" || platform === "threads") {
    platformGuidance = `\n\nPLATFORM — ${platform}. Be conservative: this surface has more genuine discussion than LinkedIn. Require a clear engagement-bait or generic-AI-hype signal — confident opinions, news takes, or personal commentary are NOT slop on their own.`;
  }

  return `You are a careful detector of AI-generated marketing slop and engagement bait on social media. Classify as slop (1) or authentic (0).

SLOP PATTERNS — classify as 1 if ANY of these are present:
${patternList}

AUTHENTIC (0) — a post is authentic if ANY of these apply:
- It reports on or discusses real-world news, events, policy, markets, sports, or politics — even with strong opinions or framing. Confident commentary about real events is not slop.
- It contains specific details: code, error messages, real numbers, named entities, dates, or first-hand experience with concrete particulars.
- It's a genuine question, joke, reaction, or short opinion without engagement-bait structure.
- It makes a narrow, falsifiable claim with supporting evidence.

DO NOT classify as slop just because:
- The author writes confidently or with strong framing.
- The post is about a current event or politically charged topic.
- The author is a public figure, official, journalist, or pundit.
- The post is short (see LENGTH NOTE).${platformGuidance}${lengthGuidance}

Input Text:
"""
${text || "(paste a post above to preview)"}
"""

Respond with ONLY a JSON object like {"slop": 1, "confidence": 87}. No other text.`;
}

function renderPromptInspector() {
  const out = document.getElementById("prompt-inspect-out");
  if (!out) return;
  const testText = document.getElementById("prompt-test-input")?.value || "";
  const platform = document.getElementById("prompt-platform-sel")?.value || "linkedin";
  out.textContent = buildPromptPreview(testText, patterns, platform);
}

(function wirePromptInspector() {
  const toggle = document.getElementById("prompt-inspect-toggle");
  const body = document.getElementById("prompt-inspect-body");
  const input = document.getElementById("prompt-test-input");
  if (!toggle || !body) return;
  toggle.addEventListener("click", () => {
    const showing = body.style.display !== "none";
    body.style.display = showing ? "none" : "block";
    toggle.textContent = showing ? "Show" : "Hide";
    if (!showing) renderPromptInspector();
  });
  if (input) input.addEventListener("input", renderPromptInspector);
  const sel = document.getElementById("prompt-platform-sel");
  if (sel) sel.addEventListener("change", renderPromptInspector);
})();

document.getElementById("add-pattern-btn").addEventListener("click", () => {
  const input = document.getElementById("new-pattern-input");
  const val = input.value.trim();
  if (!val) return;
  patterns.push(val);
  input.value = "";
  saveCurrentPatterns();
  renderPatterns();
  // scroll to bottom
  const list = document.getElementById("pattern-list");
  list.scrollTop = list.scrollHeight;
});

document.getElementById("new-pattern-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("add-pattern-btn").click();
});

document.getElementById("reset-btn").addEventListener("click", () => {
  if (!confirm("Reset all patterns to defaults? This cannot be undone.")) return;
  chrome.runtime.sendMessage({ action: "resetPatterns" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    patterns = res.patterns;
    renderPatterns();
    toast("✓ Patterns reset to defaults");
  });
});

document.getElementById("compact-btn").addEventListener("click", () => {
  const btn = document.getElementById("compact-btn");
  btn.textContent = "⏳ Compacting…";
  btn.disabled = true;
  chrome.runtime.sendMessage({ action: "compactPatterns" }, (res) => {
    btn.textContent = "⚡ Compact with AI";
    btn.disabled = false;
    if (chrome.runtime.lastError || !res) { toast("⚠ Compact failed"); return; }
    patterns = res.patterns;
    renderPatterns();
    toast(`✓ Compacted to ${patterns.length} patterns`);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── Pause/Resume ──────────────────────────────────────────────────────────
let paused = false;
const pauseBtn = document.getElementById("pause-btn");

function applyPauseUI() {
  if (!pauseBtn) return;
  if (paused) {
    pauseBtn.textContent = "▶ RESUME";
    pauseBtn.classList.add("paused");
  } else {
    pauseBtn.textContent = "⏸ PAUSE";
    pauseBtn.classList.remove("paused");
  }
}

chrome.runtime.sendMessage({ action: "getPauseState" }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  paused = res.paused;
  applyPauseUI();
});

pauseBtn?.addEventListener("click", () => {
  paused = !paused;
  chrome.runtime.sendMessage({ action: "setPauseState", paused }, () => {
    applyPauseUI();
    toast(paused ? "⏸ SlopRadar paused" : "▶ SlopRadar resumed");
  });
});

// ── Init ──────────────────────────────────────────────────────────────────
// Pull version straight from manifest so the header can't go stale.
try {
  const v = chrome.runtime.getManifest()?.version;
  const verEl = document.getElementById("header-version");
  if (v && verEl) verEl.textContent = `AI feed filter — v${v}`;
  const aboutEl = document.getElementById("about-version");
  if (v && aboutEl) aboutEl.textContent = `v${v} — uses Gemini Nano on-device`;
} catch (_) {}

loadStats();
loadSettings();
loadPatterns();
loadEngineStatus();
setInterval(loadStats, 3000); // refresh stats + page stats every 3s
setInterval(loadEngineStatus, 5000); // refresh engine health

// ── Local AI engine status + manual kickstart ─────────────────────────────
// Track consecutive "not ready" status checks so the popup can auto-trigger
// a kickstart when the model is stuck initializing. Once was enough manually,
// according to user feedback — the trick is just trying again.
let notReadyStreak = 0;
let popupAutoKickAt = 0;
function loadEngineStatus() {
  chrome.runtime.sendMessage({ action: "getEngineStatus" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    const label = document.getElementById("engine-status-label");
    const desc = document.getElementById("engine-status-desc");
    if (!label || !desc) return;

    if (res.availability === "unsupported") {
      label.textContent = "Not available";
      label.style.color = "var(--text2)";
      desc.textContent = "This browser doesn't have the built-in Gemini Nano model.";
      notReadyStreak = 0;
    } else if (res.availability === "downloadable" || res.availability === "downloading") {
      label.textContent = "Downloading model…";
      label.style.color = "var(--text2)";
      desc.textContent = "Gemini Nano is still downloading to your device. This is a one-time setup.";
      notReadyStreak = 0; // legitimately waiting on download — don't auto-kick
    } else if (!res.ready) {
      label.textContent = "Starting…";
      label.style.color = "var(--text2)";
      desc.textContent = "The local model is initializing.";
      notReadyStreak++;
      // The model often gets stuck here; calling kickstart unblocks it.
      // Only auto-kick if we've been stuck for several polls AND haven't
      // auto-kicked recently — so we don't spam during a legitimate cold start.
      const now = Date.now();
      if (notReadyStreak >= 2 && now - popupAutoKickAt > 15000) {
        popupAutoKickAt = now;
        chrome.runtime.sendMessage({ action: "kickstartEngine" }, () => {
          loadEngineStatus();
        });
      }
    } else if (res.recentFailures >= 2) {
      label.textContent = "⚠ Struggling";
      label.style.color = "var(--red, #e02424)";
      desc.textContent = `The model returned ${res.recentFailures} bad results recently. Try Restart if posts aren't being classified.`;
      notReadyStreak = 0;
    } else {
      label.textContent = "✓ Ready";
      label.style.color = "var(--green, #137333)";
      desc.textContent = "Gemini Nano runs on your device — nothing leaves your browser.";
      notReadyStreak = 0;
    }
  });
}

(function wireKickstart() {
  const btn = document.getElementById("kickstart-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "Restarting…";
    chrome.runtime.sendMessage({ action: "kickstartEngine" }, (res) => {
      btn.disabled = false;
      if (chrome.runtime.lastError || !res?.ok) {
        btn.textContent = "✗ Failed";
        setTimeout(() => { btn.textContent = orig; }, 2500);
        return;
      }
      btn.textContent = "✓ Restarted";
      toast("Local AI engine restarted");
      loadEngineStatus();
      setTimeout(() => { btn.textContent = orig; }, 2500);
    });
  });
})();

// ── Site pause controls ───────────────────────────────────────────────────
function loadPausedSites() {
  chrome.storage.local.get(["pausedSites"], (data) => {
    const sites = data.pausedSites || {};
    const list = document.getElementById("s-paused-sites-list");
    const entries = Object.keys(sites);
    if (!list) return;
    if (entries.length === 0) { list.innerHTML = ''; return; }
    list.innerHTML = entries.map(host =>
      `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:0.75rem">
        <span style="flex:1;color:var(--text2)">${host}</span>
        <button class="btn" data-host="${host}" style="font-size:0.65rem;padding:2px 8px">Remove</button>
      </div>`
    ).join("");
    list.querySelectorAll("[data-host]").forEach(btn => {
      btn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ action: "clearSitePause", hostname: btn.dataset.host }, () => {
          loadPausedSites();
          toast(`✓ Unpaused ${btn.dataset.host}`);
        });
      });
    });
  });
}

// Get current tab hostname for pause buttons
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = tabs[0]?.url || "";
  try {
    const host = new URL(url).hostname;
    const lbl = document.getElementById("s-site-pause-label");
    const desc = document.getElementById("s-site-pause-desc");
    if (lbl) lbl.textContent = `Pause on ${host || "current site"}`;
    if (desc) desc.textContent = host ? `Stop SlopRadar on ${host}` : "Navigate to a site first";

    document.getElementById("s-pause-session-btn")?.addEventListener("click", () => {
      if (!host) return;
      chrome.tabs.sendMessage(tabs[0].id, { action: "pauseSiteSession" }).catch(() => {});
      toast(`⏸ Paused on ${host} for this visit`);
    });

    document.getElementById("s-pause-forever-btn")?.addEventListener("click", () => {
      if (!host) return;
      chrome.runtime.sendMessage({ action: "setSitePause", hostname: host, forever: true }, () => {
        chrome.tabs.sendMessage(tabs[0].id, { action: "pauseSiteSession" }).catch(() => {});
        loadPausedSites();
        toast(`🚫 Paused forever on ${host}`);
      });
    });
  } catch (_) {}
});

loadPausedSites();

// ── Log window ────────────────────────────────────────────────────────────
const logWindow = document.getElementById("log-window");
const logCount = document.getElementById("log-count");
const logAutoscroll = document.getElementById("log-autoscroll");
const logPause = document.getElementById("log-pause");
let lastLogCount = -1;

function fmtLogTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loadLogs() {
  if (logPause && logPause.checked) return;
  chrome.runtime.sendMessage({ action: "getLogs" }, (res) => {
    if (chrome.runtime.lastError || !res || !logWindow) return;
    const logs = res.logs || [];
    if (logs.length === lastLogCount) return;
    lastLogCount = logs.length;

    if (logs.length === 0) {
      logWindow.innerHTML =
        '<span style="color:#6e7681">No activity yet — open X or LinkedIn in a tab.</span>';
      if (logCount) logCount.textContent = "0 lines";
      return;
    }

    logWindow.innerHTML = logs.map(entry => {
      const time = `<span style="color:#6e7681">${fmtLogTime(entry.ts)}</span>`;
      const host = entry.host
        ? `<span style="color:#58a6ff">${escapeHtml(entry.host)}</span> `
        : "";
      let lineColor = "#c9d1d9";
      const lower = (entry.line || "").toLowerCase();
      if (lower.includes("\u26a0") || lower.includes("error") || lower.includes("not responding")) {
        lineColor = "#f0883e";
      } else if (lower.includes("enqueued") && !lower.includes("enqueued 0")) {
        lineColor = "#7ee787";
      }
      const line = `<span style="color:${lineColor}">${escapeHtml(entry.line)}</span>`;
      return `${time} ${host}${line}`;
    }).join("\n");

    if (logCount) logCount.textContent = `${logs.length} line${logs.length === 1 ? "" : "s"}`;
    if (logAutoscroll && logAutoscroll.checked) logWindow.scrollTop = logWindow.scrollHeight;
  });
}

const logClearBtn = document.getElementById("log-clear-btn");
if (logClearBtn) {
  logClearBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "clearLogs" }, () => {
      lastLogCount = -1;
      loadLogs();
      toast("Logs cleared");
    });
  });
}

setInterval(() => {
  const logsPanel = document.getElementById("panel-logs");
  if (logsPanel && logsPanel.classList.contains("active")) loadLogs();
}, 1000);

document.querySelectorAll(".tab-btn").forEach(btn => {
  if (btn.dataset.tab === "logs") {
    btn.addEventListener("click", () => { lastLogCount = -1; loadLogs(); });
  }
});

// ── Excluded sites (skip specific supported hosts) ────────────────────────
function loadExcludedSites() {
  const list = document.getElementById("s-excluded-list");
  if (!list) return;
  chrome.runtime.sendMessage({ action: "getSettings" }, (s) => {
    if (chrome.runtime.lastError || !s) return;
    const sites = s.excludedSites || [];
    if (sites.length === 0) {
      list.innerHTML =
        '<span style="font-size:0.7rem;color:var(--text2)">No custom exclusions. ' +
        'Common sites (ChatGPT, Claude, Gmail, etc.) are skipped automatically.</span>';
      return;
    }
    list.innerHTML = sites.map(host =>
      `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:0.75rem">
        <span style="flex:1;color:var(--text2)">${escapeHtml(host)}</span>
        <button class="btn" data-exclude="${escapeHtml(host)}" style="font-size:0.65rem;padding:2px 8px">Remove</button>
      </div>`
    ).join("");
    list.querySelectorAll("[data-exclude]").forEach(btn => {
      btn.addEventListener("click", () => {
        const host = btn.dataset.exclude;
        chrome.runtime.sendMessage({ action: "getSettings" }, (cur) => {
          const next = (cur.excludedSites || []).filter(h => h !== host);
          chrome.runtime.sendMessage(
            { action: "saveSettings", settings: { ...cur, excludedSites: next } },
            () => { loadExcludedSites(); toast(`Removed ${host}`); }
          );
        });
      });
    });
  });
}

const excludeAddBtn = document.getElementById("s-exclude-add-btn");
if (excludeAddBtn) {
  excludeAddBtn.addEventListener("click", () => {
    const input = document.getElementById("s-exclude-input");
    const raw = ((input && input.value) || "").trim().toLowerCase()
      .replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!raw) return;
    chrome.runtime.sendMessage({ action: "getSettings" }, (cur) => {
      const existing = cur.excludedSites || [];
      if (existing.includes(raw)) { toast("Already excluded"); return; }
      chrome.runtime.sendMessage(
        { action: "saveSettings", settings: { ...cur, excludedSites: [...existing, raw] } },
        () => { input.value = ""; loadExcludedSites(); toast(`Excluded ${raw}`); }
      );
    });
  });
}

loadExcludedSites();

// ── User-taught patterns (right-click teaching) ───────────────────────────
function renderUserPatterns(list) {
  const box = document.getElementById("user-pattern-list");
  const count = document.getElementById("user-patterns-count");
  if (!box) return;
  if (count) count.textContent = `${list.length}`;

  if (list.length === 0) {
    box.innerHTML =
      '<span style="font-size:0.7rem;color:var(--text2)">' +
      'None yet — right-click a missed post on X or LinkedIn and choose ' +
      '“SlopRadar: mark this as slop”.</span>';
    return;
  }

  box.innerHTML = "";
  list.forEach((entry, i) => {
    const tag = document.createElement("div");
    tag.className = "pattern-tag";
    const src = entry.source
      ? `<span style="font-size:0.62rem;color:var(--text2);display:block;margin-top:2px">from: ${escHtml(entry.source)}</span>`
      : "";
    tag.innerHTML = `
      <span class="ptxt">${escHtml(entry.text)}${src}</span>
      <button class="pdel" title="Remove" data-uidx="${i}">✕</button>
    `;
    box.appendChild(tag);
  });

  box.querySelectorAll(".pdel").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.uidx, 10);
      chrome.runtime.sendMessage({ action: "removeUserPattern", index: idx }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        renderUserPatterns(res.patterns || []);
        toast("Removed taught pattern");
      });
    });
  });
}

function loadUserPatterns() {
  chrome.runtime.sendMessage({ action: "getUserPatterns" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    renderUserPatterns(res.patterns || []);
  });
}

const userClearBtn = document.getElementById("user-clear-btn");
if (userClearBtn) {
  userClearBtn.addEventListener("click", () => {
    if (!confirm("Clear all right-click taught patterns?")) return;
    chrome.runtime.sendMessage({ action: "clearUserPatterns" }, () => {
      renderUserPatterns([]);
      toast("Cleared taught patterns");
    });
  });
}

// Refresh taught patterns whenever the Patterns tab is opened
document.querySelectorAll(".tab-btn").forEach(btn => {
  if (btn.dataset.tab === "patterns") {
    btn.addEventListener("click", loadUserPatterns);
  }
});

loadUserPatterns();

// ── Not-slop correction log ───────────────────────────────────────────────
function renderNotSlopLog(log) {
  const list = document.getElementById("notslop-log-list");
  const count = document.getElementById("notslop-log-count");
  if (!list) return;
  if (count) count.textContent = log.length;

  if (log.length === 0) {
    list.innerHTML = '<span style="font-size:0.7rem;color:var(--text2)">No corrections yet — click "Not slop" on a flagged post to see updates here.</span>';
    return;
  }

  list.innerHTML = [...log].reverse().map(entry => {
    const d = new Date(entry.ts || 0);
    const r = entry.removed || 0, n = entry.narrowed || 0;
    const noChange = r === 0 && n === 0;
    const removedHtml = (entry.removedPatterns || []).slice(0, 3)
      .map(p => `<div style="color:#f85149;font-size:0.68rem;padding:1px 0">— ${escHtml(p)}</div>`).join("");
    const narrowedHtml = (entry.narrowedPatterns || []).slice(0, 3)
      .map(p => `<div style="color:#e3b341;font-size:0.68rem;padding:1px 0">~ ${escHtml(p)}</div>`).join("");
    return `<div style="padding:7px 0;border-bottom:1px solid var(--border)">
      <div style="font-size:0.62rem;color:var(--text2)">${d.toLocaleString()}</div>
      <div style="font-size:0.72rem;color:var(--text);margin:2px 0">"${escHtml((entry.snippet||"").substring(0,60))}…"</div>
      ${noChange
        ? `<div style="font-size:0.68rem;color:var(--text2)">${escHtml(entry.reasoning||"No patterns changed")}</div>`
        : removedHtml + narrowedHtml + (entry.reasoning ? `<div style="font-size:0.68rem;color:var(--text2);margin-top:2px">${escHtml(entry.reasoning)}</div>` : "")}
    </div>`;
  }).join("");
}

function loadNotSlopLog() {
  chrome.runtime.sendMessage({ action: "getNotSlopLog" }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    renderNotSlopLog(res.log || []);
  });
}

const notSlopClearBtn = document.getElementById("notslop-log-clear-btn");
if (notSlopClearBtn) {
  notSlopClearBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "clearNotSlopLog" }, () => {
      renderNotSlopLog([]);
      toast("Cleared not-slop log");
    });
  });
}

// Load when Patterns tab is opened.
document.querySelectorAll(".tab-btn").forEach(btn => {
  if (btn.dataset.tab === "patterns") {
    btn.addEventListener("click", loadNotSlopLog);
  }
});

loadNotSlopLog();
