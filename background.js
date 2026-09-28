// background.js — service worker: native-messaging client + MCP tool dispatcher.
'use strict';

importScripts(
  'lib/protocol.js',
  'lib/instance.js',
  'lib/cdp.js',
  'lib/tabs.js',
  'lib/gif-encoder.js',
  'lib/published-tools.js',
  'tools/browser.js',
  'tools/content.js',
  'tools/interaction.js',
  'tools/network.js',
  'tools/screenshot.js',
  'tools/console.js',
  'tools/data.js',
  'tools/data-ext.js',
  'tools/windows.js',
  'tools/perf.js',
  'tools/gif.js',
  'tools/inject.js',
  'tools/flows.js',
  'tools/proxy.js',
  'tools/misc.js',
  'tools/instance.js'
);

// ---- Native messaging connection --------------------------------------------
let port = null;
let connected = false;
let serverRunning = false;
// Which wire the current port sits on:
//   'manual' — bridge-host.exe, reached over loopback WebSocket (no browser spawn)
//   'native' — chrome.runtime.connectNative(HOST_NAME), spawned BY the browser
//   'none'   — not connected
let transport = 'none';
// Each browser instance owns its own MCP port (multi-browser support). We start
// from the persisted port (or the deterministic per-instance default) and only
// move ports on a real EADDRINUSE collision.
let mcpPort = DEFAULT_MCP_PORT;
let portAttempts = 0;
let explicitPort = false; // set when the user pins a port in the popup

const pendingReplies = new Map(); // requestId -> {resolve, reject}

// ---- diagnostics: nothing about this bridge may fail silently ----------------
// Every connect attempt / failure / death is recorded into chrome.storage.local
// with a timestamp. The popup renders the tail of it, and it survives service-
// worker restarts (so "it was offline an hour ago, why?" is answerable).
async function diag(event, extra) {
  try {
    const entry = Object.assign({
      t: new Date().toISOString(),
      event,
      port: mcpPort,
      connected,
      serverRunning,
    }, extra || {});
    const cur = (await chrome.storage.local.get('bridgeDiag')).bridgeDiag || [];
    cur.push(entry);
    while (cur.length > 40) cur.shift();
    await chrome.storage.local.set({ bridgeDiag: cur });
  } catch (e) { /* diagnostics must never break the bridge */ }
}

// Reallocate to the next free port after an EADDRINUSE and reconnect. Used when
// another bridge instance already owns our port — squatting on it would
// silently drive the WRONG browser.
function reallocatePort() {
  try { if (port) port.disconnect(); } catch (e) { /* ignore */ }
  port = null;
  connected = false;
  serverRunning = false;
  transport = 'none';
  mcpPort = BRIDGE_INSTANCE.nextPort(mcpPort);
  // Deliberately NOT persisted: an automatic move is session-only, so the next
  // launch retries this instance's deterministic default instead of ratcheting
  // one port higher each time (see getPinnedPort in lib/instance.js).
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

// ---- Manual host transport (app/dist/bridge-host.exe) -----------------------
// The browser spawning the native-messaging host is the one link this extension
// cannot repair from the inside: on this machine Brave accepts connectNative(),
// then kills the pipe ~1ms later without ever creating a host process, so the
// bridge stays 'offline' however the host is registered. Running the standalone
// host by hand removes the browser from that path: it starts the same host
// process and speaks the same wire protocol over a loopback WebSocket.
// The shim below exposes the exact surface the rest of this file uses
// (postMessage / onMessage / onDisconnect / disconnect), so every tool, the popup
// and mcpctl behave identically no matter which transport won.
const MANUAL_HOST_DEFAULT = 'ws://127.0.0.1:12400';
const MANUAL_HOST_TIMEOUT_MS = 1200;
let manualHostUrl = MANUAL_HOST_DEFAULT;

async function refreshManualHostUrl() {
  try {
    const s = await chrome.storage.local.get('bridgeWsUrl');
    if (s && typeof s.bridgeWsUrl === 'string' && /^wss?:\/\/\S+$/i.test(s.bridgeWsUrl)) manualHostUrl = s.bridgeWsUrl;
  } catch (e) { /* keep the default */ }
  return manualHostUrl;
}

// Resolve to the open socket, or null if nothing is listening (a refused
// loopback connection fails instantly, so the fallback to native messaging costs
// nothing when bridge-host.exe is not running).
function openManualSocket(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let ws = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      ws = new WebSocket(url);
    } catch (e) {
      finish(null);
      return;
    }
    timer = setTimeout(() => { try { ws.close(); } catch (e) {} finish(null); }, timeoutMs);
    ws.onopen = () => finish(ws);
    ws.onclose = () => finish(null);
    ws.onerror = () => { /* onclose follows and settles it */ };
  });
}

function makeManualPort(ws) {
  const msgListeners = [];
  const discListeners = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return; // the host speaks JSON text frames
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    for (const fn of msgListeners.slice()) { try { fn(msg); } catch (e) { console.warn('[bridge] listener threw:', e && e.message); } }
  };
  ws.onclose = () => {
    for (const fn of discListeners.slice()) { try { fn(); } catch (e) { /* ignore */ } }
  };
  return {
    isManual: true,
    postMessage(msg) {
      if (ws.readyState !== 1) return; // 1 = OPEN
      try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
    },
    disconnect() { try { ws.close(); } catch (e) { /* ignore */ } },
    onMessage: { addListener: (fn) => { if (typeof fn === 'function') msgListeners.push(fn); } },
    onDisconnect: { addListener: (fn) => { if (typeof fn === 'function') discListeners.push(fn); } },
  };
}

async function connectManualHost() {
  const url = await refreshManualHostUrl();
  const ws = await openManualSocket(url, MANUAL_HOST_TIMEOUT_MS);
  if (!ws) { diag('manual-failed', { url }); return null; }
  return makeManualPort(ws);
}

async function ensurePort() {
  if (port) return port;
  // First connect: settle on this instance's port (persisted or deterministic).
  if (mcpPort === DEFAULT_MCP_PORT) {
    const saved = await BRIDGE_INSTANCE.getPinnedPort();
    mcpPort = saved || (await BRIDGE_INSTANCE.defaultPort());
  }
  // 1) MANUAL HOST FIRST. If bridge-host.exe is running we use it and the whole
  // chain stops depending on the browser's native-messaging spawn.
  const manual = await connectManualHost();
  if (manual) {
    port = manual;
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    connected = true;
    transport = 'manual';
    // Same handshake as always — the host starts its MCP server on THIS
    // instance's port, so mcpctl keeps discovering it in 12306-12340.
    port.postMessage({ type: MSG.START, payload: { port: mcpPort } });
    diag('manual-connected', { url: manualHostUrl });
    updateStatus();
    return port;
  }

  // 2) Native messaging — used whenever the manual host is not listening.
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(onNativeMessage);
    port.onDisconnect.addListener(onPortDisconnect);
    connected = true;
    transport = 'native';
    // Ask the host to start the local MCP server on THIS instance's port.
    port.postMessage({ type: MSG.START, payload: { port: mcpPort } });
    diag('native-connected', { host: HOST_NAME });
    updateStatus();
    return port;
  } catch (e) {
    connected = false;
    serverRunning = false;
    transport = 'none';
    // Clear the stale "MCP server running" pill: with no host there is no server.
    updateStatus();
    warnHostUnavailable(e);
    diag('native-failed', { host: HOST_NAME, error: (e && e.message) || String(e), manualUrl: manualHostUrl });
    noteConnectFailure();
    scheduleReconnect();
    return null;
  }
}

const RECONNECT_ALARM = 'bridge-reconnect';
let reconnectAttempts = 0;
let warnedNoHost = false;
let lastHostError = null;

// A zombie port is the #1 cause of "offline forever": the SW restarts with a
// stale mcpPort that some dead instance squatted, every connect dies before it
// starts, and the alarm loop just repeats the same failure. Fixed by making
// reconnects FORWARD the port on repeated failure (rolling, session-only),
// which both dodges the squatter and eventually lands on a free slot.
const MAX_PORT_ATTEMPTS_BEFORE_MOVE = 3;
let failedConnectAttempts = 0; // consecutive connect failures on the CURRENT port
function noteConnectFailure() {
  failedConnectAttempts += 1;
  if (failedConnectAttempts >= MAX_PORT_ATTEMPTS_BEFORE_MOVE && portAttempts <= BRIDGE_INSTANCE.PORT_SPAN + 2) {
    console.warn('[bridge] ' + failedConnectAttempts + ' consecutive connect failures on port ' + mcpPort + ' - moving to the next port');
    failedConnectAttempts = 0;
    try { if (port) { try { port.disconnect(); } catch (e) {} } } catch (e) {}
    port = null;
    connected = false;
    serverRunning = false;
    transport = 'none';
    mcpPort = BRIDGE_INSTANCE.nextPort(mcpPort); // session-only; the saved pin is untouched
    portAttempts++;
    updateStatus();
  }
}

// Keep trying to reach the native host without the user clicking anything: a
// few quick warm retries (a browser-start race resolves in seconds) plus a 30s
// alarm that outlives service-worker shutdowns and retries forever.
function scheduleReconnect() {
  try { chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 }); } catch (e) { /* ignore */ }
  if (reconnectAttempts < 4) {
    reconnectAttempts += 1;
    setTimeout(() => { if (!port) ensurePort(); }, 1500 * reconnectAttempts);
  }
}

// connectNative() throws (rather than disconnecting) when no native-messaging
// host manifest is registered for THIS browser profile. Chrome, Brave, Edge,
// Chromium and Opera each keep their own host list, so a host registered for
// Chrome alone leaves the bridge permanently 'offline' in any other browser.
function warnHostUnavailable(e) {
  const native = (e && e.message) || String(e || 'connectNative failed');
  lastHostError = 'no manual host at ' + manualHostUrl + ' — start bridge-host.exe; native messaging also failed (' + native + ')';
  // Put the failure on the toolbar icon: hovering the icon now names the exact
  // reason the bridge is offline - no popup, no console, no guesswork.
  try { chrome.action.setTitle({ title: 'Chrome MCP Bridge — offline: ' + lastHostError }); } catch (err) { /* ignore */ }
  if (warnedNoHost) return;
  warnedNoHost = true;
  console.warn('[bridge] connectNative(' + HOST_NAME + ') failed: ' + lastHostError +
    ' — the native host looks unregistered for this browser profile. ' +
    'Run "mcp-chrome-bridge register" for this browser, then reload the extension.');
}

function onPortDisconnect() {
  diag('pipe-closed', { hostAlive: !!port, transport });
  connected = false;
  port = null;
  serverRunning = false;
  transport = 'none';
  // Reject any in-flight replies
  pendingReplies.forEach((p) => p.reject(new Error('Native host disconnected')));
  pendingReplies.clear();
  updateStatus();
  // The pipe DIED after a successful connectNative - the host process exited
  // (crash, external kill, EADDRINUSE shutdown). Count it like a failed connect
  // so persistent deaths rotate the port instead of hammering the same one.
  noteConnectFailure();
  // Auto-retry via alarms (SW-safe — setTimeout gets throttled in a service
  // worker, and giving up after N tries leaves the bridge dead until the user
  // clicks Connect). The alarm keeps retrying every 30s until we're back.
  scheduleReconnect();
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
      diag('server-started', { port: mcpPort });
      serverRunning = true;
      reconnectAttempts = 0;
      warnedNoHost = false;
      lastHostError = null;
      portAttempts = 0;
      failedConnectAttempts = 0; // port confirmed working end-to-end
      // Only a user-pinned port is persisted (an automatic move stays in this
      // session) so restarts keep a predictable endpoint without ratcheting.
      if (explicitPort) BRIDGE_INSTANCE.savePort(mcpPort);
      chrome.alarms.clear('bridge-reconnect');
      updateStatus();
      break;
    case MSG.SERVER_STOPPED:
      serverRunning = false;
      updateStatus();
      break;
    case MSG.ERROR:
    case MSG.ERROR_FROM_NATIVE_HOST:
      diag('host-error', { message: String((msg.payload && msg.payload.message) || msg.error || '') });
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
      pingOutstanding = 0;
      break;
    case MSG.CALL_TOOL:
      handleToolCall(msg);
      break;
    case 'rr_list_published_flows':
      // MCP server discovers extension-defined tools via this handshake. We
      // publish the tab/window toolkit so clients see them as flow.<slug> tools.
      replyToHost(msg.requestId, {
        status: 'success',
        items: (globalThis.PUBLISHED_TOOLS || []).map(({ tool, ...rest }) => rest),
      });
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
    // GIF auto-capture hook: in action-driven recording mode, a frame is taken
    // after every successful tool call. Fire-and-forget so responses stay fast.
    try {
      if (globalThis.gifAutoCaptureHook) globalThis.gifAutoCaptureHook().catch(() => {});
    } catch (e) { /* ignore */ }
  } catch (e) {
    replyToHost(requestId, { status: 'error', error: String(e.message || e) });
  }
}

function replyToHost(requestId, payload) {
  if (!port) return;
  try {
    // The native host (mcp-chrome-bridge) silently DROPS any single message over
    // its 16MB receive cap (MAX_MESSAGE_SIZE_BYTES). Detect that up front and
    // surface a clear error instead of a response that never arrives.
    const sizeBytes = JSON.stringify({ responseToRequestId: requestId, payload }).length;
    if (sizeBytes > 14 * 1024 * 1024) {
      const mb = Math.round(sizeBytes / 1024 / 1024);
      port.postMessage({
        responseToRequestId: requestId,
        payload: {
          status: 'error',
          error: `Tool result too large (${mb}MB) — the native host caps messages at 16MB. Retry with inline base64/JSON disabled (e.g. includeBase64:false, save:true).`,
        },
      });
      return;
    }
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
  if (msg && msg.type === 'bridge-diag') {
    (async () => {
      const stored = (await chrome.storage.local.get('bridgeDiag')).bridgeDiag || [];
      sendResponse({ connected, serverRunning, mcpPort, hostError: lastHostError, entries: stored.slice(-12) });
    })();
    return true;
  }
  if (msg && msg.type === 'bridge-status') {
    (async () => {
      const [instanceId, label, browser] = await Promise.all([
        BRIDGE_INSTANCE.getInstanceId(),
        BRIDGE_INSTANCE.getLabel(),
        BRIDGE_INSTANCE.getBrowserInfo(),
      ]);
      sendResponse({ connected, serverRunning, mcpPort, hostName: HOST_NAME, instanceId, label, browser, hostError: lastHostError,
        transport, manualHostUrl, failedConnectAttempts, portAttempts, version: chrome.runtime.getManifest().version });
    })();
    return true;
  }
  if (msg && msg.type === 'bridge-ensure') {
    // Idempotent nudge (popup open, external trigger): connect if we aren't
    // already connected, never touch the persisted port.
    (async () => {
      if (!port) await ensurePort();
      sendResponse({ connected, serverRunning, mcpPort });
    })();
    return true;
  }
  if (msg && msg.type === 'bridge-connect') {
    (async () => {
      if (msg.port && parseInt(msg.port, 10) !== mcpPort) {
        // Explicit port from the popup: honor it, pin it, and persist it.
        mcpPort = parseInt(msg.port, 10) || DEFAULT_MCP_PORT;
        explicitPort = true;
        await BRIDGE_INSTANCE.pinPort(mcpPort);
      }
      // Connect means CONNECT: an existing (possibly zombie) pipe must not be
      // trusted - drop it so ensurePort() builds a fresh native-messaging port.
      try { if (port) { try { port.disconnect(); } catch (e) {} } } catch (e) {}
      port = null;
      connected = false;
      serverRunning = false;
      reconnectAttempts = 0; // a human asked - retry budget resets
      await ensurePort();
      // Report the state AFTER the attempt, so the popup shows the truth.
      sendResponse({ connected, serverRunning, mcpPort });
    })();
    return true;
  }
  if (msg && msg.type === 'bridge-set-label') {
    BRIDGE_INSTANCE.setLabel(msg.label);
    sendResponse({ ok: true });
    return true;
  }
  // Intercepting-proxy control (popup toggle + agent calls share one code path).
  if (msg && msg.type === 'bridge-proxy') {
    (async () => {
      const tool = getTool('chrome_proxy');
      if (!tool) { sendResponse({ ok: false, error: 'chrome_proxy not registered' }); return; }
      const res = await tool(msg.args || { action: msg.action });
      let data = null;
      try { data = JSON.parse(res.content[0].text); } catch (e) { data = { raw: res.content[0].text }; }
      sendResponse({ ok: !res.isError, isError: !!res.isError, data });
    })();
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
    transport = 'none';
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

// Keep the worker alive while the native port is open. The ping must VERIFY
// the pong: a pipe that lost its host process stays postable-but-dead, and
// trusting it left the bridge "connected" to nothing. On silence, drop the
// zombie pipe immediately so the reconnect path builds a fresh one.
let pingOutstanding = 0;
chrome.alarms.create('bridge-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bridge-reconnect') {
    if (!port && !connected) {
      ensurePort();
    } else {
      chrome.alarms.clear('bridge-reconnect');
    }
  } else if (alarm.name === 'bridge-keepalive' && port) {
    if (pingOutstanding > 1) {
      console.warn('[bridge] keepalive: no pong from native host - dropping zombie pipe');
      try { port.disconnect(); } catch (e) { /* ignore */ }
      onPortDisconnect();
      return;
    }
    pingOutstanding++;
    try { port.postMessage({ type: 'ping_from_extension' }); } catch (e) { onPortDisconnect(); }
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensurePort();
  // Re-arm interception if the user left it on when the browser last quit.
  if (globalThis.reapplyInterceptProxy) globalThis.reapplyInterceptProxy();
});
chrome.runtime.onInstalled.addListener(() => ensurePort());

// ---- Inbound tool events: download state used by chrome_handle_download ----
globalThis.bridge = {
  get connected() { return connected; },
  get serverRunning() { return serverRunning; },
  get mcpPort() { return mcpPort; },
  get hostName() { return HOST_NAME; },
};

diag('sw-boot', { version: chrome.runtime.getManifest().version });
updateStatus();
ensurePort();
