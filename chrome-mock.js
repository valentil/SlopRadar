// chrome-mock.js — fake chrome.* surface for unit tests.
// Supports storage.local, runtime messaging, tabs, action, windows.

function createChromeMock() {
  const storageData = {};
  const messageListeners = [];
  const sentMessages = [];
  let responder = null; // optional override: (request) => response

  const chrome = {
    // ── runtime ──
    runtime: {
      lastError: null,
      onMessage: {
        addListener(fn) { messageListeners.push(fn); },
        _listeners: messageListeners,
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      sendMessage(msg, cb) {
        sentMessages.push(msg);
        // If a responder is set, use it to simulate background replies
        if (responder && typeof cb === "function") {
          const resp = responder(msg);
          // async-like
          Promise.resolve().then(() => cb(resp));
        } else if (typeof cb === "function") {
          Promise.resolve().then(() => cb(undefined));
        }
        return Promise.resolve();
      },
      _sentMessages: sentMessages,
      _setResponder(fn) { responder = fn; },
      _fireMessage(request, sender = {}) {
        // Invoke registered listeners (background-side). Background handlers
        // call sendResponse asynchronously and return `true` to keep the
        // channel open — so we resolve when sendResponse fires, with a
        // timeout fallback for handlers that never respond.
        return new Promise((resolve) => {
          let settled = false;
          const done = (resp) => { if (!settled) { settled = true; resolve(resp); } };
          let anyAsync = false;
          for (const l of messageListeners) {
            const keepOpen = l(request, sender, done);
            if (keepOpen === true) anyAsync = true;
          }
          if (anyAsync) {
            setTimeout(() => done(undefined), 2000);
          } else {
            done(undefined);
          }
        });
      },
    },

    // ── storage ──
    storage: {
      local: {
        get(keys, cb) {
          let out = {};
          if (keys == null) {
            out = { ...storageData };
          } else if (typeof keys === "string") {
            out[keys] = storageData[keys];
          } else if (Array.isArray(keys)) {
            keys.forEach(k => { out[k] = storageData[k]; });
          } else {
            Object.keys(keys).forEach(k => {
              out[k] = k in storageData ? storageData[k] : keys[k];
            });
          }
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set(obj, cb) {
          Object.assign(storageData, obj);
          if (cb) cb();
          return Promise.resolve();
        },
        clear(cb) {
          Object.keys(storageData).forEach(k => delete storageData[k]);
          if (cb) cb();
          return Promise.resolve();
        },
        _data: storageData,
      },
    },

    // ── tabs ──
    tabs: {
      _tabs: [{ id: 1, url: "https://www.linkedin.com/feed/", active: true }],
      query(filter, cb) {
        const out = chrome.tabs._tabs.filter(t => {
          if (filter.active != null && t.active !== filter.active) return false;
          return true;
        });
        if (cb) cb(out);
        return Promise.resolve(out);
      },
      get(id, cb) {
        const t = chrome.tabs._tabs.find(x => x.id === id);
        if (typeof cb === "function") {
          if (!t) { chrome.runtime.lastError = { message: "no tab" }; cb(undefined); chrome.runtime.lastError = null; }
          else cb(t);
          return;
        }
        return t ? Promise.resolve(t) : Promise.reject(new Error("no tab"));
      },
      sendMessage(tabId, msg, cb) {
        sentMessages.push({ _toTab: tabId, ...msg });
        if (cb) Promise.resolve().then(() => cb(undefined));
        return Promise.resolve();
      },
      onActivated: { addListener() {} },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },

    // ── windows ──
    windows: {
      getAll(opts, cb) {
        const out = [{ id: 1, focused: true, tabs: chrome.tabs._tabs }];
        if (cb) cb(out);
        return Promise.resolve(out);
      },
      onFocusChanged: { addListener() {} },
    },

    // ── action (badge) ──
    action: {
      _badge: {},
      setBadgeText(o) { chrome.action._badge.text = o.text; },
      setBadgeBackgroundColor(o) { chrome.action._badge.color = o.color; },
      setTitle(o) { chrome.action._badge.title = o.title; },
      setIcon() {},
    },
  };

  return chrome;
}

module.exports = { createChromeMock };
