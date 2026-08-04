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
