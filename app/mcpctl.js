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
  strictPort: false,          // --strict-port / MCP_STRICT_PORT=1 -> never auto-retarget a dead pinned --port
  quiet: false,               // --quiet -> suppress info lines on stderr (payload only)
  raw: false,                 // --raw   -> print the tool envelope verbatim (no unwrapping)
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
  const startedAt = Date.now();
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcCounter, method, params });
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const budget = timeoutMs || cfg.timeout;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budget);
  const url = mcpUrl(port);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(`bridge unreachable at ${url} (${e.message}). Start Chrome with the extension connected, or run "mcpctl restart".`);
  }
  // The deadline must also cover the response BODY: a wedged host answers the
  // request and then holds the stream open (streamable-HTTP/SSE semantics), so
  // a plain `await res.text()` here - after clearTimeout - used to hang this
  // process forever while it held the cross-process lock, freezing every later
  // invocation until its lock timeout (the "random mcpctl freeze"). Race the
  // body read against the remaining budget and tear the socket down on miss.
  const left = Math.max(1000, budget - (Date.now() - startedAt));
  let bodyTimer = null;
  try {
    const text = await Promise.race([
      res.text(),
      new Promise((_, rej) => {
        bodyTimer = setTimeout(() => rej(new Error(`response body exceeded ${left}ms - host held the stream open (wedged bridge)`)), left);
        if (bodyTimer.unref) bodyTimer.unref();
      }),
    ]);
    return { status: res.status, sessionId: res.headers.get('mcp-session-id'), parsed: parseResponse(text), raw: text };
  } catch (e) {
    try { ctl.abort(); } catch (a) { /* already aborted */ }
    throw e;
  } finally {
    if (bodyTimer) clearTimeout(bodyTimer);
    clearTimeout(timer);
  }
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

// Bounded DELETE. This runs in the `finally` of EVERY probe, so an unbounded
// fetch here meant a single wedged host (socket accepted, no reply) could hang
// the whole port scan - and `browsers` with it - forever. 2.5s and move on.
async function closeSession(sessionId, port, timeoutMs = 2500) {
  if (!sessionId) return;
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (e) { /* already gone */ } }, timeoutMs);
  if (timer.unref) timer.unref();
  try {
    await fetch(mcpUrl(port), { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId }, signal: ctl.signal });
  } catch (e) { /* ignore - a wedged host must never hang the caller */ }
  finally { clearTimeout(timer); }
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
// ALWAYS resolves within timeoutMs. The old version only re-armed on 'error':
// a port that neither accepts nor refuses (firewalled, or a listener that never
// completes the handshake) fired no event at all, so the promise never settled
// and every caller - probes, restart waits, discovery - hung with it.
function portOpen(port, host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const budget = Math.max(150, timeoutMs);
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(hard); resolve(v); } };
    const hard = setTimeout(() => finish(false), budget);
    if (hard.unref) hard.unref();
    const attempt = () => {
      if (settled) return;
      const sock = net.connect({ port, host });
      const kill = setTimeout(() => { sock.destroy(); }, budget);
      if (kill.unref) kill.unref();
      sock.on('connect', () => { clearTimeout(kill); sock.destroy(); finish(true); });
      sock.on('error', () => { clearTimeout(kill); sock.destroy(); setTimeout(attempt, 120); });
      sock.on('timeout', () => { clearTimeout(kill); sock.destroy(); });
    };
    attempt();
  });
}

function hostPidOn(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(':' + port) && /LISTENING/i.test(line)) {
        const m = line.trim().split(/\s+/);
        return m[m.length - 1];
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}
function hostPid() { return hostPidOn(cfg.port); }

function killPid(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /PID ${pid}`, { windowsHide: true });
    else execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    return true;
  } catch (e) { return false; } // already dead
}

// Chromium-family image names the respawn check accepts. Custom builds rename
// the exe, so detection is a heuristic - never a hard gate (see restartHost).
const BROWSER_IMAGES = ['chrome.exe', 'msedge.exe', 'brave.exe', 'chromium.exe', 'vivaldi.exe', 'opera.exe', 'arc.exe'];
function browserRunning() { return BROWSER_IMAGES.some((img) => processRunning(img)); }

async function restartHost() {
  const pid = hostPid();
  if (!pid) return { ok: false, port: cfg.port }; // nothing was listening -> nothing to restart, no respawn coming
  killPid(pid);
  // Wait for the port to actually close.
  await waitPortClosed(cfg.host, cfg.port, 15000);
  // The host only respawns when the extension reconnects over native messaging.
  // Don't burn up to 45s waiting when no browser with the extension is running -
  // but allow one short grace window first, since the process-name heuristic can
  // miss custom Chromium builds.
  if (!browserRunning()) {
    await sleep(6000);
    if (!browserRunning()) return { ok: false, port: cfg.port };
  }
  // Wait for a host whose session probe actually succeeds (host + extension),
  // bailing early on 'busy' (rogue singleton) and skipping pure port-open states.
  // The respawn may land on a DIFFERENT port (EADDRINUSE -> next free slot), so
  // sweep the range when the pinned port stays silent and follow the bridge.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await portOpen(cfg.port, cfg.host, 400)) {
      const probe = await probeSession(3000);
      if (probe.state === 'ok') { await sleep(800); return { ok: true, port: cfg.port }; }
      if (probe.state === 'busy') return { ok: false, port: cfg.port };
    }
    const alt = await findRespawnedPort();
    if (alt) { cfg.port = alt; await sleep(800); return { ok: true, port: alt }; }
    await sleep(1000);
  }
  return { ok: false, port: cfg.port };
}

// Scan the port range (skipping the pinned port) for a freshly respawned bridge.
async function findRespawnedPort() {
  const [lo, hi] = parseRange(cfg.range || PORT_RANGE);
  const cands = [];
  for (let p = lo; p <= hi; p++) if (p !== cfg.port) cands.push(p);
  for (let start = 0; start < cands.length; start += SCAN_CONCURRENCY) {
    const batch = cands.slice(start, start + SCAN_CONCURRENCY).map((p) => probeInstanceOn(p, 2000));
    const res = await Promise.all(batch);
    const ok = res.find((r) => r.state === 'ok');
    if (ok) return ok.port;
  }
  return null;
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
          `another mcpctl instance (pid ${pid}) is busy (lock: ${lp}). Wait for it to finish, or delete the lock file if it is stale.`);
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
// Every per-browser native-messaging manifest location we know about. Each
// Chromium-family browser keeps its OWN host list, so a host registered for
// Chrome alone leaves the bridge permanently offline in Brave/Edge/Chromium.
// doctor reports all of them instead of only the first that exists.
function nativeHostManifestCandidates() {
  const ap = process.env.APPDATA || '';
  const la = process.env.LOCALAPPDATA || '';
  const pd = process.env.ProgramData || '';
  const name = 'com.chromemcp.nativehost.json';
  return [
    { browser: 'chrome', path: path.join(ap, 'Google', 'Chrome', 'NativeMessagingHosts', name) },
    { browser: 'chrome', path: path.join(la, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts', name) },
    { browser: 'chrome', path: path.join(pd, 'Google', 'Chrome', 'NativeMessagingHosts', name) },
    { browser: 'edge', path: path.join(la, 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts', name) },
    { browser: 'brave', path: path.join(la, 'BraveSoftware', 'Brave-Browser', 'User Data', 'NativeMessagingHosts', name) },
    { browser: 'brave-beta', path: path.join(la, 'BraveSoftware', 'Brave-Browser-Beta', 'User Data', 'NativeMessagingHosts', name) },
    { browser: 'brave-nightly', path: path.join(la, 'BraveSoftware', 'Brave-Browser-Nightly', 'User Data', 'NativeMessagingHosts', name) },
    { browser: 'chromium', path: path.join(ap, 'Chromium', 'NativeMessagingHosts', name) },
  ].filter((c) => c.path && /nativehost/i.test(c.path));
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
    case 'busy': return 'bridge busy - another MCP client holds the singleton session (run "mcpctl restart" to reclaim it, or "mcpctl reap" if zombie hosts piled up)';
    case 'broken': return `bridge host UP but extension unreachable (${extra || 'session probe failed'})`;
    default: return String(state);
  }
}

// ----------------------------------------------------------------- instance ---
// Multi-browser support: every browser running the extension owns its own MCP
// port. These helpers discover live instances and resolve --browser targets.
// `timeoutMs` is deliberately explicit at the call sites inside probes: leaving
// it undefined let these calls inherit cfg.timeout (60s), so a host whose
// extension was gone - answering initialize, then stalling on tools/call -
// burned a full minute per port and made every `browsers` sweep look frozen.
async function fetchInstanceInfo(sessionId, port, timeoutMs) {
  try {
    const r = await callTool(sessionId, 'bridge_get_instance_info', {}, timeoutMs, port);
    return r.parsed || null;
  } catch (e) {
    return null;
  }
}

// Identity-less description of an instance: window/tab counts + the active tab.
// Used only when the identity tool is unavailable (extension older than this CLI).
async function fetchInstanceFallback(sessionId, port, timeoutMs) {
  try {
    const r = await callTool(sessionId, 'get_windows_and_tabs', {}, timeoutMs, port);
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
// Hard-bounded wrapper. Every individual RPC inside is already deadline'd, but
// a scan is only as fast as its slowest member: this guarantees one wedged port
// can never hold a batch past ~2x its probe budget, so `browsers` always returns.
async function probeInstanceOn(port, timeoutMs = 3000) {
  const bounded = Math.max(1200, Math.min(timeoutMs || 3000, 3000));
  const start = Date.now();
  let timer = null;
  const hard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      port, state: 'broken', ms: Date.now() - start,
      note: 'probe exceeded its deadline (host accepted the socket but never answered)',
    }), bounded * 2 + 1500);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([hard, probeInstanceInner(port, bounded, start)]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeInstanceInner(port, timeoutMs, start) {
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
    const info = await fetchInstanceInfo(sid, port, timeoutMs);
    if (info) cacheInstance(port, info);
    // Older extension builds have no identity tool. Rather than report a live
    // browser as a blank row, fall back to its tabs so a human can still tell
    // the instances apart ("that's the one with the Jira tab").
    const unidentified = info ? null : await fetchInstanceFallback(sid, port, timeoutMs);
    // A host that accepts a session but answers NO tool at all is a zombie: its
    // process is still listening while the extension is gone. Reporting that as
    // "ok" is what let a dead host on the DEFAULT port shadow the live browser
    // one slot over - so `tabs` (and everything else) died on the zombie while a
    // healthy bridge sat at :12307. Zombies are now broken, never preferred.
    if (!info && !unidentified) {
      return {
        port, state: 'broken', ms: Date.now() - start,
        note: 'host answers MCP but dispatches no tools (zombie host - run "mcpctl reap")',
      };
    }
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
// `overallMs` caps the WHOLE sweep: discovery returns whatever it has instead of
// running to the end of the range when several ports are wedged (partial results
// beat a hang for a command whose job is to answer "what is live right now?").
async function scanInstances(range, timeoutMs = 3000, overallMs = 20000) {
  const [lo, hi] = parseRange(range);
  const out = [];
  const deadline = Date.now() + Math.max(4000, overallMs);
  for (let start = lo; start <= hi; start += SCAN_CONCURRENCY) {
    if (Date.now() > deadline) break;
    const batch = [];
    for (let p = start; p <= Math.min(hi, start + SCAN_CONCURRENCY - 1); p++) batch.push(probeInstanceOn(p, timeoutMs));
    out.push(...(await Promise.all(batch)));
  }
  return out.filter((r) => r.state !== 'down');
}

// The extension owns its own port (deterministic per browser instance, and it
// moves to the next free slot on an EADDRINUSE collision), so 12306 is only a
// starting guess. When that port is dead and the caller pinned neither --port
// nor --browser, look for the live instance elsewhere in the range before any
// command fails with "bridge DOWN" while the bridge is up one port over.
function instanceLiveness(inst) {
  if (!inst) return 0;
  if (inst.info) return 2;         // identity tool answered -> extension is attached
  if (inst.unidentified) return 1; // tabs fallback answered -> extension is attached
  return 0;                        // bare MCP server: maybe a zombie host
}

async function discoverLivePort(range) {
  // A host process can outlive its extension (the service worker dies while the
  // host keeps listening), and such a zombie still answers initialize. It must
  // never win over an instance a real extension is attached to, or every command
  // targets a port nothing can serve.
  let best = null;
  const consider = (inst, cached) => {
    if (!inst || (inst.state !== 'ok' && inst.state !== 'busy')) return;
    const rank = instanceLiveness(inst);
    if (!best || rank > best.rank) best = { port: inst.port, probe: inst, rank, cached: !!cached };
  };

  // A port we probed before is the cheapest first guess; only sweep the whole
  // range when the cache has nothing live.
  const cachedPorts = Object.keys(readInstanceCache())
    .map((p) => parseInt(p, 10))
    .filter((p) => Number.isInteger(p) && p !== cfg.port);
  for (const p of cachedPorts) {
    if (!(await portOpen(p, cfg.host, 300))) continue;
    consider(await probeInstanceOn(p, 2500), true);
    if (best && best.rank >= 2) return best;
  }
  if (best && best.rank >= 2) return best;
  for (const inst of await scanInstances(range, 2500)) consider(inst, false);
  return best;
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
  const bits = [];
  // Name the actual blocker first: "bridge down" and "browser not running" are
  // different problems, and the second one is the common one after a reboot.
  if (!browserRunning()) {
    bits.push('No Chromium browser is running right now - run "mcpctl ensure" (or "mcpctl restart") and it will launch one for you.');
  }
  bits.push('Each browser instance owns a port in ' + PORT_RANGE + ', and every command auto-targets the live one, so "mcpctl restart" is enough to recover.');
  bits.push('"mcpctl browsers" lists every live instance; "mcpctl doctor" has the full environment report; "mcpctl ensure --wait 90" waits for or launches the bridge.');
  return bits.join(' ');
}
function statusObject(probe) {
  return {
    ok: probe.state === 'ok',
    state: probe.state,
    host: cfg.host, port: cfg.port,
    hostPid: hostPid(),
    browserRunning: browserRunning(),
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

// Soft recovery for transient session errors: the extension's service worker is
// allowed to sleep between calls, so a failed handshake usually just needs a
// moment. Bounded (~7s) so a genuinely wedged host still falls through to the
// restart path quickly.
async function retryInit(attempts = 5, gapMs = 700) {
  for (let i = 0; i < attempts; i++) {
    await sleep(gapMs);
    if (!(await portOpen(cfg.port, cfg.host, 400))) return { error: null }; // port gone -> restart path
    try {
      return { sessionId: await initSession(undefined, 8000) };
    } catch (e) {
      const m = String((e && e.message) || e);
      if (!(m.includes(FUSE_OK) || TRANSPORT_ERROR_RE.test(m))) return { fatal: e };
    }
  }
  return { error: null };
}
async function withSession(fn) {
  // Serialize invocations (single-session bridge) before probing.
  await acquireLock(cfg.lockTimeout);
  let sessionId = null;
  let recoveredDown = false; // one self-heal pass per invocation, never a loop
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
          // Stale singleton ("Already connected") or an idle-killed service
          // worker is TRANSIENT - the extension wakes again on the next
          // roundtrip. Retry the handshake with backoff first: killing the host
          // out from under a working extension was the sledgehammer, and when
          // the respawn never arrived it left the bridge down for good.
          const soft = await retryInit();
          if (soft.sessionId) {
            sessionId = soft.sessionId;
            activeSession = sessionId;
            return await fn(sessionId);
          }
          if (soft.fatal) throw BridgeError.from(soft.fatal);
          // Still no session - only now is a host restart justified.
        }
      } else if (probe.state === 'down') {
        // Nothing on this port. That is usually not a dead bridge but a MOVED
        // one (the host takes the next free slot after a respawn) or a closed
        // browser - so attempt one bounded, quiet recovery before failing.
        // Any command then heals the bridge instead of demanding the user go
        // hunt for the right port number: the "random port" pain, gone.
        if (!recoveredDown) {
          recoveredDown = true;
          if (!cfg.strictPort) {
            const found = await discoverLivePort(cfg.range);
            if (found) {
              cfg.port = found.port;
              process.stderr.write(`[mcpctl] bridge was on another port - now using ${cfg.host}:${cfg.port}\n`);
              continue;
            }
          }
          if (browserRunning()) {
            // Only kill-and-wait when a host process actually EXISTS. A pinned
            // port that was never listening usually means the browser/extension
            // is still starting up - killing "nothing" and then racing the
            // extension's own spawn is exactly how a healthy fresh host gets
            // murdered at birth. Give the extension's alarm-driven reconnect
            // one bounded chance first; it needs no kill at all.
            const existing = hostPid();
            if (!existing) {
              process.stderr.write('[mcpctl] bridge DOWN - no host yet, giving the extension 12s to connect on its own...\n');
              const grew = await waitPortOpen(cfg.host, cfg.port, 12000) ||
                (!cfg.strictPort && !!(await discoverLivePort(cfg.range)));
              if (grew) continue;
            }
            process.stderr.write('[mcpctl] bridge DOWN - restarting the host and waiting for it...\n');
            await restartHost();
            if (await waitPortOpen(cfg.host, cfg.port, 8000)) continue;
          }
        }
        throw new BridgeError(`bridge DOWN at ${mcpUrl()}. ${remediation()}`);
      }
      const state = probe.state === 'ok' ? 'session error' : probe.state;
      if (attempt >= 2) throw new BridgeError(`bridge ${state} persists after retries. ${remediation()}`);
      // A zombie host on this port (extension gone, process still listening)
      // must not win over a HEALTHY instance one slot over - so look for a live
      // one before reaching for the kill. Only if none exists do we restart.
      if (!cfg.strictPort) {
        const found = await discoverLivePort(cfg.range);
        if (found && found.port !== cfg.port) {
          process.stderr.write(`[mcpctl] bridge ${state} on :${cfg.port} - live instance found, switching to ${cfg.host}:${found.port}\n`);
          cfg.port = found.port;
          continue;
        }
      }
      process.stderr.write(`[mcpctl] bridge ${state} (${String(probe.note || '').slice(0, 80)}) - restarting host...\n`);
      const rr = await restartHost();
      if (!rr.ok) throw new BridgeError(`host did not respawn with a working extension. ${remediation()}`);
      if (rr.port !== cfg.port) cfg.port = rr.port;
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

// chrome_javascript answers with { tabId, result } and `result` is frequently a
// JSON-encoded *string* ({"a":1} arrives as "{\"a\":1}"). Print it as the value
// that was actually evaluated instead of a double-encoded envelope, so callers
// do not have to parse the CLI's output a second time.
function unwrapJsResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  if (!Object.prototype.hasOwnProperty.call(parsed, 'result')) return parsed;
  const meta = Object.keys(parsed).filter((k) => k !== 'result' && k !== 'tabId' && k !== 'frameId');
  if (meta.length) return parsed; // richer shape (other tools) -> leave untouched
  const v = parsed.result;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t && (t[0] === '{' || t[0] === '[')) { try { return JSON.parse(t); } catch (e) { /* keep as string */ } }
  }
  return v;
}

function fmtValue(v) {
  if (v === undefined) return '(undefined)';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

// `--in <file>` or a positional `-` reads the payload from a file / stdin, so
// multi-line JS and nested JSON never have to survive shell quoting.
function inputArg(flags, positional) {
  if (flags.in) {
    try { return fs.readFileSync(String(flags.in), 'utf8'); }
    catch (e) { throw new UsageError('cannot read --in ' + flags.in + ': ' + e.message); }
  }
  if (positional != null && String(positional).trim() === '-') return fs.readFileSync(0, 'utf8');
  return positional;
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

// One line per bridge tool instead of ~330 lines of nested JSON. Descriptions
// stay available behind --json / --raw.
function fmtTools(o) {
  if (!o || !Array.isArray(o.tools)) return pretty(o);
  const lines = o.tools.map((t) => `${(t.name || '?').padEnd(36)} ${(t.props || []).join(', ')}`.replace(/\s+$/, ''));
  return lines.join('\n') + `\n\n${o.tools.length} tools - add --json for full schemas`;
}

// ------------------------------------------------------------------- args ---
// Flags that take NO value. Without this, `mcpctl --raw eval 'x'` swallowed
// "eval" as the value of --raw and then died with "unknown command: x".
const BOOLEAN_FLAGS = new Set(['json', 'quiet', 'raw', 'interactive', 'full', 'html', 'double', 'bodies', 'static', 'errors', 'clear', 'buffer', 'main', 'no-launch', 'exclude-open', 'strict-port', 'force']);

function parseFlags(argv, known) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (known.includes(name)) {
        if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
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

const GLOBAL_FLAGS = ['json', 'tab', 'timeout', 'port', 'host', 'lock-timeout', 'browser', 'range', 'quiet', 'raw', 'strict-port'];

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
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; i += 1; continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i += 2; }
    else { flags[name] = true; i += 1; }
  }
  flags._ = argv.slice(i);
  return flags;
}

function applyGlobalFlags(flags) {
  if (flags.json) cfg.json = true;
  if (flags.quiet) cfg.quiet = true;
  if (flags.raw) cfg.raw = true;
  if (flags.tab != null) cfg.tab = parseInt(flags.tab, 10);
  if (flags.timeout != null) cfg.timeout = parseInt(flags.timeout, 10) * 1000;
  if (flags.port != null) cfg.port = parseInt(flags.port, 10);
  if (flags.host) cfg.host = flags.host;
  if (flags['lock-timeout'] != null) cfg.lockTimeout = parseInt(flags['lock-timeout'], 10) * 1000;
  if (flags.browser) cfg.browser = String(flags.browser);
  if (flags['strict-port']) cfg.strictPort = true;
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
  const src = inputArg(flags, flags._.join(' '));
  if (!src) return { ok: false, text: 'usage: inject <js script source>   (or: inject - | inject --in file.js)' };
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

// reap: kill every host in the scan range that is NOT healthy - wedged 'busy'
// hosts (stale transport from a dead client) and 'broken' zombies. The healthy
// instance (if any) is left alone. A 'busy' port whose cross-process lock is
// held by a LIVE pid is skipped: that is a real client mid-call, not a zombie.
async function cmdReap(flags) {
  const range = flags.range || cfg.range || PORT_RANGE;
  const found = await scanInstances(range, 2500);
  const healthy = found.filter((r) => r.state === 'ok').map((r) => r.port);
  const killed = [];
  const skipped = [];
  for (const k of found.filter((r) => r.state === 'busy' || r.state === 'broken')) {
    const saved = cfg.port;
    cfg.port = k.port;
    try {
      const lockPid = (() => { try { return parseInt(fs.readFileSync(lockFilePath(), 'utf8'), 10); } catch (e) { return null; } })();
      if (k.state === 'busy' && lockPid && pidAlive(lockPid)) {
        skipped.push({ port: k.port, state: k.state, reason: `live mcpctl pid ${lockPid} holds the lock` });
        continue;
      }
      const pid = hostPid();
      if (!pid) continue;
      if (killPid(pid)) killed.push({ port: k.port, pid, state: k.state });
    } finally { cfg.port = saved; }
  }
  // Give the extension a moment to respawn a clean host for the reaped slots.
  let respawned = null;
  if (killed.length) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !respawned) {
      respawned = await findRespawnedPort();
      if (!respawned) await sleep(1000);
    }
  }
  return {
    ok: true,
    range,
    killed,
    skipped,
    healthy,
    respawned,
    note: killed.length
      ? (respawned ? `reaped ${killed.length} zombie host(s); bridge healthy on ${cfg.host}:${respawned}`
                   : `reaped ${killed.length} zombie host(s); no respawn yet - the extension reconnects on its next alarm`)
      : (healthy.length ? 'nothing to reap - all hosts healthy' : 'nothing listening to reap'),
  };
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

// ---------------------------------------------------------- intercept proxy ---
// Route the browser's ENTIRE traffic through a local intercepting proxy (Caido
// on 127.0.0.1:9999 by default) so every request — XHR, subresources,
// navigations, service workers, websockets — lands in the interceptor's history
// instead of only the tabs we explicitly capture. Talks to the extension's
// chrome_proxy tool through the record_replay_flow_run dispatcher, which also
// works before the host re-handshakes and publishes flow.proxy.
async function cmdCaido(sessionId, flags) {
  const raw = String(flags._[0] || 'status').toLowerCase();
  const action = raw === 'enable' ? 'on' : raw === 'disable' ? 'off' : raw;
  if (!['on', 'off', 'status'].includes(action)) {
    return { ok: false, text: 'caido subcommands: on [--proxy-port N] [--proxy-host H] [--force], off, status' };
  }
  const args = { action };
  if (flags['proxy-host']) args.host = flags['proxy-host'];
  if (flags['proxy-port']) args.port = parseInt(flags['proxy-port'], 10);
  if (flags.force) args.force = true;

  let r;
  try {
    r = await callTool(sessionId, 'record_replay_flow_run', { flowId: 'proxy', args });
    if (!r.ok && /unknown published tool|not registered/i.test(r.text || '')) throw new Error(r.text);
  } catch (e) {
    // Older extension without the published entry: fall back to the raw tool.
    r = await callTool(sessionId, 'chrome_proxy', args);
  }
  if (!r.ok) return r;

  const d = r.parsed || {};
  let text;
  if (action === 'status') {
    text = d.enabled
      ? `interception ON -> ${d.host}:${d.port} (${d.reachable === false ? 'port NOT answering' : 'reachable'})`
      : `interception off${d.reachable === false ? ' (nothing listening on the configured proxy port)' : ''}`;
  } else if (d.enabled) {
    text = `interception ON -> http://${d.host}:${d.port}${d.reachable === false ? ' (warning: port did not answer)' : ''}\n${d.message || ''}`.trim();
  } else {
    text = `interception off${d.warning ? '\n' + d.warning : ''}`;
  }
  return { ok: true, parsed: d, text, enabled: !!d.enabled, port: d.port || null };
}

async function cmdCall(sessionId, flags) {
  const tool = flags._[0];
  const argsJson = inputArg(flags, flags._.slice(1).join(' ')) || '{}';
  if (!tool) return { ok: false, text: 'usage: call <tool> [json args]   (or: call <tool> -  to read JSON args from stdin)' };
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
  'json', 'tab', 'timeout', 'port', 'host', 'browser', 'quiet', 'raw', 'in',
  'interactive', 'depth', 'ref', 'full', 'selector', 'out',
  'html', 'text', 'double', 'button', 'value', 'delay',
  'query', 'max', 'ago', 'exclude-open', 'filter', 'bodies', 'static',
  'errors', 'clear', 'buffer', 'pattern', 'limit', 'main',
  'file', 'folder', 'url', 'duration', 'direction', 'amount', 'width', 'height',
  'wait', 'no-launch', 'lock-timeout', 'range', 'strict-port',
  'proxy-host', 'proxy-port', 'force',
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
      case 'eval': o = await cmdEval(sessionId, flags, String(inputArg(flags, flags._.join(' ')) || '').trim()); break;
      case 'run': o = await cmdRun(sessionId, flags, inputArg(flags, flags._.join(' '))); break;
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
      case 'caido': case 'proxy': o = await cmdCaido(sessionId, flags); break;
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
        else if (cmd === 'tools' && Array.isArray(o.tools)) o = fmtTools(o);
        else if (o.parsed && cmd === 'active' && o.tab) o = JSON.stringify({ tab: o.tab, windows: o.windows }, null, 2);
        else if ((cmd === 'eval' || cmd === 'run' || cmd === 'call') && o.parsed !== null && !cfg.raw) o = fmtValue(unwrapJsResult(o.parsed));
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
  // Which running browser is missing a host manifest (or a manifest listing our
  // extension ID)? That is THE cause of a native host that reads "offline".
  const manifests = nativeHostManifestCandidates().map((c) => {
    let m = null;
    try { m = JSON.parse(fs.readFileSync(c.path, 'utf8')); } catch (e) { /* absent */ }
    const origins = (m && m.allowed_origins) || [];
    return {
      browser: c.browser,
      path: c.path,
      exists: !!m,
      allowedOurId: m ? origins.some((o) => o.includes(EXT_ID)) : false,
      hostPath: (m && m.path) || null,
    };
  });
  const runningBrowsers = [
    ['brave', processRunning('brave.exe')],
    ['chrome', chromeRunning()],
    ['edge', processRunning('msedge.exe')],
  ].filter(([, on]) => on).map(([n]) => n);
  const unregistered = [...new Set(runningBrowsers.filter((b) => {
    const forBrowser = manifests.filter((m) => m.browser === b);
    return forBrowser.length > 0 && !forBrowser.some((m) => m.allowedOurId);
  }))];
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
    nativeHostRegistration: {
      runningBrowsers,
      missingForRunningBrowsers: unregistered,
      manifests,
      fix: unregistered.length
        ? 'register the native host for: ' + unregistered.join(', ') +
          ' (node chrome-mcp-extension/scripts/register-host.js --apply), then reload the extension'
        : null,
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

// Commands where auto-discovery must NOT retarget the port: the discovery
// commands scan by design, and reap scans on purpose. `restart` is deliberately
// NOT excluded any more - recovery is its whole job, so when the port it was
// pointed at is dead it follows the bridge to the port that is actually live
// (and if none is, the restart branch brings a browser up).
const NO_AUTO_DISCOVER = DISCOVERY_COMMANDS.concat(['reap']);

// Every command the dispatchers understand, validated BEFORE any bridge work.
// Otherwise a typo is reported as "bridge DOWN" (exit 3) whenever no browser is
// connected, and as a usage error (exit 2) when one is - a contract that depends
// on the environment is not a contract.
const KNOWN_COMMANDS = new Set([
  'status', 'restart', 'reap', 'ping', 'ensure', 'doctor', 'diag',
  'tabs', 'windows', 'active', 'switch', 'close',
  'read', 'content', 'interactive', 'eval', 'run',
  'click', 'hover', 'fill', 'keys', 'nav', 'shot',
  'history', 'bookmarks', 'net', 'console', 'dialog', 'upload',
  'inject', 'sendcmd', 'storage', 'computer',
  'tools', 'call', 'batch', 'label', 'repl', 'help', '-h', '--help',
  'caido', 'proxy',
  ...DISCOVERY_COMMANDS,
]);

// ------------------------------------------------------------------- main ---
const USAGE = `mcpctl - standalone CLI for the Chrome MCP bridge

Multi-browser: every browser running the extension owns its own MCP port.
  mcpctl browsers                          list every live browser + selectors
  mcpctl reap                              kill zombie hosts (wedged/broken) across the range; keep healthy ones
  mcpctl --browser <selector> <command>    target ONE browser. Selector can be:
                                             <label>      e.g. work   (set with: mcpctl label work)
                                             <name>:<port> e.g. edge:12311 (always unique)
                                             port:<n>     e.g. port:12311
                                             id:<prefix>  instanceId prefix
                                             <name>       chrome | edge | brave | opera
                                           --port always wins over --browser.
  mcpctl --range N-M ...                   override the scanned port range (default 12306-12340)

Ports are never something you have to know: every command auto-targets the live
instance, and a DEAD --port is re-discovered (the host moves to the next free
slot when it respawns). Pass --strict-port (or MCP_STRICT_PORT=1) to pin a port
literally and never follow the host when it moves.

Usage: mcpctl <command> [args] [--json] [--quiet] [--raw] [--tab <id>] [--port <n>] [--browser <selector>] [--range N-M] [--timeout <sec>] [--lock-timeout <sec>] [--strict-port]

Output: results print as plain values by default (a JS result is auto-unwrapped,
so "mcpctl eval '1+1'" prints exactly "2"). --raw prints the tool envelope
verbatim; --json prints the full machine-readable object; --quiet drops the
informational stderr lines and keeps only the payload.

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
  restart                 Recover the bridge, whatever is wrong: follows the host if it
                          moved ports, kills a wedged host (extension respawns it), and
                          launches + waits for a browser when none is running. This is
                          the one command to run when "mcpctl tabs" says the bridge is down.
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
  eval '<js>' | -         Run JS expression and print the VALUE (auto-unwrapped).
                          '-' reads the JS from stdin; --in <file> from a file.
  run '<js>' | -          Run JS block (async body; must return). Also takes '-'/--in.
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
  call <tool> '{"args":...}'|-   Raw tool call; '-' reads the JSON args from stdin.
  batch <file|->          Run [tool,args] pairs in one session (JSON array or JSONL)
  caido <on|off|status> [--proxy-port N] [--proxy-host H] [--force]
                          Route ALL browser traffic through a local intercepting
                          proxy (Caido, default 127.0.0.1:9999) so every request
                          shows up in the interceptor's history. Refuses to
                          enable when nothing answers on the port (so browsing
                          can't break); --force overrides. Alias: proxy.
  repl                    Interactive session ("!tool {json}" for raw calls)
  help

Examples:
  mcpctl eval 'document.title'
  mcpctl eval - <<'EOF'          # multi-line JS, no shell quoting
  (function () {
    return fetch('/api/me', { credentials: 'include' })
      .then(r => r.text()).then(t => t.slice(0, 400));
  })()
  EOF
  mcpctl call chrome_javascript - <<'EOF'
  {"code":"return document.cookie"}
  EOF
  mcpctl batch jobs.json              # [["tool",{args}], ...] in one session
  mcpctl nav https://example.com --quiet && mcpctl eval 'location.href'

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
  if (process.env.MCP_STRICT_PORT === '1') cfg.strictPort = true;

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
    // Port auto-discovery. The extension may be listening on ANY port in the
    // range, so before a command dies with "bridge DOWN" check whether the
    // instance moved (or was never on the default port to begin with). Skipped
    // whenever the caller pinned a port/browser, so explicit intent always wins.
    // A pinned --port is honored while it is alive. When it is DEAD, discovery
    // still runs (unless --strict-port / MCP_STRICT_PORT=1): the host moves to
    // the next free slot whenever it respawns, so a stale port number in a
    // script or shell history used to fail every command while the bridge sat
    // healthy one port over. That was the "random port" failure, permanently.
    const portPinned = (flags.port != null) || (process.env.MCP_PORT != null);
    if (!flags.browser && !cfg.strictPort && !NO_AUTO_DISCOVER.includes(command)
      && !(await portOpen(cfg.port, cfg.host, 400))) {
      const found = await discoverLivePort(flags.range || cfg.range);
      if (found) {
        const why = portPinned ? `pinned :${cfg.port} was dead, host moved` : `auto-discovered${found.cached ? ' cached instance' : ''}`;
        cfg.port = found.port;
        if (!flags.json && !cfg.quiet) {
          process.stderr.write(`[mcpctl] bridge on ${cfg.host}:${cfg.port} (${why})\n`);
        }
      }
    }
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
      if (!flags.json && !cfg.quiet) process.stderr.write(`[mcpctl] targeting ${cfg.host}:${cfg.port} (--browser ${flags.browser})\n`);
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
        // 1) The host may have moved to another port after an earlier respawn.
        //    Follow it first, so `restart` always acts on the live bridge.
        if (!(await portOpen(cfg.port, cfg.host, 400)) && !cfg.strictPort) {
          const found = await discoverLivePort(flags.range || cfg.range);
          if (found) cfg.port = found.port;
        }
        // 2) Normal path: kill the host; the extension respawns it (wherever it lands).
        let r = await restartHost();
        if (r.ok && r.port !== cfg.port) cfg.port = r.port;
        // 3) Nothing to restart and nothing listening anywhere: the browser is
        //    not running (or the extension never spawned a host). `restart` is
        //    the command people reach for when the bridge is dead, so it now
        //    brings the whole stack back instead of printing where to look:
        //    launch a browser and wait, exactly like `ensure`.
        if (!r.ok && !(await portOpen(cfg.port, cfg.host, 400))) {
          const healed = await ensureBridge({
            wait: flags.wait != null ? flags.wait : 60,
            'no-launch': flags['no-launch'],
          });
          o = Object.assign({}, healed, { port: cfg.port, hostPid: hostPid(), healedBy: 'ensure' });
          if (o.ok) {
            o.note = `bridge came up healthy on ${mcpUrl()}${healed.launchedBrowser ? ' (launched the browser)' : ''}`;
          } else if (!browserRunning()) {
            o.note = 'No Chromium browser is running, so the native host cannot start. Open the browser with the bridge extension loaded, then run "mcpctl restart" again (or "mcpctl ensure" to let this CLI launch it: ' + (browserPath() || 'no browser executable found') + ').';
          } else {
            o.note = 'The browser is running but its extension never reached the host. Reload the extension once (chrome://extensions -> Reload) or run "mcpctl doctor".';
          }
          out(o);
          process.exitCode = o.ok ? 0 : 3;
          return;
        }
        o = { ok: r.ok, port: r.port, hostPid: hostPid() };
        if (r.ok) {
          o.note = `bridge respawned and healthy on ${mcpUrl(r.port)}`;
        } else if (!browserRunning()) {
          o.note = 'No Chromium browser is running, so nothing can respawn the host. Start the browser with the bridge extension loaded, then retry (or run "mcpctl restart" again - it now launches one automatically).';
        } else {
          o.note = `host did not respawn on ${mcpUrl()}; the host is still wedged. Run "mcpctl reap", then "mcpctl restart".`;
        }
      } finally { releaseLock(); lockHeld = false; }
      out(o);
      process.exitCode = o.ok ? 0 : 3;
      return;
    }
    if (command === 'reap') {
      await acquireLock(cfg.lockTimeout);
      let o;
      try {
        o = await cmdReap(flags);
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
