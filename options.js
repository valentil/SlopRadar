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
      document.getElementById("s-universal-mode").checked = s.universalMode !== false;
  document.getElementById("s-hide-slop").checked = !!s.hideSlop;
  document.getElementById("s-min-conf").value = s.minConfidence ?? 60;
    document.getElementById("s-min-conf-val").textContent = `${s.minConfidence ?? 60}%`;
    applyDark(!!s.darkMode);
  });
}

document.getElementById("s-dark-mode").addEventListener("change", (e) => {
  applyDark(e.target.checked);
});

document.getElementById("s-min-conf").addEventListener("input", (e) => {
  document.getElementById("s-min-conf-val").textContent = `${e.target.value}%`;
});

document.getElementById("save-settings-btn").addEventListener("click", () => {
  const settings = {
    darkMode: document.getElementById("s-dark-mode").checked,
    showTrashCan: document.getElementById("s-trash-can").checked,
    universalMode: document.getElementById("s-universal-mode").checked,
    hideSlop: document.getElementById("s-hide-slop").checked,
    minConfidence: parseInt(document.getElementById("s-min-conf").value, 10),
  };
  chrome.runtime.sendMessage({ action: "saveSettings", settings }, () => {
    toast("✓ Settings saved");
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
  });
}

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
loadStats();
loadSettings();
loadPatterns();
setInterval(loadStats, 3000); // refresh stats + page stats every 3s

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

// ── Excluded sites (universal mode) ───────────────────────────────────────
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
