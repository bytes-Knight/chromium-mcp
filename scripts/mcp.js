#!/usr/bin/env node
// scripts/mcp.js — single CLI for the mcp-chrome-bridge (127.0.0.1:12306).
//
//   node scripts/mcp.js <command> [args] [--json]
//
// Commands:
//   status            Bridge health + host PID
//   restart           Kill a stuck host and wait for the extension to respawn it
//   tabs              List windows and tabs
//   active            Active tab info
//   switch <tabId>    Switch to tab
//   read [opts]       Read page: --interactive, --depth N, --ref X, --tab T
//   eval '<js>'       Run a JS expression (returned)
//   run '<js>'        Run a JS block (full async body; must return)
//   click <sel|ref>   Click element (CSS selector or ref_)
//   fill <sel|ref> <v>  Fill form value
//   keys '<keys>'     Simulate key presses (e.g. "Enter", "ctrl+a")
//   nav <url|cmd>     Navigate: url | back | forward | reload
//   shot [opts]       Screenshot: --full, --out file.png
//   tools             List bridge tools
//   call <tool> '{}'  Raw tool call with JSON args
//   storage           localStorage/sessionStorage/cookies/IndexedDB summary
//   sn-state          Standard Notes key/lock state summary
//   unlock <pass>     Unlock the SN passcode lock screen
//   lock              Re-lock SN (click the lock item)
//   repl              Interactive session (single persistent MCP session)
//   help
//
// Global flags: --json (machine-readable output), --tab <id>.
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const readline = require('readline');

const MCP_URL = 'http://127.0.0.1:12306/mcp';
const PORT = 12306;
const HOST_JS = 'C:/Users/mdlim/AppData/Roaming/npm/node_modules/mcp-chrome-bridge/dist/index.js';

let rpcCounter = 0;

// ---------------------------------------------------------------- transport ---
async function mcpRpc(method, params, sessionId) {
  rpcCounter++;
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcCounter, method, params });
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(MCP_URL, { method: 'POST', headers, body });
  const sid = res.headers.get('mcp-session-id');
  const text = await res.text();
  const jsonLines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  let parsed = null;
  for (const jl of jsonLines) {
    try { parsed = JSON.parse(jl); } catch (e) { /* skip */ }
  }
  if (!parsed) { try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text.slice(0, 300) }; } }
  return { status: res.status, sessionId: sid, parsed };
}

async function initSession() {
  const init = await mcpRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-cli', version: '2.0.0' },
  }, null);
  if (init.status !== 200 || !init.sessionId) {
    const err = (init.parsed && (init.parsed.message || init.parsed.error)) || JSON.stringify(init).slice(0, 200);
    throw new Error(String(err));
  }
  await mcpRpc('notifications/initialized', {}, init.sessionId).catch(() => {});
  return init.sessionId;
}

async function closeSession(sessionId) {
  try { await fetch(MCP_URL, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } }); } catch (e) { /* ignore */ }
}

// ------------------------------------------------------------ host recovery ---
function portOpen(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
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
      if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
        const m = line.trim().split(/\s+/);
        return m[m.length - 1];
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function restartHost() {
  const pid = hostPid();
  if (pid) {
    try {
      // execSync runs through cmd.exe on win32, so single-slash flags.
      if (process.platform === 'win32') execSync(`taskkill /F /PID ${pid}`, { windowsHide: true });
      else execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    } catch (e) { /* already dead */ }
  }
  // extension auto-reconnects and respawns the host; poll until the port returns
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await portOpen(PORT, 800)) return true;
  }
  return false;
}

// The bridge's McpServer is a singleton — a stale session makes every new
// initialize fail with "Already connected to a transport". Recover by killing
// the host (the extension respawns it fresh) and retrying.
async function withSession(fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let sessionId = null;
    try {
      sessionId = await initSession();
      return await fn(sessionId);
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/Already connected/i.test(msg) && attempt < 2) {
        console.error('[mcp] stale session detected — restarting host…');
        await restartHost();
        continue;
      }
      throw e;
    } finally {
      if (sessionId) await closeSession(sessionId);
    }
  }
}

// ---------------------------------------------------------------- tool call ---
async function callTool(sessionId, tool, args) {
  const call = await mcpRpc('tools/call', { name: tool, arguments: args || {} }, sessionId);
  const result = call.parsed && call.parsed.result;
  if (call.parsed && call.parsed.error) throw new Error(JSON.stringify(call.parsed.error).slice(0, 300));
  const text = result && result.content && result.content.map((c) => c.text || '').join('\n');
  const isError = result && result.isError;
  return { ok: !isError, text: text || JSON.stringify(call.parsed || call).slice(0, 300) };
}

// --------------------------------------------------------------- output fmt ---
function printOut(obj, json) {
  if (json) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); return; }
  if (typeof obj === 'string') { process.stdout.write(obj + '\n'); return; }
  if (obj && typeof obj === 'object' && 'text' in obj) {
    const t = obj.text;
    try { process.stdout.write(JSON.stringify(JSON.parse(t), null, 2) + '\n'); }
    catch (e) { process.stdout.write(t + '\n'); }
    return;
  }
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ------------------------------------------------------------------- utils ---
function parseArgs(argv) {
  const flags = { json: false, interactive: false, full: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--interactive') flags.interactive = true;
    else if (a === '--full') flags.full = true;
    else if (a === '--depth') flags.depth = parseInt(argv[++i], 10);
    else if (a === '--ref') flags.ref = argv[++i];
    else if (a === '--tab') flags.tab = parseInt(argv[++i], 10);
    else if (a === '--out') flags.out = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

function tabArg(flags) { return flags.tab ? { tabId: flags.tab } : {}; }

// ------------------------------------------------------------- sub-commands ---
async function cmdStatus(sessionId, flags) {
  const pid = hostPid();
  const open = await portOpen(PORT, 800);
  return { ok: open, port: PORT, hostPid: pid, mcpUrl: MCP_URL, note: open ? 'bridge healthy' : 'bridge DOWN' };
}

async function cmdTabs(sessionId, flags) {
  const r = await callTool(sessionId, 'get_windows_and_tabs', {});
  return r;
}

async function cmdActive(sessionId, flags) {
  const r = await callTool(sessionId, 'get_windows_and_tabs', {});
  try {
    const wins = JSON.parse(r.text);
    const tab = wins.flatMap((w) => w.tabs).find((t) => t.active);
    return { tab: tab || null, windows: wins.length };
  } catch (e) { return r; }
}

async function cmdRead(sessionId, flags) {
  const args = Object.assign({}, tabArg(flags));
  if (flags.interactive) args.filter = 'interactive';
  if (flags.depth !== undefined) args.depth = flags.depth;
  if (flags.ref) args.refId = flags.ref;
  return callTool(sessionId, 'chrome_read_page', args);
}

async function cmdEval(sessionId, flags, code) {
  return callTool(sessionId, 'chrome_javascript', Object.assign({ code: 'return (' + code + ')' }, tabArg(flags)));
}

async function cmdRun(sessionId, flags, code) {
  return callTool(sessionId, 'chrome_javascript', Object.assign({ code }, tabArg(flags)));
}

async function cmdClick(sessionId, flags, target) {
  const args = Object.assign({}, tabArg(flags));
  if (/^ref_\d+$/.test(target)) args.ref = target;
  else args.selector = target;
  return callTool(sessionId, 'chrome_click_element', args);
}

async function cmdFill(sessionId, flags, target, value) {
  const args = Object.assign({ value }, tabArg(flags));
  if (/^ref_\d+$/.test(target)) args.ref = target;
  else args.selector = target;
  return callTool(sessionId, 'chrome_fill_or_select', args);
}

async function cmdKeys(sessionId, flags, keys) {
  return callTool(sessionId, 'chrome_keyboard', Object.assign({ keys }, tabArg(flags)));
}

async function cmdNav(sessionId, flags, target) {
  if (target === 'reload') return callTool(sessionId, 'chrome_navigate', Object.assign({ refresh: true, background: true }, tabArg(flags)));
  const url = (target === 'back' || target === 'forward') ? target : target;
  return callTool(sessionId, 'chrome_navigate', Object.assign({ url }, tabArg(flags)));
}

async function cmdShot(sessionId, flags) {
  const r = await callTool(sessionId, 'chrome_screenshot', Object.assign({
    storeBase64: true,
    savePng: false,
    fullPage: !!flags.full,
  }, tabArg(flags)));
  if (flags.out && !flags.json) {
    try {
      const parsed = JSON.parse(r.text);
      const b64 = parsed.base64 || (parsed.data && parsed.data.base64);
      if (b64) {
        fs.writeFileSync(flags.out, Buffer.from(b64, 'base64'));
        return { ok: true, saved: flags.out, bytes: Buffer.byteLength(b64, 'base64') };
      }
    } catch (e) { /* fall through */ }
    // try generic extraction of the first long base64 string
    const m = r.text.match(/[A-Za-z0-9+/=]{100,}/);
    if (m) {
      fs.writeFileSync(flags.out, Buffer.from(m[0], 'base64'));
      return { ok: true, saved: flags.out, bytes: m[0].length };
    }
    return { ok: false, text: r.text.slice(0, 200) };
  }
  return r;
}

async function cmdTools(sessionId, flags) {
  const r = await mcpRpc('tools/list', {}, sessionId);
  const tools = (r.parsed && r.parsed.result && r.parsed.result.tools) || [];
  return { ok: true, count: tools.length, tools: tools.map((t) => t.name) };
}

async function cmdCall(sessionId, flags, tool, argsJson) {
  let args = {};
  if (argsJson) { try { args = JSON.parse(argsJson); } catch (e) { return { ok: false, text: 'bad args JSON: ' + e.message }; } }
  return callTool(sessionId, tool, args);
}

async function cmdStorage(sessionId, flags) {
  const code = `return (async () => {
    const out = { localStorage: Object.entries(localStorage), sessionStorage: Object.entries(sessionStorage), cookie: document.cookie };
    try {
      const req = indexedDB.databases ? await indexedDB.databases() : [];
      out.indexedDB = req.map((d) => d.name);
    } catch (e) { out.indexedDB = 'denied'; }
    return JSON.stringify(out);
  })()`;
  return callTool(sessionId, 'chrome_javascript', Object.assign({ code }, tabArg(flags)));
}

async function cmdSnState(sessionId, flags) {
  const code = `return (async () => {
    const out = {};
    out.lockScreen = document.body.innerText.slice(0, 60);
    out.keychain = localStorage.getItem('keychain');
    try {
      const app = window.mainApplicationGroup && window.mainApplicationGroup.primaryApplication;
      if (!app) { out.app = 'none'; return JSON.stringify(out); }
      const m = app.dependencies && app.dependencies.dependencies;
      const get = (name) => { if (!m) return null; for (const [k, v] of m.entries()) { const d = (typeof k === 'symbol') ? (k.description || k.toString()) : String(k); if (d === name) return v; } return null; };
      const rkm = get('RootKeyManager');
      if (rkm) {
        try { out.hasPasscode = await rkm.hasPasscode(); } catch (e) { out.hasPasscode = 'err'; }
        try { out.hasRootKeyWrapper = await rkm.hasRootKeyWrapper(); } catch (e) { out.hasRootKeyWrapper = 'err'; }
        out.keyMode = rkm.keyMode;
        try { const rk = await rkm.getRootKey(); out.rootKeyInMemory = rk ? 'PRESENT' : 'null'; } catch (e) { out.rootKeyInMemory = 'err'; }
        try { const rk2 = await rkm.getRootKeyFromKeychain(); out.rootKeyFromKeychain = rk2 ? 'PRESENT' : 'null'; } catch (e) { out.rootKeyFromKeychain = 'err'; }
      }
      const es = get('EncryptionService');
      if (es) { try { out.isPasscodeLocked = await es.isPasscodeLocked(); } catch (e) { out.isPasscodeLocked = 'err'; } }
      const ims = get('InMemoryStore');
      if (ims) { out.inMemoryStore = JSON.stringify(ims.values || {}).slice(0, 60); }
      const im = get('ItemManager');
      if (im && im.collection) { const arr = im.collection.all ? im.collection.all() : []; out.itemsInMemory = arr.length; }
      try {
        const db = await new Promise((r) => { const q = indexedDB.open('standardnotes'); q.onsuccess = (e) => r(e.target.result); q.onerror = () => r(null); });
        if (db) { const cnt = await new Promise((r) => { const t = db.transaction('items').objectStore('items').count(); t.onsuccess = () => r(t.result); t.onerror = () => r(-1); }); out.indexedItems = cnt; }
      } catch (e) { out.indexedErr = String(e).slice(0, 60); }
    } catch (e) { out.err = String(e).slice(0, 200); }
    return JSON.stringify(out);
  })()`;
  return callTool(sessionId, 'chrome_javascript', Object.assign({ code }, tabArg(flags)));
}

async function cmdUnlock(sessionId, flags, passcode) {
  const code = `(() => {
    const input = document.querySelector('input[placeholder="Application Passcode"]');
    if (!input) return JSON.stringify({ ok: false, why: 'no passcode input found (maybe already unlocked)' });
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(passcode)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const submit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Submit');
    if (submit) submit.click();
    return JSON.stringify({ ok: true, submitted: true });
  })()`;
  const r = await callTool(sessionId, 'chrome_javascript', Object.assign({ code }, tabArg(flags)));
  await new Promise((res) => setTimeout(res, 1200));
  const after = await cmdRead(sessionId, flags);
  return { unlock: r, pageAfter: after.text.slice(0, 200) };
}

async function cmdLock(sessionId, flags) {
  const r = await callTool(sessionId, 'chrome_click_element', Object.assign({ selector: '#lock-item' }, tabArg(flags)));
  return r;
}

// --------------------------------------------------------------------- REPL ---
async function repl(sessionId, flags) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  // Chain commands so piped stdin (which closes immediately) still drains fully
  // before the session is torn down.
  let queue = Promise.resolve();
  const dispatch = (line) => {
    line = line.trim();
    if (!line) return;
    if (line === 'exit' || line === 'quit') { rl.close(); return; }
    queue = queue.then(async () => {
      try {
        const parts = line.split(/\s+/);
        const cmd = parts[0];
        const rest = line.slice(cmd.length).trim();
        let out;
        if (cmd === 'tabs') out = await cmdTabs(sessionId, flags);
        else if (cmd === 'active') out = await cmdActive(sessionId, flags);
        else if (cmd === 'read') { const f = { ...flags, interactive: /--interactive/.test(rest) }; out = await cmdRead(sessionId, f); }
        else if (cmd === 'eval') out = await cmdEval(sessionId, flags, rest);
        else if (cmd === 'run') out = await cmdRun(sessionId, flags, rest);
        else if (cmd === 'click') out = await cmdClick(sessionId, flags, rest.split(/\s+/)[0]);
        else if (cmd === 'fill') { const m = rest.match(/^(\S+)\s+([\s\S]+)$/); out = m ? await cmdFill(sessionId, flags, m[1], m[2]) : { ok: false, text: 'usage: fill <sel|ref> <value>' }; }
        else if (cmd === 'keys') out = await cmdKeys(sessionId, flags, rest);
        else if (cmd === 'nav') out = await cmdNav(sessionId, flags, rest);
        else if (cmd === 'shot') out = await cmdShot(sessionId, flags);
        else if (cmd === 'storage') out = await cmdStorage(sessionId, flags);
        else if (cmd === 'sn-state') out = await cmdSnState(sessionId, flags);
        else if (cmd === 'unlock') out = await cmdUnlock(sessionId, flags, rest);
        else if (cmd === 'lock') out = await cmdLock(sessionId, flags);
        else if (cmd === 'status') out = await cmdStatus(sessionId, flags);
        else if (cmd === 'help') { console.log(USAGE); return; }
        else out = { ok: false, text: 'unknown command: ' + cmd + ' (try: help)' };
        printOut(out, false);
      } catch (e) {
        console.error('[mcp] ' + (e && e.message || e));
      }
    });
  };
  process.stdout.write('mcp repl — type "help" or "exit"\n');
  rl.on('line', dispatch);
  await new Promise((resolve) => rl.on('close', () => queue.then(resolve)));
}

// ------------------------------------------------------------------- main ---
const USAGE = `mcp — mcp-chrome-bridge CLI

Usage: node scripts/mcp.js <command> [args] [--json] [--tab <id>]

Commands:
  status                 Bridge health + host PID
  restart                Kill stuck host, wait for respawn
  tabs                   List windows and tabs
  active                 Active tab info
  switch <tabId>         Switch to tab
  read [--interactive] [--depth N] [--ref ref_X]
  eval '<js>'            Run JS expression
  run '<js>'             Run JS block (async body; must return)
  click <sel|ref>        Click element
  fill <sel|ref> <value> Fill form value
  keys '<keys>'          Simulate keys
  nav <url|back|forward|reload>
  shot [--full] [--out file.png]
  tools                  List bridge tools
  call <tool> '{"args":…}'  Raw tool call
  storage                Dump browser storage
  sn-state               Standard Notes key/lock state
  unlock <passcode>      Unlock SN passcode lock screen
  lock                   Re-lock SN
  repl                   Interactive session
  help`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];
  const rest = positional.slice(1);

  await withSession(async (sessionId) => {
    let out;
    switch (command) {
      case 'status': out = await cmdStatus(sessionId, flags); break;
      case 'restart': { const ok = await restartHost(); out = { ok, hostPid: hostPid() }; break; }
      case 'tabs': out = await cmdTabs(sessionId, flags); break;
      case 'active': out = await cmdActive(sessionId, flags); break;
      case 'switch': out = await callTool(sessionId, 'chrome_switch_tab', { tabId: parseInt(rest[0], 10) }); break;
      case 'read': out = await cmdRead(sessionId, flags); break;
      case 'eval': out = await cmdEval(sessionId, flags, rest.join(' ')); break;
      case 'run': out = await cmdRun(sessionId, flags, rest.join(' ')); break;
      case 'click': out = await cmdClick(sessionId, flags, rest[0]); break;
      case 'fill': out = await cmdFill(sessionId, flags, rest[0], rest.slice(1).join(' ')); break;
      case 'keys': out = await cmdKeys(sessionId, flags, rest.join(' ')); break;
      case 'nav': out = await cmdNav(sessionId, flags, rest[0] || 'reload'); break;
      case 'shot': out = await cmdShot(sessionId, flags); break;
      case 'tools': out = await cmdTools(sessionId, flags); break;
      case 'call': out = await cmdCall(sessionId, flags, rest[0], rest[1]); break;
      case 'storage': out = await cmdStorage(sessionId, flags); break;
      case 'sn-state': out = await cmdSnState(sessionId, flags); break;
      case 'unlock': out = await cmdUnlock(sessionId, flags, rest[0] || ''); break;
      case 'lock': out = await cmdLock(sessionId, flags); break;
      case 'repl': await repl(sessionId, flags); out = null; break;
      default: console.error('unknown command: ' + command + '\n' + USAGE); process.exitCode = 2; out = null;
    }
    if (out) printOut(out, flags.json);
  }).catch((e) => {
    console.error('[mcp] FATAL: ' + (e && e.message || e));
    process.exit(1);
  });
}

main();
