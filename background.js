// background.js — service worker: native-messaging client + MCP tool dispatcher.
'use strict';

importScripts(
  'lib/protocol.js',
  'lib/instance.js',
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
  'tools/misc.js',
  'tools/instance.js'
);

// ---- Native messaging connection --------------------------------------------
let port = null;
let connected = false;
let serverRunning = false;
// Each browser instance owns its own MCP port (multi-browser support). We start
// from the persisted port (or the deterministic per-instance default) and only
// move ports on a real EADDRINUSE collision.
let mcpPort = DEFAULT_MCP_PORT;
let portAttempts = 0;

const pendingReplies = new Map(); // requestId -> {resolve, reject}

// Reallocate to the next free port after an EADDRINUSE and reconnect. Used when
// another bridge instance already owns our port — squatting on it would
// silently drive the WRONG browser.
function reallocatePort() {
  try { if (port) port.disconnect(); } catch (e) { /* ignore */ }
  port = null;
  connected = false;
  serverRunning = false;
  mcpPort = BRIDGE_INSTANCE.nextPort(mcpPort);
  BRIDGE_INSTANCE.savePort(mcpPort);
  portAttempts++;
  updateStatus();
  if (portAttempts > BRIDGE_INSTANCE.PORT_SPAN + 2) {
    console.warn('[bridge] gave up finding a free MCP port (all ports in range busy). Click Connect to retry.');
    portAttempts = 0;
    return;
  }
  // Give the loser host a moment to die, then retry on the next port.
  setTimeout(() => ensurePort(), 400);
}

async function ensurePort() {
  if (port) return port;
  // First connect: settle on this instance's port (persisted or deterministic).
  if (mcpPort === DEFAULT_MCP_PORT) {
    const saved = await BRIDGE_INSTANCE.getSavedPort();
    mcpPort = saved || (await BRIDGE_INSTANCE.defaultPort());
  }
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    connected = true;
    // Ask the host to start the local MCP server on THIS instance's port.
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
  // Auto-retry via alarms (SW-safe — setTimeout gets throttled in a service
  // worker, and giving up after N tries leaves the bridge dead until the user
  // clicks Connect). The alarm keeps retrying every 30s until we're back.
  chrome.alarms.create('bridge-reconnect', { periodInMinutes: 0.5 });
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
      portAttempts = 0;
      // Persist the port we actually bound so restarts keep the same endpoint.
      BRIDGE_INSTANCE.savePort(mcpPort);
      chrome.alarms.clear('bridge-reconnect');
      updateStatus();
      break;
    case MSG.SERVER_STOPPED:
      serverRunning = false;
      updateStatus();
      break;
    case MSG.ERROR:
    case MSG.ERROR_FROM_NATIVE_HOST:
      // EADDRINUSE: another process owns our port. With multiple browsers each
      // running their own bridge instance this must NOT be treated as "already
      // running" — it likely means a DIFFERENT browser squatted on our port.
      // Reallocate to the next free port instead (harmless even when the stale
      // host was our own: it dies with the dead connection and we get a fresh
      // one on the new port).
      if (/already running|already in use|EADDRINUSE|in use by another/i.test(String(msg.payload && msg.payload.message || msg.error || ''))) {
        reallocatePort();
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
    (async () => {
      const [instanceId, label, browser] = await Promise.all([
        BRIDGE_INSTANCE.getInstanceId(),
        BRIDGE_INSTANCE.getLabel(),
        BRIDGE_INSTANCE.getBrowserInfo(),
      ]);
      sendResponse({ connected, serverRunning, mcpPort, hostName: HOST_NAME, instanceId, label, browser });
    })();
    return true;
  }
  if (msg && msg.type === 'bridge-connect') {
    if (msg.port && parseInt(msg.port, 10) !== mcpPort) {
      // Explicit port from the popup: honor it and persist (user override).
      mcpPort = parseInt(msg.port, 10) || DEFAULT_MCP_PORT;
      BRIDGE_INSTANCE.savePort(mcpPort);
    }
    ensurePort();
    sendResponse({ connected, serverRunning, mcpPort });
    return true;
  }
  if (msg && msg.type === 'bridge-set-label') {
    BRIDGE_INSTANCE.setLabel(msg.label);
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'bridge-next-port') {
    // Force-reallocate to the next port (conflict resolution / manual move).
    reallocatePort();
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
  if (alarm.name === 'bridge-reconnect') {
    if (!port && !connected) {
      ensurePort();
    } else {
      chrome.alarms.clear('bridge-reconnect');
    }
  } else if (alarm.name === 'bridge-keepalive' && port) {
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
