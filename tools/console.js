// tools/console.js — console capture from the page (content script buffer + snapshot).
'use strict';

registerTool('chrome_console', async (args = {}) => {
  const tab = await resolveTab(args);
  const state = getTabState(tab.id);
  const mode = args.mode === 'buffer' || args.buffer ? 'buffer' : 'snapshot';
  const pattern = args.pattern ? new RegExp(args.pattern.replace(/^\/(.+)\/[a-z]*$/, '$1'), 'i') : null;
  const onlyErrors = !!args.onlyErrors;
  const limit = args.limit || args.maxMessages || 100;
  const clearAfterRead = !!args.clearAfterRead;

  if (mode === 'snapshot') {
    // The content-script buffer is authoritative when it has entries. CDP live
    // capture is only a fallback for when the content script is stale/missing,
    // so we skip it entirely once the buffer is populated (avoids duplicates).
    let messages = state.consoleBuffer.slice(0);
    if (!messages.length) {
      const cdpMessages = await captureConsoleViaCdp(tab.id, args.snapshotMs || 2000);
      if (cdpMessages && cdpMessages.length) messages = dedupeEntries(cdpMessages);
    }
    return ok(formatConsole(messages, pattern, onlyErrors, limit, clearAfterRead ? tab.id : null));
  }

  // buffer mode
  const messages = state.consoleBuffer.slice(0);
  if (clearAfterRead) state.consoleBuffer = [];
  return ok(formatConsole(messages, pattern, onlyErrors, limit, null));
});

// Attach the debugger, enable Runtime, and collect console events for the
// given window. Returns raw entries or null if the debugger is unavailable.
async function captureConsoleViaCdp(tabId, ms) {
  const entries = [];
  let attached = false;
  const onEvent = (debuggee, method, params) => {
    if (!debuggee || debuggee.tabId !== tabId) return;
    if (method === 'Runtime.consoleAPICalled') {
      const type = params.type || 'log';
      const level = type === 'warning' ? 'warn' : type === 'error' ? 'error' : type === 'info' ? 'info' : type === 'debug' ? 'debug' : 'log';
      const text = (params.args || []).map((a) => a.value != null ? String(a.value) : (a.description || a.unserializableValue || a.type || '')).join(' ');
      if (text) entries.push({ level, text: text.slice(0, 4000), time: Date.now(), source: 'cdp.' + type });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'Uncaught exception';
      entries.push({ level: 'error', text: String(text).slice(0, 4000), time: Date.now(), source: 'cdp.exception' });
    }
  };
  try {
    await cdpAttach(tabId);
    attached = true;
    chrome.debugger.onEvent.addListener(onEvent);
    await cdpSend(tabId, 'Runtime.enable', {});
    await sleep(ms);
    await cdpSend(tabId, 'Runtime.disable', {});
  } catch (e) {
    return null;
  } finally {
    if (attached) {
      chrome.debugger.onEvent.removeListener(onEvent);
      try { await cdpDetach(tabId); } catch (e) { /* ignore */ }
    }
  }
  return entries;
}

function dedupeEntries(entries) {
  // Key on level+text only (not source) so CDP and content-script copies of the
  // same event collapse into one.
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = e.level + '|' + e.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function formatConsole(messages, pattern, onlyErrors, limit, clearTabId) {
  let filtered = messages.filter((m) => {
    if (onlyErrors && m.level !== 'error') return false;
    if (pattern) return pattern.test(m.text);
    return true;
  });
  const total = filtered.length;
  filtered = filtered.slice(-limit);
  return {
    tabId: clearTabId || undefined,
    mode: 'console',
    total,
    returned: filtered.length,
    messages: filtered.map((m) => ({
      level: m.level,
      text: m.text,
      time: m.time,
      source: m.source,
    })),
  };
}

// Called by the content script bridge.
function ingestConsoleEntry(tabId, entry) {
  const state = getTabState(tabId);
  state.consoleBuffer.push(entry);
  if (state.consoleBuffer.length > 5000) state.consoleBuffer.splice(0, state.consoleBuffer.length - 5000);
}
globalThis.ingestConsoleEntry = ingestConsoleEntry;
