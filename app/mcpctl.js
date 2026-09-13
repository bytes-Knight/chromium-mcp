#!/usr/bin/env node
// mcpctl.js — standalone CLI for the Chrome MCP bridge (127.0.0.1:12306).
// Zero dependencies (node built-ins only) so it compiles cleanly to a single
// .exe via Node SEA. Drop-in superset of the legacy scripts/mcp.js.
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const readline = require('readline');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 12306;
const FUSE_OK = 'Already connected'; // substring matched on stale-session errors
const EXT_ID = 'agfodficabgggjoapjaphagdcpnoeggc'; // extension ID derived from manifest.json "key"
// Multi-browser: each browser loading the extension owns one MCP port, spread
// deterministically over this range (see lib/instance.js PORT_BASE/PORT_SPAN).
// The scan range is a superset so a manual/popup port override is still found.
const PORT_RANGE = '12306-12340';
const PORT_RANGE_MAX = 12340;
// Identity cache: the host serves a singleton MCP session, so an instance whose
// session is held by another client cannot be queried for its name. Every
// successful read is mirrored here by port so `browsers` can still label a busy
// instance and `--browser` keeps resolving while an IDE/mcpctl is mid-command.
const INSTANCE_CACHE = path.join(os.tmpdir(), 'mcpctl-instances.json');

let rpcCounter = 0;
let cfg = {
  host: DEFAULT_HOST, port: DEFAULT_PORT, json: false, tab: null,
  browser: null,              // --browser <selector> -> resolved to a port
  range: null,                // --range N-M -> port range scanned by discovery
  timeout: 60000,             // per-RPC budget (nav/eval on slow pages); override with --timeout
  lockTimeout: 60000,         // how long to wait for another mcpctl to release the bridge lock
};

let lockHeld = false;

// `port` is optional and defaults to the configured port. It exists so port
// scans can probe many ports IN PARALLEL without racing on global cfg state.
const mcpUrl = (port) => `http://${cfg.host}:${port || cfg.port}/mcp`;

// ---------------------------------------------------------------- transport ---
function parseResponse(text) {
  let parsed = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      const s = line.slice(6).trim();
      if (!s) continue;
      try { parsed = JSON.parse(s); } catch (e) { /* skip */ }
    }
  }
  if (!parsed) { try { parsed = JSON.parse(text); } catch (e) { parsed = null; } }
  return parsed;
}

async function mcpRpc(method, params, sessionId, timeoutMs, port) {
  rpcCounter++;
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcCounter, method, params });
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || cfg.timeout);
  const url = mcpUrl(port);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
  } catch (e) {
    throw new Error(`bridge unreachable at ${url} (${e.message}). Start Chrome with the extension connected, or run "mcpctl restart".`);
  } finally {
    clearTimeout(timer);
  }
  const sid = res.headers.get('mcp-session-id');
  const text = await res.text();
  return { status: res.status, sessionId: sid, parsed: parseResponse(text), raw: text };
}

async function initSession(port, timeoutMs = 15000) {
  const init = await mcpRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcpctl', version: '3.0.0' },
  }, null, timeoutMs, port);
  if (init.status !== 200 || !init.sessionId) {
    const p = init.parsed;
    const msg = (p && (p.message || (p.error && p.error.message))) || `HTTP ${init.status}${init.raw ? ': ' + init.raw.slice(0, 200) : ''}`;
    throw new Error(String(msg));
  }
  await mcpRpc('notifications/initialized', {}, init.sessionId, undefined, port).catch(() => {});
  return init.sessionId;
}

async function closeSession(sessionId, port) {
  try { await fetch(mcpUrl(port), { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } }); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------- instance cache ---
function readInstanceCache() {
  try { return JSON.parse(fs.readFileSync(INSTANCE_CACHE, 'utf8')) || {}; } catch (e) { return {}; }
}
function cacheInstance(port, info) {
  if (!info || !port) return;
  try {
    const cache = readInstanceCache();
    cache[String(port)] = {
      instanceId: info.instanceId || null,
      label: info.label || '',
      browser: info.browser || null,
      extensionId: info.extensionId || null,
      mcpPort: info.mcpPort || port,
      endpoint: info.endpoint || `http://${cfg.host}:${port}/mcp`,
      lastSeen: Date.now(),
    };
    fs.writeFileSync(INSTANCE_CACHE, JSON.stringify(cache, null, 1));
  } catch (e) { /* cache is best-effort */ }
}
function cachedInstance(port) {
  const c = readInstanceCache()[String(port)];
  return c && c.instanceId ? c : null;
}

// ------------------------------------------------------------ host recovery ---
function portOpen(port, host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const sock = net.connect({ port, host });
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(check, 200);
      });
    };
    check();
  });
}

function hostPid() {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(':' + cfg.port) && /LISTENING/i.test(line)) {
        const m = line.trim().split(/\s+/);
        return m[m.length - 1];
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function restartHost() {
  const pid = hostPid();
  if (!pid) return false; // nothing was listening -> nothing to restart, no respawn coming
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /PID ${pid}`, { windowsHide: true });
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
  } catch (e) { /* already dead */ }
  // Wait for the port to actually close.
  await waitPortClosed(cfg.host, cfg.port, 15000);
  // The host only respawns when the extension reconnects over native messaging.
  // Don't burn up to 45s waiting when no browser with the extension is running.
  if (!(chromeRunning() || processRunning('brave.exe') || processRunning('msedge.exe'))) return false;
  // Wait for a host whose session probe actually succeeds (host + extension),
  // bailing early on 'busy' (rogue singleton) and skipping pure port-open states.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (!(await portOpen(cfg.port, cfg.host, 400))) { await sleep(500); continue; }
    const probe = await probeSession(3000);
    if (probe.state === 'ok') { await sleep(800); return true; }
    if (probe.state === 'busy') return false;
    await sleep(1000);
  }
  return false;
}

async function waitPortClosed(host, port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await portOpen(port, host, 400))) return true;
    await sleep(400);
  }
  return !(await portOpen(port, host, 400));
}

async function waitPortOpen(host, port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port, host, 400)) return true;
    await sleep(400);
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------- error taxonomy ---
class BridgeError extends Error {
  constructor(message, exitCode = 3) { super(message); this.exitCode = exitCode; }
  static from(e) {
    if (e instanceof BridgeError) return e;
    return new BridgeError(String((e && e.message) || e), (e && e.exitCode) || 1);
  }
}
class LockBusyError extends BridgeError {
  constructor(message) { super(message, 4); }
}

// ------------------------------------------------------- lock (serialize) ---
// The bridge hosts a SINGLE MCP session, so concurrent mcpctl invocations
// collide and force host restarts. A cross-process lockfile serializes them.
function lockFilePath() { return path.join(os.tmpdir(), `mcpctl-${cfg.port}.lock`); }
function pidAlive(pid) {
  if (!pid || !/^\d+$/.test(String(pid))) return false;
  try { process.kill(parseInt(pid, 10), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function acquireLock(timeoutMs) {
  const lp = lockFilePath();
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      lockHeld = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = true;
      try {
        const pid = parseInt(fs.readFileSync(lp, 'utf8'), 10);
        stale = !pidAlive(pid);
      } catch (r) { stale = true; }
      if (stale) { try { fs.unlinkSync(lp); } catch (u) { /* raced */ } continue; }
      if (Date.now() - start >= timeoutMs) {
        throw new LockBusyError(
          `another mcpctl instance is busy (lock: ${lp}). Wait for it to finish, or delete the lock file if it is stale.`);
      }
      await sleep(150);
    }
  }
}
function releaseLock() {
  try {
    if (String(process.pid) === fs.readFileSync(lockFilePath(), 'utf8').trim()) fs.unlinkSync(lockFilePath());
  } catch (e) { /* not ours / absent */ }
}

// ------------------------------------------------------------ environment ---
function chromeRunning() { return processRunning('chrome.exe'); }
function processRunning(image) {
  try {
    const out = execSync(`tasklist /NH /FI "IMAGENAME eq ${image}"`, { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(image.replace('.', '\.'), 'i').test(out) && !/INFO: No tasks/i.test(out);
  } catch (e) { return false; } // exit code 1 == "no tasks"
}
function regDefaultPath(key) {
  try {
    const out = execSync(`reg query "${key}" /ve`, { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_SZ\s+(.+)/);
    if (m) return m[1].trim();
  } catch (e) { /* key missing */ }
  return null;
}
function chromePath() {
  const c = process.env.CHROME_PATH;
  if (c && fs.existsSync(c)) return c;
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const cands = bases.map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push(regDefaultPath('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'));
  cands.push(regDefaultPath('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'));
  return cands.find((p) => p && fs.existsSync(p)) || null;
}
function browserPath() {
  if (chromePath()) return chromePath();
  const cands = [
    path.join(process.env.PROGRAMFILES || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ];
  return cands.find((p) => p && fs.existsSync(p)) || null;
}
function hostCmdline(pid) {
  if (!pid) return null;
  try {
    return execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
      { encoding: 'utf8', windowsHide: true, timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return null; }
}
function extIdFromKey(keyB64) {
  try {
    const der = Buffer.from(keyB64, 'base64');
    const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
    let id = '';
    for (const ch of hex) id += String.fromCharCode(97 + parseInt(ch, 16)); // 0-f -> a-p
    return id;
  } catch (e) { return null; }
}
function nativeHostManifestPath() {
  const la = process.env.LOCALAPPDATA || '';
  const cands = [
    path.join(process.env.APPDATA || '', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.chromemcp.nativehost.json'),
    path.join(la, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts', 'com.chromemcp.nativehost.json'),
    path.join(process.env.ProgramData || '', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.chromemcp.nativehost.json'),
    'C:/Program Files (x86)/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json',
    path.join(la, 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts', 'com.chromemcp.nativehost.json'),
    path.join(la, 'BraveSoftware', 'Brave-Browser', 'User Data', 'NativeMessagingHosts', 'com.chromemcp.nativehost.json'),
  ];
  return cands.find((p) => p && fs.existsSync(p)) || cands[0];
}
function findExtManifest() {
  for (const cand of [
    path.join(__dirname, 'manifest.json'),
    path.join(__dirname, '..', 'manifest.json'),
    path.join(__dirname, '..', '..', 'manifest.json'),
  ]) if (fs.existsSync(cand)) return cand;
  return null;
}

// --------------------------------------------------------------- health ---
// state 'ok' requires a REAL extension roundtrip. A standalone/orphan host
// (node mcp-chrome-bridge run directly) answers initialize fine but cannot
// dispatch tools, so port-open alone must never be called "healthy".
async function probeSession(timeoutMs = 4000) {
  const start = Date.now();
  if (!(await portOpen(cfg.port, cfg.host, 600))) return { state: 'down', ms: Date.now() - start };
  let sid = null;
  try {
    const init = await mcpRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcpctl', version: '3.0.0' },
    }, null, timeoutMs);
    const msg = (init.parsed && (init.parsed.message || (init.parsed.error && init.parsed.error.message))) || '';
    if (init.status !== 200 || !init.sessionId) {
      if (/already connected/i.test(msg)) return { state: 'busy', ms: Date.now() - start, note: msg };
      return { state: 'broken', ms: Date.now() - start, http: init.status, note: msg || (init.raw || '').slice(0, 160) };
    }
    sid = init.sessionId;
    await mcpRpc('notifications/initialized', {}, sid, timeoutMs).catch(() => {});
    const ping = await mcpRpc('tools/call', { name: 'get_windows_and_tabs', arguments: {} }, sid, timeoutMs);
    if (!ping.parsed || ping.parsed.error) {
      return { state: 'broken', ms: Date.now() - start, note: 'host answers HTTP but tool dispatch failed' };
    }
    // Same session, same roundtrip: learn WHICH browser this port belongs to.
    // Doing it here (rather than in a second session afterwards) avoids racing
    // the host's singleton session - which is why `status` never showed the
    // instance before.
    const info = await fetchInstanceInfo(sid);
    if (info) cacheInstance(cfg.port, info);
    return { state: 'ok', ms: Date.now() - start, sessionId: sid, info, note: 'roundtrip ok' };
  } catch (e) {
    return { state: 'broken', ms: Date.now() - start, note: String((e && e.message) || e).slice(0, 160) };
  } finally {
    if (sid) closeSession(sid).catch(() => {});
  }
}
function stateNote(state, extra) {
  switch (state) {
    case 'ok': return 'bridge healthy - host + extension roundtrip ok';
    case 'down': return `bridge DOWN - nothing listening on ${mcpUrl()}`;
    case 'busy': return 'bridge busy - another MCP client holds the singleton session (run "mcpctl restart" to reclaim it)';
    case 'broken': return `bridge host UP but extension unreachable (${extra || 'session probe failed'})`;
    default: return String(state);
  }
}

// ----------------------------------------------------------------- instance ---
// Multi-browser support: every browser running the extension owns its own MCP
// port. These helpers discover live instances and resolve --browser targets.
async function fetchInstanceInfo(sessionId, port) {
  try {
    const r = await callTool(sessionId, 'bridge_get_instance_info', {}, undefined, port);
    return r.parsed || null;
  } catch (e) {
    return null;
  }
}

// Identity-less description of an instance: window/tab counts + the active tab.
// Used only when the identity tool is unavailable (extension older than this CLI).
async function fetchInstanceFallback(sessionId, port) {
  try {
    const r = await callTool(sessionId, 'get_windows_and_tabs', {}, undefined, port);
    const wins = r.parsed;
    if (!Array.isArray(wins)) return null;
    const tabs = wins.flatMap((w) => w.tabs || []);
    const active = tabs.find((t) => t.active) || null;
    return {
      windowCount: wins.length,
      tabCount: tabs.length,
      activeTab: active ? { title: active.title || null, url: active.url || null } : null,
    };
  } catch (e) {
    return null;
  }
}

// Probe ONE port for a live bridge instance. Read-only: never takes the lock
// (probing must not collide with itself) and fails fast on busy sessions.
async function probeInstanceOn(port, timeoutMs = 3000) {
  const start = Date.now();
  // NOTE: no `cfg.port` mutation anywhere in here. Scans run in parallel, so
  // every RPC must carry its own port explicitly or the probes race each other
  // and report the wrong endpoint.
  if (!(await portOpen(port, cfg.host, 400))) return { port, state: 'down', ms: Date.now() - start };
  let sid = null;
  try {
    const init = await mcpRpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcpctl', version: '3.0.0' },
    }, null, timeoutMs, port);
    const msg = (init.parsed && (init.parsed.message || (init.parsed.error && init.parsed.error.message))) || '';
    if (init.status !== 200 || !init.sessionId) {
      if (/already connected/i.test(msg)) {
        // Another client holds the singleton session. Fall back to the cache so
        // a busy instance is still nameable and targetable.
        const cached = cachedInstance(port);
        return { port, state: 'busy', ms: Date.now() - start, info: cached, cached: !!cached, note: msg };
      }
      return { port, state: 'broken', ms: Date.now() - start, http: init.status, note: msg || (init.raw || '').slice(0, 140) };
    }
    sid = init.sessionId;
    await mcpRpc('notifications/initialized', {}, sid, timeoutMs, port).catch(() => {});
    const info = await fetchInstanceInfo(sid, port);
    if (info) cacheInstance(port, info);
    // Older extension builds have no identity tool. Rather than report a live
    // browser as a blank row, fall back to its tabs so a human can still tell
    // the instances apart ("that's the one with the Jira tab").
    const unidentified = info ? null : await fetchInstanceFallback(sid, port);
    return { port, state: 'ok', ms: Date.now() - start, info, unidentified };
  } catch (e) {
    return { port, state: 'broken', ms: Date.now() - start, note: String((e && e.message) || e).slice(0, 140) };
  } finally {
    if (sid) closeSession(sid, port).catch(() => {});
  }
}

// Scan the port range in PARALLEL. A sequential 30-port sweep with 3s timeouts
// made `browsers` take up to a minute on a machine with a single bridge.
const SCAN_CONCURRENCY = 10;
function parseRange(range) {
  const m = String(range || PORT_RANGE).match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return [DEFAULT_PORT, DEFAULT_PORT];
  const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
  return lo <= hi ? [lo, hi] : [hi, lo];
}
async function scanInstances(range, timeoutMs = 3000) {
  const [lo, hi] = parseRange(range);
  const out = [];
  for (let start = lo; start <= hi; start += SCAN_CONCURRENCY) {
    const batch = [];
    for (let p = start; p <= Math.min(hi, start + SCAN_CONCURRENCY - 1); p++) batch.push(probeInstanceOn(p, timeoutMs));
    out.push(...(await Promise.all(batch)));
  }
  return out.filter((r) => r.state !== 'down');
}

// Selectors a user can hand back to --browser. Prefer a stable, human-meaningful
// handle: an explicit label, else browser:port (always unique), else an id prefix.
function instanceSelectors(port, info) {
  const browser = (info && info.browser && info.browser.name) || null;
  const id = (info && info.instanceId) || null;
  const label = (info && info.label) || null;
  const sels = [];
  if (label) sels.push(label);
  if (browser) sels.push(`${browser}:${port}`);
  if (id) sels.push(`id:${id.slice(0, 8)}`);
  if (browser) sels.push(browser);
  return sels;
}

function describeInstance(inst) {
  const info = (inst && inst.info) || {};
  const b = info.browser || {};
  const who = `${b.name || 'unknown'}${b.version ? ' ' + b.version : ''}${b.platform ? ' (' + b.platform + ')' : ''}`;
  const label = info.label ? `label="${info.label}"` : 'unlabeled';
  const id = info.instanceId ? `id=${info.instanceId.slice(0, 8)}` : 'identity unknown';
  return `${who}  ${label}  ${id}`;
}

// Resolve --browser <selector> to a live port. Accepted selectors:
//   <label>            a popup/CLI-set instance label
//   <name>:<port>      browser pinned to a port (always unique)
//   port:<n>           the port itself
//   id:<prefix>        instanceId prefix (>= 6 chars)
//   <name>             browser name (may match several -> ambiguity reported)
// Busy instances resolve through the identity cache when it has them.
async function resolveBrowser(target, range) {
  const raw = String(target || '').trim();
  if (!raw) return { error: 'empty --browser selector' };
  const t = raw.toLowerCase();

  if (/^port:/.test(t)) {
    const p = parseInt(t.slice(5), 10);
    if (!Number.isInteger(p)) return { error: `bad --browser selector: ${raw}` };
    const probe = await probeInstanceOn(p);
    if (probe.state === 'ok' || probe.state === 'busy') {
      if (probe.info) cacheInstance(p, probe.info);
      return { port: p, probe };
    }
    return { error: `nothing live on port ${p}` };
  }

  const instances = await scanInstances(range);
  const wantsId = t.startsWith('id:') ? t.slice(3) : null;
  const wantsNamePort = t.match(/^([a-z][a-z0-9-]*):(\d+)$/);
  const matches = [];

  for (const inst of instances) {
    const info = inst.info || null;
    const browser = String((info && info.browser && info.browser.name) || '').toLowerCase();
    const label = String((info && info.label) || '').toLowerCase();
    const id = String((info && info.instanceId) || '').toLowerCase();
    let hit = false;
    if (wantsId != null) hit = wantsId.length >= 6 && id.startsWith(wantsId);
    else if (wantsNamePort) hit = browser === wantsNamePort[1] && inst.port === parseInt(wantsNamePort[2], 10);
    else hit = label === t || browser === t || (id.length >= 6 && id.startsWith(t));
    if (hit) matches.push(inst);
  }

  if (matches.length === 0) return { error: `no bridge instance matches --browser "${raw}"`, instances };
  if (matches.length === 1) return { port: matches[0].port, probe: matches[0] };

  // Ambiguity: an exact label beats a browser-name match, and a fully
  // identified instance beats a cached one - so `--browser chrome` still works
  // when exactly one Chrome is live.
  const exactLabel = matches.filter((i) => String((i.info && i.info.label) || '').toLowerCase() === t);
  if (exactLabel.length === 1) return { port: exactLabel[0].port, probe: exactLabel[0] };
  const identified = matches.filter((i) => i.info);
  if (identified.length === 1) return { port: identified[0].port, probe: identified[0] };
  return { error: `--browser "${raw}" is ambiguous (${matches.length} instances match)`, ambiguous: matches };
}

function fmtInstances(list, target) {
  if (!Array.isArray(list)) return pretty(list);
  if (list.length === 0) return '(no live bridge instances found)\n' + remediation();
  const lines = [];
  let usable = 0;
  let unidentified = 0;
  for (const inst of list) {
    const mark = inst.port === target ? '*' : ' ';
    const sel = inst.info ? (instanceSelectors(inst.port, inst.info)[0] || `port:${inst.port}`) : null;
    if (inst.state === 'ok' && inst.info) {
      usable++;
      lines.push(`${mark} :${inst.port}  ${describeInstance(inst)}  ${inst.info.endpoint || ''}`);
      lines.push(`       use:  mcpctl --browser ${sel} <command>   (or --port ${inst.port})`);
    } else if (inst.state === 'busy' && inst.info) {
      usable++;
      lines.push(`${mark} :${inst.port}  ${describeInstance(inst)}  [session busy - identity from cache]`);
      lines.push(`       use:  mcpctl --browser ${sel} <command>   (or --port ${inst.port})`);
    } else if (inst.state === 'ok' && inst.unidentified) {
      // Live browser, but this build can't name it - describe it by its tabs.
      usable++;
      unidentified++;
      const u = inst.unidentified;
      const hint = u.activeTab ? `${u.activeTab.title || '(no title)'}  ${u.activeTab.url || ''}`.trim() : 'no active tab';
      lines.push(`${mark} :${inst.port}  unidentified browser - ${u.windowCount} window(s), ${u.tabCount} tab(s); active: ${hint}`);
      lines.push(`       use:  mcpctl --port ${inst.port} <command>   (reload the extension to enable labels/--browser)`);
    } else if (inst.state === 'ok') {
      usable++;
      unidentified++;
      lines.push(`${mark} :${inst.port}  live bridge, identity unavailable (channel busy or tool error)`);
      lines.push(`       use:  mcpctl --port ${inst.port} <command>`);
    } else if (inst.state === 'busy') {
      lines.push(`${mark} :${inst.port}  live but session busy - another MCP client holds it (identity unknown; re-run when idle)`);
    } else {
      lines.push(`${mark} :${inst.port}  ${inst.state}${inst.note ? ' - ' + inst.note : ''}`);
    }
  }
  lines.push('');
  lines.push(`(${usable} usable instance${usable === 1 ? '' : 's'}; * = the port this mcpctl targets by default)`);
  if (unidentified > 0) {
    lines.push('Note: an instance that cannot be named means the loaded extension is older than this CLI.');
    lines.push('      Reload it once (chrome://extensions -> Reload) to expose browser name, label and --browser targeting.');
  }
  return lines.join('\n');
}

function remediation() {
  return 'Fix: open the browser with the bridge extension loaded (chrome-mcp-extension/) so it auto-starts the host; run "mcpctl doctor" for a full environment report; or run "mcpctl ensure --wait 90" to wait for / launch the bridge.';
}
function statusObject(probe) {
  return {
    ok: probe.state === 'ok',
    state: probe.state,
    host: cfg.host, port: cfg.port,
    hostPid: hostPid(),
    mcpUrl: mcpUrl(),
    note: stateNote(probe.state, probe.note),
  };
}

// Set by runCommand before it reformats the result, so `main` can turn a
// reported failure ({ ok: false }) into a non-zero exit code. The formatted
// value may be a plain string, so the flag cannot be read off the return value.
let lastCommandOk = true;

let activeSession = null;
process.on('SIGINT', () => {
  const done = () => { process.exitCode = 130; };
  if (activeSession) closeSession(activeSession).then(done, done);
  else done();
});
process.on('SIGTERM', () => {
  const done = () => { process.exitCode = 143; };
  if (activeSession) closeSession(activeSession).then(done, done);
  else done();
});
process.on('exit', () => { if (lockHeld) releaseLock(); });

// The bridge's McpServer is a singleton — a stale session makes every new
// initialize fail with "Already connected to a transport". Recover by killing
// the host (the extension respawns it fresh) and retrying. The same recovery
// applies when the host dies mid-call (transport errors like "terminated" —
// the service worker can be idle-killed by the browser, dropping the native
// port and taking the in-flight HTTP stream down with it).
const TRANSPORT_ERROR_RE = /terminated|fetch failed|ECONNRESET|socket hang up|UND_ERR|other side closed/i;
async function withSession(fn) {
  // Serialize invocations (single-session bridge) before probing.
  await acquireLock(cfg.lockTimeout);
  let sessionId = null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const probe = await probeSession(4000);
      if (probe.state === 'ok') {
        try {
          sessionId = await initSession();
          activeSession = sessionId;
          return await fn(sessionId);
        } catch (e) {
          const m = String((e && e.message) || e);
          if (!(m.includes(FUSE_OK) || TRANSPORT_ERROR_RE.test(m))) throw BridgeError.from(e);
          // else: stale singleton or mid-call transport death -> restart below
        }
      } else if (probe.state === 'down') {
        // Definitive: nothing is listening. Fail fast instead of retrying.
        throw new BridgeError(`bridge DOWN at ${mcpUrl()}. ${remediation()}`);
      }
      const state = probe.state === 'ok' ? 'session error' : probe.state;
      if (attempt >= 2) throw new BridgeError(`bridge ${state} persists after retries. ${remediation()}`);
      process.stderr.write(`[mcpctl] bridge ${state} (${String(probe.note || '').slice(0, 80)}) - restarting host...\n`);
      const ok = await restartHost();
      if (!ok) throw new BridgeError(`host did not respawn with a working extension. ${remediation()}`);
    }
  } finally {
    lockHeld = false;
    releaseLock();
    if (sessionId) await closeSession(sessionId).catch(() => {});
    activeSession = null;
  }
}

// ---------------------------------------------------------------- tool call ---
function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function callTool(sessionId, tool, args, timeoutMs, port) {
  const call = await mcpRpc('tools/call', { name: tool, arguments: args || {} }, sessionId, timeoutMs, port);
  if (call.parsed && call.parsed.error) throw new Error(JSON.stringify(call.parsed.error).slice(0, 400));
  const result = call.parsed && call.parsed.result;
  const text = result && result.content ? result.content.map((c) => c.text || '').join('\n') : '';
  return { ok: !(result && result.isError), text, parsed: tryParseJson(text) };
}

function tabArg() { return cfg.tab ? { tabId: cfg.tab } : {}; }

// --------------------------------------------------------------- output fmt ---
function pretty(v) {
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

function out(o) {
  if (cfg.json) { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); return; }
  if (typeof o === 'string') { process.stdout.write(o + '\n'); return; }
  if (o && typeof o === 'object' && 'text' in o && !('parsed' in o)) {
    const p = tryParseJson(o.text);
    process.stdout.write((p ? JSON.stringify(p, null, 2) : o.text) + '\n');
    return;
  }
  process.stdout.write(pretty(o) + '\n');
}

function instLabel(inst) {
  if (inst && inst.info) {
    const b = inst.info.browser || {};
    return `${b.name || '?'}${b.version ? ' ' + b.version : ''}${inst.info.label ? ' [' + inst.info.label + ']' : ''}`;
  }
  return null;
}

function fmtTabs(parsed) {
  if (!Array.isArray(parsed)) return pretty(parsed);
  const lines = [];
  for (const w of parsed) {
    lines.push(`Window ${w.id} [${w.state || 'normal'}${w.type ? ' ' + w.type : ''}]${w.focused ? ' focused' : ''}${w.incognito ? ' incognito' : ''} - ${(w.tabs || []).length} tabs`);
    for (const t of w.tabs || []) {
      lines.push(`  #${t.id}${t.active ? ' [ACTIVE]' : ''}${t.pinned ? ' [PINNED]' : ''} ${t.url || ''}  ${t.title || ''}`);
    }
  }
  return lines.join('\n');
}

function fmtRead(parsed) {
  if (!parsed || !Array.isArray(parsed.refs)) return pretty(parsed);
  const lines = [];
  for (const r of parsed.refs) {
    const label = r.text || r.ariaLabel || r.href || '';
    lines.push(`${r.ref}  <${r.tag}${r.role ? ' role=' + r.role : ''}>  ${label.slice(0, 120)}  [${r.bounds.x},${r.bounds.y}]`);
  }
  return lines.join('\n');
}

function fmtConsole(parsed) {
  if (!parsed || !Array.isArray(parsed.messages)) return pretty(parsed);
  return parsed.messages.map((m) => `${m.level.toUpperCase().padEnd(5)} ${m.text}`).join('\n') || '(no messages)';
}

function fmtBookmarks(parsed) {
  if (!parsed || !Array.isArray(parsed.items)) return pretty(parsed);
  return parsed.items.map((b) => `${b.id}  ${b.title || ''}  ${b.url || ''}  [${b.path || ''}]`).join('\n') || '(none)';
}

function fmtHistory(parsed) {
  if (!parsed || !Array.isArray(parsed.items)) return pretty(parsed);
  return parsed.items.map((h) => `${h.id}  ${h.title || ''}  ${h.url}  (${h.visitCount || 1}x)`).join('\n') || '(none)';
}

// ------------------------------------------------------------------- args ---
function parseFlags(argv, known) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (known.includes(name)) {
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
        else flags[name] = true;
      } else {
        throw new UsageError(`unknown flag --${name}`);
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

const GLOBAL_FLAGS = ['json', 'tab', 'timeout', 'port', 'host', 'lock-timeout', 'browser', 'range'];

// Consume ONLY the leading run of global `--flag value` pairs and hand back the
// rest. parseFlags() over the whole argv cannot be used here: it rejects any
// command-specific flag that appears later (e.g. `--browser edge status
// --range 1-20` died with "unknown command: --browser").
function extractLeadFlags(argv, known) {
  const flags = { _: [] };
  let i = 0;
  while (i < argv.length && argv[i].startsWith('--')) {
    const name = argv[i].slice(2);
    if (!known.includes(name)) break; // belongs to the command, not the prefix
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i += 2; }
    else { flags[name] = true; i += 1; }
  }
  flags._ = argv.slice(i);
  return flags;
}

function applyGlobalFlags(flags) {
  if (flags.json) cfg.json = true;
  if (flags.tab != null) cfg.tab = parseInt(flags.tab, 10);
  if (flags.timeout != null) cfg.timeout = parseInt(flags.timeout, 10) * 1000;
  if (flags.port != null) cfg.port = parseInt(flags.port, 10);
  if (flags.host) cfg.host = flags.host;
  if (flags['lock-timeout'] != null) cfg.lockTimeout = parseInt(flags['lock-timeout'], 10) * 1000;
  if (flags.browser) cfg.browser = String(flags.browser);
  if (flags.range) cfg.range = String(flags.range);
}

class UsageError extends Error { constructor(message) { super(message); this.exitCode = 2; } }

// ------------------------------------------------------------- sub-commands ---
async function cmdStatus(sessionId, flags) {
  // Called from the REPL with a live session -> shallow port check is enough.
  if (sessionId) {
    const open = await portOpen(cfg.port, cfg.host, 800);
    const o = { ok: open, state: open ? 'ok' : 'down', host: cfg.host, port: cfg.port, hostPid: hostPid(), mcpUrl: mcpUrl(), note: open ? 'bridge healthy (in-session)' : 'bridge DOWN' };
    if (open) { const info = await fetchInstanceInfo(sessionId); if (info) o.instance = { instanceId: info.instanceId, label: info.label || null, browser: info.browser || null, mcpPort: info.mcpPort, endpoint: info.endpoint }; }
    return o;
  }
  const probe = await probeSession(4000);
  return enrichInstance(statusObject(probe), probe);
}

async function enrichInstance(o, probe) {
  if (o && probe && probe.state === 'ok') {
    try {
      // Prefer the info captured during the health probe's own session; only
      // open a new one if that read failed. (Opening a second session straight
      // after the first closed is exactly what raced the singleton host.)
      let info = probe.info || null;
      if (!info) {
        const sid = await initSession();
        info = await fetchInstanceInfo(sid);
        await closeSession(sid);
      }
      if (info) {
        cacheInstance(cfg.port, info);
        o.instance = {
          instanceId: info.instanceId,
          label: info.label || null,
          browser: info.browser || null,
          extensionId: info.extensionId,
          mcpPort: info.mcpPort,
          endpoint: info.endpoint,
          connected: info.connected,
          serverRunning: info.serverRunning,
        };
      }
    } catch (e) { /* enrichment is best-effort */ }
  }
  return o;
}

async function statusWithWait(flags) {
  let probe;
  if (flags.wait == null) probe = await probeSession(4000);
  else {
    const deadline = Date.now() + Math.max(1, parseInt(flags.wait, 10)) * 1000;
    probe = await probeSession(3000);
    while (probe.state !== 'ok' && Date.now() < deadline) {
      await sleep(1000);
      probe = await probeSession(3000);
    }
  }
  return enrichInstance(statusObject(probe), probe);
}

async function cmdTabs(sessionId, flags) {
  const r = await callTool(sessionId, 'get_windows_and_tabs', {});
  if (!r.ok) return r;
  return { ok: true, text: r.text, parsed: r.parsed };
}

async function cmdActive(sessionId, flags) {
  const r = await callTool(sessionId, 'get_windows_and_tabs', {});
  if (!r.ok) return r;
  const wins = r.parsed;
  if (Array.isArray(wins)) {
    const tab = wins.flatMap((w) => w.tabs || []).find((t) => t.active);
    return { ok: true, tab: tab || null, windows: wins.length, text: r.text, parsed: r.parsed };
  }
  return r;
}

async function cmdSwitch(sessionId, flags, id) {
  const n = parseInt(id, 10);
  if (isNaN(n)) return { ok: false, text: 'usage: switch <tabId>' };
  return callTool(sessionId, 'chrome_switch_tab', { tabId: n });
}

async function cmdClose(sessionId, flags, target) {
  const args = { tabIds: [] };
  if (/^\d+$/.test(target || '')) args.tabIds = [parseInt(target, 10)];
  else if (target) args.url = target;
  else args.tabIds = [cfg.tab || (await currentTabId(sessionId))];
  return callTool(sessionId, 'chrome_close_tabs', args);
}

async function currentTabId(sessionId) {
  const r = await callTool(sessionId, 'get_windows_and_tabs', {});
  if (r.parsed && Array.isArray(r.parsed)) {
    const t = r.parsed.flatMap((w) => w.tabs || []).find((x) => x.active);
    if (t) return t.id;
  }
  return null;
}

async function cmdRead(sessionId, flags) {
  const args = Object.assign({}, tabArg());
  if (flags.interactive) args.filter = 'interactive';
  if (flags.depth != null) args.depth = parseInt(flags.depth, 10);
  if (flags.ref) args.refId = flags.ref;
  return callTool(sessionId, 'chrome_read_page', args);
}

async function cmdContent(sessionId, flags) {
  const args = Object.assign({}, tabArg());
  if (flags.selector) args.selector = flags.selector;
  if (flags.html) args.htmlContent = true;
  args.textContent = flags.text !== false;
  return callTool(sessionId, 'chrome_get_web_content', args);
}

async function cmdInteractive(sessionId, flags) {
  return callTool(sessionId, 'chrome_get_interactive_elements', Object.assign({}, tabArg()));
}

async function cmdEval(sessionId, flags, code) {
  const args = Object.assign({ code: 'return (' + code + ')' }, tabArg());
  if (flags.timeout != null) args.timeoutMs = parseInt(flags.timeout, 10) * 1000;
  return callTool(sessionId, 'chrome_javascript', args);
}

async function cmdRun(sessionId, flags, code) {
  const args = Object.assign({ code }, tabArg());
  if (flags.timeout != null) args.timeoutMs = parseInt(flags.timeout, 10) * 1000;
  return callTool(sessionId, 'chrome_javascript', args);
}

function targetArgs(flags) {
  const t = flags._[0];
  const args = Object.assign({}, tabArg());
  if (t && /^ref_\d+$/.test(t)) args.ref = t;
  else if (t) args.selector = t;
  return args;
}

async function cmdClick(sessionId, flags) {
  const args = targetArgs(flags);
  if (flags.double) args.double = true;
  if (flags.button) args.button = flags.button;
  return callTool(sessionId, 'chrome_click_element', args);
}

async function cmdHover(sessionId, flags) {
  const args = targetArgs(flags);
  return callTool(sessionId, 'chrome_computer', Object.assign({ action: 'hover' }, args));
}

async function cmdFill(sessionId, flags) {
  const args = targetArgs(flags);
  const value = flags.value != null ? flags.value : (flags._.slice(1).join(' ') || null);
  if (value == null) return { ok: false, text: 'usage: fill <sel|ref> <value>' };
  args.value = value;
  return callTool(sessionId, 'chrome_fill_or_select', args);
}

async function cmdKeys(sessionId, flags) {
  const args = Object.assign({ keys: flags._.join(' ') }, tabArg());
  if (flags.delay != null) args.delay = parseInt(flags.delay, 10);
  if (flags.selector) args.selector = flags.selector;
  return callTool(sessionId, 'chrome_keyboard', args);
}

async function cmdNav(sessionId, flags) {
  const target = flags._[0];
  const args = Object.assign({}, tabArg());
  if (target === 'reload' || !target) { args.refresh = true; args.background = true; }
  else args.url = target;
  return callTool(sessionId, 'chrome_navigate', args);
}

async function cmdShot(sessionId, flags) {
  const args = Object.assign({
    storeBase64: true,
    savePng: false,
    fullPage: !!flags.full,
  }, tabArg());
  if (flags.selector) args.selector = flags.selector;
  const r = await callTool(sessionId, 'chrome_screenshot', args);
  if (flags.out && r.parsed) {
    const b64 = r.parsed.base64 || (r.parsed.data && r.parsed.data.base64);
    if (b64) {
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(flags.out, buf);
      return { ok: true, saved: flags.out, bytes: buf.length, text: `saved ${flags.out} (${buf.length} bytes)` };
    }
  }
  return r;
}

async function cmdHistory(sessionId, flags) {
  const args = {};
  if (flags.query) args.text = flags.query;
  if (flags.max != null) args.maxResults = parseInt(flags.max, 10);
  if (flags.ago) args.startTime = flags.ago;
  if (flags.excludeOpen) args.excludeCurrentTabs = true;
  return callTool(sessionId, 'chrome_history', args);
}

async function cmdBookmarks(sessionId, flags) {
  const sub = flags._[0] || 'search';
  const rest = flags._.slice(1);
  if (sub === 'search') return callTool(sessionId, 'chrome_bookmark_search', { query: flags.query || rest.join(' ') || '' });
  if (sub === 'add') {
    const url = flags.url || rest[0];
    if (!url) return { ok: false, text: 'usage: bookmarks add <url> [title]' };
    const args = { url };
    if (rest[1]) args.title = rest[1];
    if (flags.folder) args.parentId = flags.folder;
    return callTool(sessionId, 'chrome_bookmark_add', args);
  }
  if (sub === 'del') {
    const target = flags.url || rest[0];
    if (!target) return { ok: false, text: 'usage: bookmarks del <url|bookmarkId>' };
    const args = /^\d+$/.test(target) ? { bookmarkId: target } : { url: target };
    return callTool(sessionId, 'chrome_bookmark_delete', args);
  }
  return { ok: false, text: 'usage: bookmarks <search|add|del> ...' };
}

async function cmdNet(sessionId, flags) {
  const action = flags._[0] || 'stop';
  const args = { action };
  if (action === 'start') {
    if (flags.filter) args.url = flags.filter;
    if (flags.bodies) args.needResponseBody = true;
    if (flags.static) args.includeStatic = true;
  }
  return callTool(sessionId, 'chrome_network_capture', Object.assign(args, tabArg()));
}

async function cmdConsole(sessionId, flags) {
  const args = Object.assign({}, tabArg());
  if (flags.errors) args.onlyErrors = true;
  if (flags.clear) args.clearAfterRead = true;
  if (flags.buffer) args.mode = 'buffer';
  if (flags.pattern) args.pattern = flags.pattern;
  if (flags.limit != null) args.limit = parseInt(flags.limit, 10);
  return callTool(sessionId, 'chrome_console', args);
}

async function cmdDialog(sessionId, flags) {
  const action = flags._[0];
  if (action !== 'accept' && action !== 'dismiss') return { ok: false, text: 'usage: dialog <accept|dismiss> [--text prompt]' };
  const args = { action };
  if (flags.text) args.promptText = flags.text;
  return callTool(sessionId, 'chrome_handle_dialog', Object.assign(args, tabArg()));
}

async function cmdUpload(sessionId, flags) {
  const selector = flags.selector || flags._[0];
  const file = flags.file || flags._[1];
  if (!selector || !file) return { ok: false, text: 'usage: upload <selector> <file>' };
  return callTool(sessionId, 'chrome_upload_file', Object.assign({ selector, filePath: file }, tabArg()));
}

async function cmdInject(sessionId, flags) {
  const src = flags._.join(' ');
  if (!src) return { ok: false, text: 'usage: inject <js script source>' };
  const args = { jsScript: src };
  if (flags.main) args.type = 'MAIN';
  return callTool(sessionId, 'chrome_inject_script', Object.assign(args, tabArg()));
}

async function cmdSendCmd(sessionId, flags) {
  const eventName = flags._[0];
  const payloadJson = flags._.slice(1).join(' ') || '{}';
  if (!eventName) return { ok: false, text: 'usage: sendcmd <eventName> [json payload]' };
  let payload = {};
  try { payload = JSON.parse(payloadJson); } catch (e) { return { ok: false, text: 'bad payload JSON: ' + e.message }; }
  return callTool(sessionId, 'chrome_send_command_to_inject_script', Object.assign({ eventName, payload }, tabArg()));
}

const STORAGE_JS = `return (async () => {
  const out = { localStorage: Object.entries(localStorage), sessionStorage: Object.entries(sessionStorage), cookie: document.cookie };
  try {
    const req = indexedDB.databases ? await indexedDB.databases() : [];
    out.indexedDB = req.map((d) => d.name);
  } catch (e) { out.indexedDB = 'denied'; }
  return JSON.stringify(out);
})()`;

async function cmdStorage(sessionId, flags) {
  return callTool(sessionId, 'chrome_javascript', Object.assign({ code: STORAGE_JS }, tabArg()));
}

async function cmdComputer(sessionId, flags) {
  const action = flags._[0];
  if (!action) return { ok: false, text: 'usage: computer <action> [opts]  (screenshot|left_click|right_click|double_click|scroll|scroll_to|type|key|wait|resize_page|hover|fill|fill_form)' };
  const args = { action };
  const t = targetArgs(flags);
  if (t.selector) args.selector = t.selector;
  if (t.ref) args.ref = t.ref;
  if (flags.value != null) args.value = flags.value;
  if (flags.text != null) args.text = flags.text;
  if (flags.duration != null) args.duration = parseInt(flags.duration, 10);
  if (flags.direction) args.scrollDirection = flags.direction;
  if (flags.amount != null) args.scrollAmount = parseInt(flags.amount, 10);
  if (flags.width != null) args.width = parseInt(flags.width, 10);
  if (flags.height != null) args.height = parseInt(flags.height, 10);
  return callTool(sessionId, 'chrome_computer', Object.assign(args, tabArg()));
}

async function cmdPing(sessionId) {
  // Real roundtrip: requires an open MCP session AND host availability.
  const t0 = Date.now();
  const r = await mcpRpc('tools/list', {}, sessionId, 10000);
  const ms = Date.now() - t0;
  if (r.status !== 200 || !r.parsed || r.parsed.error) {
    const msg = (r.parsed && r.parsed.error && r.parsed.error.message) || `HTTP ${r.status}`;
    throw new BridgeError(`session broken: ${msg}`);
  }
  return { ok: true, latencyMs: ms, state: 'ok', mcpUrl: mcpUrl() };
}

async function cmdTools(sessionId, flags) {
  const r = await mcpRpc('tools/list', {}, sessionId);
  const tools = (r.parsed && r.parsed.result && r.parsed.result.tools) || [];
  const list = tools.map((t) => ({
    name: t.name,
    description: t.description || null,
    props: (t.inputSchema && t.inputSchema.properties) ? Object.keys(t.inputSchema.properties) : [],
  }));
  return { ok: true, count: list.length, tools: list };
}

async function cmdInstances(sessionId, flags) {
  // Multi-browser discovery: scan the port range and identify every live
  // bridge instance (browser, label, instanceId, endpoint, selector).
  //
  // Deliberately takes NO lock and does NOT require the CLI's own port to be
  // up: the whole point is to find the OTHER browsers, which is exactly when
  // the default port is usually down.
  const range = flags.range || cfg.range || PORT_RANGE;
  const list = await scanInstances(range);
  const instances = list.map((inst) => Object.assign({}, inst, {
    selector: inst.info ? (instanceSelectors(inst.port, inst.info)[0] || null) : null,
    identity: inst.info ? describeInstance(inst) : null,
  }));
  const live = instances.filter((r) => r.state === 'ok' || r.state === 'busy');
  return {
    ok: true,
    range,
    count: live.length,
    defaultPort: cfg.port,
    instances,
  };
}

async function cmdLabel(sessionId, flags, name) {
  const label = String(name == null ? '' : name).trim();
  if (!label) {
    return {
      ok: false, parsed: null,
      text: 'usage: mcpctl [--browser <sel>] label <name>   (names THIS instance so you can target it later)',
    };
  }
  const r = await callTool(sessionId, 'bridge_set_instance_label', { label });
  if (!r.ok) {
    const unknown = /unknown tool/i.test(r.text || '');
    return {
      ok: false, parsed: null,
      text: r.text +
        (unknown
          ? '\nThis bridge instance reports no label tool, i.e. the extension loaded in that browser is older than this CLI.'
            + '\nReload it once (chrome://extensions -> Reload) and retry.'
          : ''),
    };
  }
  // Keep the cache in step so `browsers` shows the new label immediately.
  const info = await fetchInstanceInfo(sessionId);
  if (info) cacheInstance(cfg.port, info);
  return {
    ok: true, parsed: null, port: cfg.port, label: (info && info.label) || label,
    text: `label set to "${(info && info.label) || label}" on ${cfg.host}:${cfg.port}`,
  };
}

async function cmdCall(sessionId, flags) {
  const tool = flags._[0];
  const argsJson = flags._.slice(1).join(' ') || '{}';
  if (!tool) return { ok: false, text: 'usage: call <tool> [json args]' };
  let args = {};
  try { args = JSON.parse(argsJson); } catch (e) { return { ok: false, text: 'bad args JSON: ' + e.message }; }
  return callTool(sessionId, tool, args);
}

async function cmdBatch(sessionId, flags) {
  const src = flags._[0] || '-';
  let raw;
  if (src === '-') {
    raw = fs.readFileSync(0, 'utf8');
  } else {
    if (!fs.existsSync(src)) return { ok: false, text: 'file not found: ' + src };
    raw = fs.readFileSync(src, 'utf8');
  }
  let jobs;
  try { jobs = JSON.parse(raw); } catch (e) {
    jobs = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  if (!Array.isArray(jobs)) return { ok: false, text: 'batch must be a JSON array of [tool, args] pairs' };
  const results = [];
  let failed = false;
  for (const [tool, args] of jobs) {
    try {
      const r = await callTool(sessionId, tool, args || {});
      results.push({ tool, ok: r.ok, text: r.text });
      if (!r.ok) failed = true;
    } catch (e) {
      results.push({ tool, ok: false, text: 'THROW: ' + e.message });
      failed = true;
    }
  }
  return { ok: !failed, count: results.length, failed, results };
}

// --------------------------------------------------------------------- REPL ---
async function repl(sessionId) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'mcpctl> ' });
  let queue = Promise.resolve();
  let replCfg = Object.assign({}, cfg, { json: false });

  const dispatch = (line) => {
    line = line.trim();
    if (!line) return;
    if (line === 'exit' || line === 'quit' || line === 'q') { rl.close(); return; }
    queue = queue.then(async () => {
      try {
        if (line.startsWith('!')) {
          const parts = line.slice(1).split(/\s+/);
          const r = await cmdCall(sessionId, { _: [parts[0], parts.slice(1).join(' ')] });
          out({ ok: r.ok, text: r.text });
          return;
        }
        const m = line.match(/^(\S+)(?:\s+([\s\S]*))?$/);
        const cmd = m[1];
        const rest = (m[2] || '').trim();
        const flags = parseFlags(rest.split(/\s+/), FLAG_WHITELIST);
        flags.json = false;
        await runCommand(sessionId, cmd, flags, replCfg);
      } catch (e) {
        process.stderr.write('[mcpctl] ' + ((e && e.message) || e) + '\n');
      }
    });
  };

  process.stdout.write('mcpctl repl - type "help" or "exit". Prefix raw tool calls with "!".\n');
  rl.on('line', dispatch);
  await new Promise((resolve) => rl.on('close', () => queue.then(resolve)));
}

const FLAG_WHITELIST = [
  'json', 'tab', 'timeout', 'port', 'host', 'browser',
  'interactive', 'depth', 'ref', 'full', 'selector', 'out',
  'html', 'text', 'double', 'button', 'value', 'delay',
  'query', 'max', 'ago', 'exclude-open', 'filter', 'bodies', 'static',
  'errors', 'clear', 'buffer', 'pattern', 'limit', 'main',
  'file', 'folder', 'url', 'duration', 'direction', 'amount', 'width', 'height',
  'wait', 'no-launch', 'lock-timeout', 'range',
];

async function runCommand(sessionId, cmd, flags, cfgOverride) {
  const saved = cfg;
  if (cfgOverride) cfg = cfgOverride;
  applyGlobalFlags(flags);
  let o;
  try {
    switch (cmd) {
      case 'status': o = await cmdStatus(sessionId, flags); break;
      case 'restart': { const ok = await restartHost(); o = { ok, hostPid: hostPid() }; break; }
      case 'ping': o = await cmdPing(sessionId); break;
      case 'tabs': case 'windows': o = await cmdTabs(sessionId, flags); break;
      case 'active': o = await cmdActive(sessionId, flags); break;
      case 'switch': o = await cmdSwitch(sessionId, flags, flags._[0]); break;
      case 'close': o = await cmdClose(sessionId, flags, flags._[0]); break;
      case 'read': o = await cmdRead(sessionId, flags); break;
      case 'content': o = await cmdContent(sessionId, flags); break;
      case 'interactive': o = await cmdInteractive(sessionId, flags); break;
      case 'eval': o = await cmdEval(sessionId, flags, flags._.join(' ')); break;
      case 'run': o = await cmdRun(sessionId, flags, flags._.join(' ')); break;
      case 'click': o = await cmdClick(sessionId, flags); break;
      case 'hover': o = await cmdHover(sessionId, flags); break;
      case 'fill': o = await cmdFill(sessionId, flags); break;
      case 'keys': o = await cmdKeys(sessionId, flags); break;
      case 'nav': o = await cmdNav(sessionId, flags); break;
      case 'shot': o = await cmdShot(sessionId, flags); break;
      case 'history': o = await cmdHistory(sessionId, flags); break;
      case 'bookmarks': o = await cmdBookmarks(sessionId, flags); break;
      case 'net': o = await cmdNet(sessionId, flags); break;
      case 'console': o = await cmdConsole(sessionId, flags); break;
      case 'dialog': o = await cmdDialog(sessionId, flags); break;
      case 'upload': o = await cmdUpload(sessionId, flags); break;
      case 'inject': o = await cmdInject(sessionId, flags); break;
      case 'sendcmd': o = await cmdSendCmd(sessionId, flags); break;
      case 'storage': o = await cmdStorage(sessionId, flags); break;
      case 'computer': o = await cmdComputer(sessionId, flags); break;
      case 'tools': o = await cmdTools(sessionId, flags); break;
      case 'call': o = await cmdCall(sessionId, flags); break;
      case 'batch': o = await cmdBatch(sessionId, flags); break;
      case 'browsers': case 'instances': case 'list': o = await cmdInstances(sessionId, flags); break;
      case 'label': o = await cmdLabel(sessionId, flags, flags._.join(' ')); break;
      case 'repl': await repl(sessionId); o = null; break;
      case 'help': case '-h': case '--help': process.stdout.write(USAGE + '\n'); o = null; break;
      default: throw new UsageError(`unknown command: ${cmd} (try: help)`);
    }
    lastCommandOk = !(o && typeof o === 'object' && o.ok === false);
    if (o) {
      if (!cfg.json) {
        if (cmd === 'tabs' || cmd === 'windows') o = fmtTabs(o.parsed);
        else if (cmd === 'read') o = fmtRead(o.parsed);
        else if (cmd === 'console') o = fmtConsole(o.parsed);
        else if (cmd === 'bookmarks') o = fmtBookmarks(o.parsed);
        else if (cmd === 'history') o = fmtHistory(o.parsed);
        else if (cmd === 'browsers' || cmd === 'instances' || cmd === 'list') o = fmtInstances(o.instances, cfg.port);
        else if (o.parsed && cmd === 'active' && o.tab) o = JSON.stringify({ tab: o.tab, windows: o.windows }, null, 2);
        else if (o.parsed && typeof o.text === 'string' && o.text.trim()) {
          o = o.parsed !== null ? JSON.stringify(o.parsed, null, 2) : o.text;
        } else if (o.parsed === null && o.text) o = o.text;
        else o = JSON.stringify(o, null, 2);
      }
      if (o != null) out(o);
    }
  } finally {
    cfg = saved;
  }
  return o;
}

// ------------------------------------------------------------- doctor/ensure ---
async function doctorReport() {
  const probe = await probeSession(5000);
  const pid = hostPid();
  const manifestPath = nativeHostManifestPath();
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { /* absent or invalid */ }
  const extManifestPath = findExtManifest();
  let extId = null, extName = null;
  try {
    const em = JSON.parse(fs.readFileSync(extManifestPath, 'utf8'));
    extName = em.name || null;
    extId = extIdFromKey(em.key);
  } catch (e) { /* extension folder not next to the CLI */ }
  const cmdline = pid ? hostCmdline(pid) : null;
  const hostProvenance = cmdline
    ? (/mcp-chrome-bridge/i.test(cmdline) && !(chromeRunning() || processRunning('brave.exe') || processRunning('msedge.exe'))
      ? 'standalone node process (no browser detected) - tools will fail until the extension owns the host'
      : 'node process (browser-spawned native host)')
    : (pid ? 'unknown process' : 'no host');
  const allowed = (manifest && manifest.allowed_origins) || [];
  const allowedMatch = extId ? allowed.some((o) => o.includes(extId)) : null;
  const o = {
    ok: probe.state === 'ok',
    state: probe.state,
    mcpUrl: mcpUrl(),
    host: cfg.host, port: cfg.port,
    hostPid: pid,
    hostProvenance,
    browser: {
      chromeRunning: chromeRunning(),
      braveRunning: processRunning('brave.exe'),
      edgeRunning: processRunning('msedge.exe'),
      browserPath: browserPath(),
    },
    nativeHostManifest: {
      path: manifestPath,
      exists: !!manifest,
      hostPath: (manifest && manifest.path) || null,
      allowed_origins: manifest ? allowed : null,
    },
    extension: {
      manifestPath: extManifestPath,
      name: extName,
      idFromKey: extId,
      expectedId: EXT_ID,
      idMatches: extId ? extId === EXT_ID : null,
      whitelistedInHost: allowedMatch,
    },
    probeMs: probe.ms,
    note: stateNote(probe.state, probe.note),
    remediation: probe.state === 'ok' ? null : remediation(),
  };
  const enriched = await enrichInstance(o, probe);
  try {
    enriched.instances = await scanInstances('12306-12340');
  } catch (e) { /* best-effort */ }
  return enriched;
}

async function ensureBridge(flags) {
  const waitS = flags.wait != null ? Math.max(1, parseInt(flags.wait, 10)) : 60;
  const launch = !flags['no-launch'];
  const t0 = Date.now();
  const deadline = Date.now() + waitS * 1000;
  let last = { state: 'down', note: '' };
  let launched = false, restarted = false;
  while (Date.now() < deadline) {
    last = await probeSession(4000);
    if (last.state === 'ok') break;
    if (last.state === 'down' && launch && !launched && browserPath()) {
      try {
        const exe = browserPath();
        spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        launched = true;
        process.stderr.write(`[mcpctl] launched browser: ${exe}\n`);
      } catch (e) { /* give up launching; keep polling */ }
    }
    if (!restarted && (last.state === 'broken' || last.state === 'busy')) {
      process.stderr.write(`[mcpctl] bridge ${last.state} - restarting host...\n`);
      restarted = true;
      await restartHost();
      continue;
    }
    if (Date.now() >= deadline) break;
    await sleep(1000);
  }
  const finalProbe = last.state === 'ok' ? last : await probeSession(4000);
  const o = statusObject(finalProbe);
  o.elapsedMs = Date.now() - t0;
  o.launchedBrowser = launched;
  o.restartedHost = restarted;
  o.browserPath = browserPath();
  if (finalProbe.state !== 'ok') o.remediation = remediation();
  return o;
}

// Commands that must run WITHOUT a session/lock (so they work while the CLI's
// own port is down, or while another client holds every session).
const DISCOVERY_COMMANDS = ['browsers', 'instances', 'list'];

// Every command the dispatchers understand, validated BEFORE any bridge work.
// Otherwise a typo is reported as "bridge DOWN" (exit 3) whenever no browser is
// connected, and as a usage error (exit 2) when one is - a contract that depends
// on the environment is not a contract.
const KNOWN_COMMANDS = new Set([
  'status', 'restart', 'ping', 'ensure', 'doctor', 'diag',
  'tabs', 'windows', 'active', 'switch', 'close',
  'read', 'content', 'interactive', 'eval', 'run',
  'click', 'hover', 'fill', 'keys', 'nav', 'shot',
  'history', 'bookmarks', 'net', 'console', 'dialog', 'upload',
  'inject', 'sendcmd', 'storage', 'computer',
  'tools', 'call', 'batch', 'label', 'repl', 'help', '-h', '--help',
  ...DISCOVERY_COMMANDS,
]);

// ------------------------------------------------------------------- main ---
const USAGE = `mcpctl - standalone CLI for the Chrome MCP bridge

Multi-browser: every browser running the extension owns its own MCP port.
  mcpctl browsers                          list every live browser + selectors
  mcpctl --browser <selector> <command>    target ONE browser. Selector can be:
                                             <label>      e.g. work   (set with: mcpctl label work)
                                             <name>:<port> e.g. edge:12311 (always unique)
                                             port:<n>     e.g. port:12311
                                             id:<prefix>  instanceId prefix
                                             <name>       chrome | edge | brave | opera
                                           --port always wins over --browser.
  mcpctl --range N-M ...                   override the scanned port range (default 12306-12340)

Usage: mcpctl <command> [args] [--json] [--tab <id>] [--port <n>] [--browser <selector>] [--range N-M] [--timeout <sec>] [--lock-timeout <sec>]

Commands:
  browsers | instances [--range N-M]
                          List every browser running the bridge: browser/version,
                          label, instanceId, endpoint, and the exact --browser
                          selector to use. Needs no session, so it works even
                          when this CLI's own port is down.
  label <name>            Name THIS browser's bridge instance (target it with
                          --browser first). Makes multi-browser targeting obvious.
  status [--wait N]       Real bridge health (host + extension roundtrip), host PID,
                          plus which browser/instance answered
  ping                    Verify an MCP session + tool roundtrip (reports latency)
  restart                 Kill the host; the extension respawns it (needs the browser)
  doctor | diag           Full environment report: host, browser, native host manifest,
                          extension ID match - use this when something won't start
  ensure [--wait N] [--no-launch]
                          Bring the bridge up: wait, launch a browser if needed,
                          restart a stale host until a real session roundtrip works
  tabs | windows          List windows and tabs
  active                  Active tab info
  switch <tabId>          Switch to tab
  close <tabId|url>       Close tab(s)
  read [--interactive] [--depth N] [--ref ref_X]
  content [--selector S] [--html]
  interactive             List clickable/interactable elements
  eval '<js>'             Run JS expression (result returned)
  run '<js>'              Run JS block (async body; must return)
  click <sel|ref> [--double] [--button right]
  hover <sel|ref>
  fill <sel|ref> <value>
  keys '<keys>'           Simulate keys (Enter, ctrl+a, ...)
  nav <url|back|forward|reload>
  shot [--full] [--selector S] [--out file.png]
  history [--query s] [--max N] [--ago "3 days ago"] [--exclude-open]
  bookmarks <search|add|del> ...
  net <start|stop> [--filter url] [--bodies] [--static]
  console [--errors] [--clear] [--buffer] [--pattern re] [--limit N]
  dialog <accept|dismiss> [--text prompt]
  upload <selector> <file>
  inject '<js source>' [--main]
  sendcmd <eventName> [json payload]
  storage                 localStorage/sessionStorage/cookies/IndexedDB
  computer <action> [opts]
  tools                   List bridge tools (name + input props)
  call <tool> '{"args":...}'
  batch <file|->          Run [tool,args] pairs in one session (JSON array or JSONL)
  repl                    Interactive session ("!tool {json}" for raw calls)
  help

Exit codes: 0 ok | 1 runtime error | 2 usage | 3 bridge down/unreachable | 4 another mcpctl busy
Environment: MCP_PORT, MCP_HOST (defaults 12306 / 127.0.0.1)
Health is measured with a real extension tool roundtrip, never a bare TCP check.`;

async function main() {
  // `let`, not `const`: leading global flags (mcpctl --browser X cmd /
  // mcpctl --port N cmd) are parsed by reassigning argv to the leftover
  // positionals. With const that assignment threw, was swallowed by the
  // try/catch below, and every leading-flag invocation died with
  // "unknown command: --browser".
  let argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE + '\n');
    return;
  }

  if (process.env.MCP_PORT) cfg.port = parseInt(process.env.MCP_PORT, 10);
  if (process.env.MCP_HOST) cfg.host = process.env.MCP_HOST;

  // Global flags may also come BEFORE the command for ergonomics:
  //   mcpctl --browser edge status   ==   mcpctl status --browser edge
  //   mcpctl --port 12307 eval 'x'   ==   mcpctl eval 'x' --port 12307
  let leadFlags = {};
  if (argv.length && argv[0].startsWith('--')) {
    leadFlags = extractLeadFlags(argv, GLOBAL_FLAGS);
    argv = leadFlags._;
  }
  if (argv.length === 0) {
    process.stdout.write(USAGE + '\n');
    return;
  }

  const command = argv[0];
  const rest = argv.slice(1);
  let flags;
  try {
    flags = parseFlags(rest, FLAG_WHITELIST);
  } catch (e) {
    process.stderr.write('[mcpctl] ' + e.message + '\n');
    process.exit(2);
  }
  flags = Object.assign({}, leadFlags, flags);
  applyGlobalFlags(flags); // honor --port/--host/--timeout/--lock-timeout/--browser for every command

  if (!KNOWN_COMMANDS.has(command)) {
    process.stderr.write(`[mcpctl] unknown command: ${command} (try: help)\n`);
    process.exit(2);
  }

  try {
    // Multi-browser targeting: --browser <selector> resolves to the matching
    // live instance's port. Explicit --port always wins.
    if (flags.browser && !flags.port && !DISCOVERY_COMMANDS.includes(command)) {
      const res = await resolveBrowser(flags.browser, flags.range || cfg.range);
      if (res.error) {
        process.stderr.write(`[mcpctl] ${res.error}.\n`);
        const candidates = res.ambiguous || res.instances;
        if (Array.isArray(candidates) && candidates.length) {
          process.stderr.write(fmtInstances(candidates, cfg.port) + '\n');
        }
        process.stderr.write('[mcpctl] run "mcpctl browsers" to list every live instance.\n');
        process.exitCode = 3;
        return;
      }
      cfg.port = res.port;
      if (!flags.json) process.stderr.write(`[mcpctl] targeting ${cfg.host}:${cfg.port} (--browser ${flags.browser})\n`);
      if (res.probe && res.probe.state === 'busy') {
        process.stderr.write('[mcpctl] note: that instance\'s session is busy right now - will retry through the lock.\n');
      }
    }
    // Discovery needs no session, no lock and no live default port - it is the
    // command you run precisely when the other browsers are the unknown.
    if (DISCOVERY_COMMANDS.includes(command)) {
      const o = await cmdInstances(null, flags);
      out(cfg.json ? o : fmtInstances(o.instances, cfg.port));
      process.exitCode = o.count > 0 ? 0 : 3;
      return;
    }
    if (command === 'status') {
      const o = await statusWithWait(flags);
      out(o);
      process.exitCode = o.ok ? 0 : (o.state === 'down' ? 3 : 1);
      return;
    }
    if (command === 'restart') {
      await acquireLock(cfg.lockTimeout);
      let o;
      try {
        const ok = await restartHost();
        o = { ok, hostPid: hostPid() };
      } finally { releaseLock(); lockHeld = false; }
      out(o);
      process.exitCode = o.ok ? 0 : 3;
      return;
    }
    if (command === 'doctor' || command === 'diag') {
      const o = await doctorReport();
      out(o);
      process.exitCode = o.state === 'ok' ? 0 : 1;
      return;
    }
    if (command === 'ensure') {
      await acquireLock(cfg.lockTimeout);
      let o;
      try {
        o = await ensureBridge(flags);
      } finally { releaseLock(); lockHeld = false; }
      out(o);
      process.exitCode = o.ok ? 0 : 3;
      return;
    }
    // Everything else needs a live bridge + session. withSession fails fast
    // when the bridge is down (no blind 45-60s recovery stalls) and serializes
    // concurrent invocations so they cannot collide on the singleton session.
    await withSession(async (sessionId) => {
      await runCommand(sessionId, command, flags, null);
      // Surface a failed tool/discovery result to the shell: scripts and the
      // agent loop branch on the exit code, and a command that reported
      // { ok: false } used to still exit 0.
      if (!lastCommandOk) process.exitCode = 1;
    });
  } catch (e) {
    const code = (e instanceof UsageError) ? 2 : ((e && e.exitCode) || 1);
    process.stderr.write('[mcpctl] FATAL: ' + ((e && e.message) || e) + '\n');
    // Set the code and return instead of process.exit(): calling exit() while
    // an undici keepalive socket is still closing aborts with a libuv assertion
    // on Windows (async.c), and natural exit drains handles cleanly.
    process.exitCode = code;
  }
}

main();
