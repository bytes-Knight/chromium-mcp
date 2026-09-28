// popup/popup.js — popup UI logic: status display, connect/disconnect, endpoint
// copy, intercepting-proxy toggle, and an explicit extension reload.
//
// IPC contract (message types the service worker understands) is unchanged:
//   bridge-status | bridge-ensure | bridge-connect | bridge-disconnect
//   bridge-next-port | bridge-set-label | bridge-proxy
'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function setPill(id, state, text) {
  const el = $(id);
  el.className = 'pill ' + state;
  el.textContent = text;
}

function log(msg, level) {
  const div = document.createElement('div');
  div.className = 'entry' + (level ? ' ' + level : '');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toLocaleTimeString([], { hour12: false });
  div.appendChild(t);
  div.appendChild(document.createTextNode(msg));
  logEl.appendChild(div);
  while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- stale-code detection ---------------------------------------------------
// A running MV3 service worker keeps executing the code it was STARTED with, so
// edits to lib/ tools/ background.js stay invisible until it restarts — the
// classic "I changed the code and nothing happened". The loaded manifest version
// and the manifest ON DISK diverge exactly when the folder changed underneath a
// live worker, so that comparison is a reliable "you need to reload" signal.
async function checkStale(loadedVersion) {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const disk = await res.json();
    if (disk.version && loadedVersion && disk.version !== loadedVersion) {
      $('reload-ext').classList.add('stale');
      $('foot-note').textContent = `code on disk is v${disk.version}, worker is v${loadedVersion} — reload`;
      return true;
    }
    $('reload-ext').classList.remove('stale');
    return false;
  } catch (e) {
    return false;
  }
}

// ---- status -----------------------------------------------------------------
async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: 'bridge-status' }).catch(() => null);
  const status = resp || {};

  const connected = !!status.connected;
  const running = !!status.serverRunning;
  // Name the wire we are actually on: 'manual host' means bridge-host.exe (the
  // browser is out of the spawn path), 'connected' means browser-spawned native
  // messaging. Same endpoint and same tools either way.
  const wire = status.transport === 'manual' ? 'manual host' : (status.transport === 'native' ? 'connected' : 'offline');
  setPill('pill-native', connected ? 'ok' : 'bad', connected ? wire : 'offline');
  setPill('pill-server', running ? 'ok' : (connected ? 'busy' : 'bad'),
          running ? 'running' : (connected ? 'starting' : 'stopped'));
  $('dot-bridge').className = 'dot ' + (running ? 'ok' : (connected ? 'busy' : 'bad'));

  if (status.mcpPort) {
    $('port').value = status.mcpPort;
    $('endpoint').textContent = `http://127.0.0.1:${status.mcpPort}/mcp`;
  }
  if (status.hostName) $('ext-id').textContent = `host: ${status.hostName}`;

  if (status.instanceId) {
    $('inst-id').textContent = status.instanceId;
    $('inst-id').title = `instanceId: ${status.instanceId}`;
  }
  if (status.browser) {
    const b = status.browser;
    $('inst-browser').textContent = [b.name, b.version, b.platform].filter(Boolean).join(' · ');
    $('inst-browser-short').textContent = [b.name, b.version].filter(Boolean).join(' ');
  }
  if (status.label) $('label').value = status.label;

  // Never hide the failure: the exact native-messaging error is the only thing
  // that explains "offline", so put it on screen (and on the version footer).
  const foot = $('foot-note');
  if (status.hostError) {
    foot.textContent = status.hostError;
    foot.title = status.hostError;
  } else if (connected && status.transport === 'manual') {
    foot.textContent = 'via ' + (status.manualHostUrl || 'manual host');
    foot.title = 'bridge-host.exe is hosting the MCP server; the browser does not spawn anything';
  } else if (!connected && status.failedConnectAttempts) {
    foot.textContent = `${status.failedConnectAttempts} failed connect attempt(s) on port ${status.mcpPort} — next failure moves the port`;
  }

  const loaded = chrome.runtime.getManifest().version;
  $('ver').textContent = loaded;
  await checkStale(loaded);
  return status;
}

// ---- instance label ---------------------------------------------------------
$('label-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'bridge-set-label', label: $('label').value }).catch(() => null);
  log(`instance label set to "${$('label').value}"`);
});

$('label').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('label-btn').click();
});

// ---- port / connect ---------------------------------------------------------
$('newport-btn').addEventListener('click', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'bridge-next-port' }).catch(() => null);
  if (resp) log(`moved to port ${resp.mcpPort} — reconnect in progress`);
  else log('could not move port (background unreachable)', 'err');
  refresh();
});

$('connect-btn').addEventListener('click', async () => {
  const port = parseInt($('port').value, 10) || 12306;
  const resp = await chrome.runtime.sendMessage({ type: 'bridge-connect', port }).catch(() => null);
  if (resp) log(`connect → ${resp.connected ? 'up' : 'down'} server=${resp.serverRunning ? 'running' : 'waiting'}`);
  else log('connect failed: host not reachable (is mcp-chrome-bridge installed?)', 'err');
  refresh();
});

$('disconnect-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'bridge-disconnect' }).catch(() => null);
  log('disconnected');
  refresh();
});

$('copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('endpoint').textContent);
    $('copy-btn').textContent = 'copied';
    setTimeout(() => { $('copy-btn').textContent = 'copy'; }, 1200);
  } catch (e) {
    log('copy failed', 'err');
  }
});

$('clear-log').addEventListener('click', () => { logEl.innerHTML = ''; });

// ---- extension reload -------------------------------------------------------
// One click that re-reads every file from disk (service worker included), so
// source edits take effect without a trip to chrome://extensions.
$('reload-ext').addEventListener('click', () => {
  try {
    log('reloading extension — the worker will restart with fresh code');
    chrome.runtime.reload();
  } catch (e) {
    log('reload failed: ' + e.message, 'err');
  }
});

// ---- intercepting proxy -----------------------------------------------------
const proxyToggle = $('proxy-toggle');
const proxyUrlEl = $('proxy-url');
const proxyHint = $('proxy-hint');
const DEFAULT_PROXY = { host: '127.0.0.1', port: 9999 };

function splitHostPort(v) {
  const s = String(v || '').trim().replace(/^[a-z]+:\/\//i, '');
  const i = s.lastIndexOf(':');
  if (i === -1) return { host: s || DEFAULT_PROXY.host, port: DEFAULT_PROXY.port };
  return {
    host: s.slice(0, i) || DEFAULT_PROXY.host,
    port: parseInt(s.slice(i + 1), 10) || DEFAULT_PROXY.port,
  };
}

async function sendProxy(action, extra) {
  const ep = splitHostPort(proxyUrlEl.value);
  const args = Object.assign({ action: action, host: ep.host, port: ep.port }, extra || {});
  return chrome.runtime.sendMessage({ type: 'bridge-proxy', args: args }).catch(() => null);
}

function applyProxyState(d) {
  if (!d) { setPill('pill-proxy', 'bad', 'n/a'); return; }
  proxyToggle.checked = !!d.enabled;
  if (d.enabled) setPill('pill-proxy', 'ok', 'on');
  else if (d.reachable === false) setPill('pill-proxy', 'bad', 'off');
  else setPill('pill-proxy', 'busy', 'off');
  if (d.host && d.port) proxyUrlEl.value = `${d.host}:${d.port}`;
  if (d.warning) proxyHint.textContent = d.warning;
  else if (d.message) proxyHint.textContent = d.message;
}

async function refreshProxy() {
  const r = await sendProxy('status');
  applyProxyState(r && r.data);
}

proxyToggle.addEventListener('change', async () => {
  const wantOn = proxyToggle.checked;
  proxyToggle.disabled = true;
  const r = await sendProxy(wantOn ? 'on' : 'off');
  proxyToggle.disabled = false;
  const d = (r && r.data) || {};
  applyProxyState(d);
  if (r && r.isError) log('interception: ' + (d.raw || d.message || 'failed'), 'err');
  else if (d.enabled) log(`interception ON → ${d.host}:${d.port}${d.reachable === false ? ' (port not answering!)' : ''}`, 'ok');
  else if (wantOn) log(d.warning || 'interception could not be enabled', 'err');
  else log('interception off');
});

proxyUrlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') proxyToggle.checked ? proxyToggle.dispatchEvent(new Event('change')) : refreshProxy();
});

proxyUrlEl.addEventListener('change', () => refreshProxy());

// ---- boot -------------------------------------------------------------------
refresh().then(async (s) => {
  if (s && s.connected) return;
  // Auto-connect on popup open: no manual Connect click required. bridge-ensure
  // is idempotent and never overwrites a saved port.
  const r = await chrome.runtime.sendMessage({ type: 'bridge-ensure' }).catch(() => null);
  await refresh();
  if (r && r.connected) log('auto-connected to native host', 'ok');
  else if (s && s.hostError) log('native host unavailable: ' + s.hostError, 'err');
  else log('click Connect to start the MCP server');
  // Surface the persisted trail (survives service-worker restarts).
  try {
    const d = await chrome.runtime.sendMessage({ type: 'bridge-diag' });
    if (d && d.entries && d.entries.length) {
      for (const e of d.entries.slice(-6)) {
        log(`[${e.t.slice(11, 19)}] ${e.event}${e.error ? ' — ' + e.error : ''}${e.message ? ' — ' + e.message : ''}`, e.event.includes('fail') || e.event.includes('error') || e.event === 'pipe-closed' ? 'err' : '');
      }
    } else {
      log('no diagnostics recorded yet', 'err');
    }
  } catch (e) { log('could not read diagnostics: ' + e.message, 'err'); }
}).catch(() => log('popup could not reach the background worker', 'err'));

refreshProxy().catch(() => {});
