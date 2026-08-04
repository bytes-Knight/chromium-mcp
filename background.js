// background.js — service worker: native-messaging client + MCP tool dispatcher.
'use strict';

importScripts(
  'lib/protocol.js',
  'lib/cdp.js',
  'lib/tabs.js',
  'tools/browser.js',
  'tools/content.js',
  'tools/interaction.js',
  'tools/network.js',
  'tools/screenshot.js',
  'tools/console.js',
  'tools/data.js',
  'tools/inject.js',
  'tools/misc.js'
);

// ---- Native messaging connection --------------------------------------------
let port = null;
let connected = false;
let serverRunning = false;
let startAttempts = 0;
let mcpPort = DEFAULT_MCP_PORT;

const pendingReplies = new Map(); // requestId -> {resolve, reject}

function ensurePort() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    connected = true;
    startAttempts = 0;
    // Ask the host to start the local MCP server
    port.postMessage({ type: MSG.START, payload: { port: mcpPort } });
    updateStatus();
    return port;
  } catch (e) {
    connected = false;
    updateStatus();
    return null;
  }
}

function onPortDisconnect() {
  connected = false;
  port = null;
  serverRunning = false;
  // Reject any in-flight replies
  pendingReplies.forEach((p) => p.reject(new Error('Native host disconnected')));
  pendingReplies.clear();
  updateStatus();
  // Auto-retry a few times (the host may have been restarted)
  if (startAttempts < 5) {
    startAttempts++;
    setTimeout(ensurePort, 1500 * startAttempts);
  }
}

function onNativeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  // Response to one of our outbound requests (we don't send many, but be ready)
  if (msg.responseToRequestId) {
    const pending = pendingReplies.get(msg.responseToRequestId);
    if (pending) {
      pendingReplies.delete(msg.responseToRequestId);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.payload);
    }
    return;
  }

  switch (msg.type) {
    case MSG.SERVER_STARTED:
      serverRunning = true;
      updateStatus();
      break;
    case MSG.SERVER_STOPPED:
      serverRunning = false;
      updateStatus();
      break;
    case MSG.ERROR:
    case MSG.ERROR_FROM_NATIVE_HOST:
      // "already running" / EADDRINUSE is expected when another extension's host
      // already owns the port (or the server is simply already up).
      if (/already running|already in use|EADDRINUSE/i.test(String(msg.payload && msg.payload.message || msg.error || ''))) {
        serverRunning = true;
        updateStatus();
      } else {
        console.warn('[bridge] native host message:', msg.payload && msg.payload.message || msg.error);
      }
      break;
    case MSG.PONG_TO_EXTENSION:
      // liveness ok
      break;
    case MSG.CALL_TOOL:
      handleToolCall(msg);
      break;
    case 'rr_list_published_flows':
      // MCP server discovers dynamic flow tools via the extension; none in clean-room build
      replyToHost(msg.requestId, { status: 'success', items: [] });
      break;
    case 'request_data':
      replyToHost(msg.requestId, { status: 'error', error: 'request_data not supported' });
      break;
    default:
      break;
  }
}

async function handleToolCall(msg) {
  const requestId = msg.requestId;
  const payload = msg.payload || {};
  const name = payload.name;
  const args = payload.args || {};
  try {
    const tool = getTool(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const result = await tool(args);
    replyToHost(requestId, { status: 'success', data: result });
  } catch (e) {
    replyToHost(requestId, { status: 'error', error: String(e.message || e) });
  }
}

function replyToHost(requestId, payload) {
  if (!port) return;
  try {
    port.postMessage({ responseToRequestId: requestId, payload });
  } catch (e) { /* ignore */ }
}

// ---- Status / popup plumbing -------------------------------------------------
// Badge writes are idempotent: we only touch chrome.action when the rendered
// state actually changes, which stops the badge from flickering on retry loops.
// The badge shows ONLY a green "ON" when the MCP server is confirmed running —
// no intermediate states, nothing to blink while connecting/retrying.
let lastBadge = null;
function updateStatus() {
  const text = connected && serverRunning ? 'ON' : '';
  const key = text;
  if (key === lastBadge) return;
  lastBadge = key;
  try {
    chrome.action.setBadgeText({ text });
    if (text) chrome.action.setBadgeBackgroundColor({ color: '#3ddc97' });
  } catch (e) { /* ignore */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'bridge-status') {
    sendResponse({ connected, serverRunning, mcpPort, hostName: HOST_NAME });
    return true;
  }
  if (msg && msg.type === 'bridge-connect') {
    mcpPort = msg.port || DEFAULT_MCP_PORT;
    ensurePort();
    sendResponse({ connected, serverRunning, mcpPort });
    return true;
  }
  if (msg && msg.type === 'bridge-disconnect') {
    try { if (port) { port.postMessage({ type: MSG.STOP }); port.disconnect(); } } catch (e) { /* ignore */ }
    port = null;
    connected = false;
    serverRunning = false;
    updateStatus();
    sendResponse({ connected: false, serverRunning: false });
    return true;
  }
  // Console entries from the content script
  if (msg && msg.type === 'console-entry') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId != null) {
      ingestConsoleEntry(tabId, {
        level: msg.level,
        text: msg.text,
        time: msg.time,
        source: msg.source,
      });
    }
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Keep the worker alive while the native port is open
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge-keepalive' && port) {
    try { port.postMessage({ type: 'ping_from_extension' }); } catch (e) { /* ignore */ }
  }
});

chrome.runtime.onStartup.addListener(() => ensurePort());
chrome.runtime.onInstalled.addListener(() => ensurePort());

// ---- Inbound tool events: download state used by chrome_handle_download ----
globalThis.bridge = {
  get connected() { return connected; },
  get serverRunning() { return serverRunning; },
  get mcpPort() { return mcpPort; },
  get hostName() { return HOST_NAME; },
};

updateStatus();
ensurePort();
