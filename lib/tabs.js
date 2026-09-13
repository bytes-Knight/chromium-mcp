// lib/tabs.js — tab resolution + script injection helpers.
'use strict';

// Resolve the target tab for a tool call, honoring tabId/windowId/url/background.
async function resolveTab(args = {}) {
  if (args.tabId != null) {
    const tab = await chrome.tabs.get(args.tabId);
    if (!tab) throw new Error(`No tab with id ${args.tabId}`);
    return tab;
  }
  if (args.windowId != null) {
    const [tab] = await chrome.tabs.query({ active: true, windowId: args.windowId });
    if (tab) return tab;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error('No active tab found');
  return active;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// Resolve a set of tab ids from flexible arg shapes:
//   tabIds | ids          -> array of numeric ids
//   tabId                 -> single numeric id
//   url                   -> tabs whose URL matches exactly (after normalization)
//   domain                -> tabs whose hostname is (or ends with) the domain
//   windowId              -> all tabs in that window
//   all                   -> every tab in every window
//   allExcept             -> every tab EXCEPT the given ids
//   pinned | unpinned     -> tabs filtered by pinned state
// With no selector, falls back to the active tab.
async function resolveTabIds(args = {}) {
  let ids = [];
  const pick = (arr) => [...new Set(arr.filter((v) => v != null).map((v) => Number(v)))];

  if (args.tabIds != null || args.ids != null) {
    ids = pick(Array.isArray(args.tabIds) ? args.tabIds : (Array.isArray(args.ids) ? args.ids : [args.tabIds]));
  } else if (args.tabId != null) {
    ids = [Number(args.tabId)];
  } else if (args.url) {
    const tabs = await chrome.tabs.query({});
    const want = normalizeUrl(args.url);
    ids = tabs.filter((t) => t.url && normalizeUrl(t.url) === want).map((t) => t.id);
  } else if (args.domain) {
    const domain = String(args.domain).toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0];
    const tabs = await chrome.tabs.query({});
    ids = tabs.filter((t) => {
      if (!t.url) return false;
      try {
        const host = new URL(t.url).hostname.toLowerCase().replace(/^www\./, '');
        return host === domain || host.endsWith('.' + domain);
      } catch (e) {
        return false;
      }
    }).map((t) => t.id);
  } else if (args.windowId != null) {
    const tabs = await chrome.tabs.query({ windowId: Number(args.windowId) });
    ids = tabs.map((t) => t.id);
  } else if (args.all) {
    const tabs = await chrome.tabs.query({});
    ids = tabs.map((t) => t.id);
  } else if (args.allExcept != null) {
    const keep = new Set(pick(Array.isArray(args.allExcept) ? args.allExcept : [args.allExcept]));
    const tabs = await chrome.tabs.query({});
    ids = tabs.filter((t) => !keep.has(t.id)).map((t) => t.id);
  } else if (args.pinned != null) {
    const tabs = await chrome.tabs.query({});
    ids = tabs.filter((t) => t.pinned === !!args.pinned).map((t) => t.id);
  }

  if (!ids.length) {
    const tab = await resolveTab(args);
    ids = [tab.id];
  }
  return ids;
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href.replace(/\/$/, '');
  } catch (e) {
    return String(u).replace(/\/$/, '');
  }
}

// Navigate a tab to url and wait for it to finish loading.
async function navigateTab(tab, url, { background = false } = {}) {
  const updated = await chrome.tabs.update(tab.id, { url });
  if (!background) {
    try { await chrome.tabs.update(tab.id, { active: true }); } catch (e) { /* ignore */ }
  }
  await waitForTabComplete(tab.id, 30000);
  return updated;
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Inject a function into a tab. `func` must be self-contained (no closures).
async function executeInTab(tabId, func, args = [], opts = {}) {
  const { world = 'ISOLATED', frameId } = opts;
  const target = { tabId };
  if (frameId != null) target.frameIds = [frameId];
  const results = await chrome.scripting.executeScript({
    target,
    world,
    func,
    args,
  });
  if (!results || !results[0]) return undefined;
  const r = results[0];
  if (r.error) throw new Error(r.error.message || String(r.error));
  return r.result;
}

async function getAllFrames(tabId) {
  try {
    return await chrome.webNavigation.getAllFrames({ tabId });
  } catch (e) {
    return null;
  }
}
