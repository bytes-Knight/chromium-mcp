#!/usr/bin/env node
// scripts/mcp.js — single CLI for the mcp-chrome-bridge (127.0.0.1:12306).
//
//   node scripts/mcp.js <command> [args] [--json] [--tab <id>]
//
// Commands:
//   status            Bridge health + host PID
//   restart           Kill a stuck host and wait for the extension to respawn it
//   tabs              List windows and tabs
//   active            Active tab info
//   switch <tabId>    Switch to tab
//   open <url> [...]  Open new tab(s): --bg, --pin, --window <id>, --index N
//   close <targets>   Close tabs: ids, url:<u>, domain:<d>, all, others [--keep ids],
//                     window <ids>; --all closes every tab
//   dup <ids>         Duplicate tab(s)
//   reload [ids|--all] [--cache]
//   discard [ids|--all]
//   pin <ids>         Pin tab(s)
//   unpin <ids>       Unpin tab(s)
//   mute <ids>        Mute tab(s)
//   unmute <ids>      Unmute tab(s)
//   move <ids>        Move tabs: --window <id>, --index N
//   group <ids>       Group tabs: --name X, --color C; also: ungroup <ids>, groups
//   search <query>    Find tabs by title/URL/host
//   content-search <query>
//   window            new|close|state|arrange|focus (see "mcp window help")
//   zoom [f|in|out|reset]
//   cookies           list/get/set/delete for a URL
//   downloads         list|cancel|pause|resume|erase|open|show
//   trace             start [--reload] [--auto] [--duration MS] | stop | analyze
//  gif                    start [--fps N] [--auto] | stop [--base64] [--out file.gif] | status | capture | export
//   read [opts]       Read page: --interactive, --depth N, --ref X, --tab T
//   eval '<js>'       Run a JS expression (returned)
//   run '<js>'        Run a JS block (full async body; must return)
//   click <sel|ref>   Click element (CSS selector or ref_)
//   fill <sel|ref> <v>  Fill form value
//   keys '<keys>'     Simulate key presses (e.g. "Enter", "ctrl+a")
//   nav <url|cmd>     Navigate: url | back | forward | reload; --new-tab opens a new tab
//   shot [opts]       Screenshot: --full, --out file.png
//   tools             List bridge tools
//   call <tool> '{}'  Raw tool call with JSON args
//   storage           localStorage/sessionStorage/cookies/IndexedDB summary
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
    clientInfo: { name: 'mcp-cli', version: '2.1.0' },
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
  const flags = {};
  const positional = [];
  const valueFlags = new Set(['--window', '--keep', '--name', '--color', '--w', '--h', '--state', '--layout', '--duration', '--fps', '--index', '--limit', '--tab', '--out', '--depth', '--ref', '--query', '--path', '--domain']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) flags[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function tabArg(flags) { return flags.tab ? { tabId: Number(flags.tab) } : {}; }

// Parse "12 13,14" into [12,13,14].
function idsFrom(items) {
  const out = [];
  for (const item of items) {
    for (const part of String(item).split(',')) {
      const n = Number(part.trim());
      if (!isNaN(n)) out.push(n);
    }
  }
  return out;
}

// ------------------------------------------------------------- sub-commands ---
async function cmdStatus(sessionId, flags) {
  const pid = hostPid();
  const open = await portOpen(PORT, 800);
  return { ok: open, port: PORT, hostPid: pid, mcpUrl: MCP_URL, note: open ? 'bridge healthy' : 'bridge DOWN' };
}

async function cmdTabs(sessionId, flags) {
  return callTool(sessionId, 'get_windows_and_tabs', {});
}

async function cmdActive(sessionId, flags) {
  const r = await callTool(sessionId, 'get_windows_and_tabs', {});
  try {
    const wins = JSON.parse(r.text);
    const tab = wins.flatMap((w) => w.tabs).find((t) => t.active);
    return { tab: tab || null, windows: wins.length };
  } catch (e) { return r; }
}

async function cmdOpen(sessionId, flags, urls) {
  if (!urls.length) return { ok: false, text: 'usage: open <url> [url2 …] [--bg] [--pin] [--window <id>] [--index N]' };
  const args = {
    urls,
    active: !flags.bg,
  };
  if (flags.pin) args.pinned = true;
  if (flags.window) args.windowId = Number(flags.window);
  if (flags.index) args.index = Number(flags.index);
  return callTool(sessionId, 'chrome_open_tabs', args);
}

async function cmdClose(sessionId, flags, targets) {
  const args = {};
  if (targets.includes('all')) {
    args.all = true;
  } else if (targets.includes('others')) {
    let keep = flags.keep ? idsFrom([flags.keep]) : null;
    if (!keep || !keep.length) {
      // Keep the current active tab so the browser never ends up empty.
      const r = await callTool(sessionId, 'get_windows_and_tabs', {});
      try {
        const wins = JSON.parse(r.text);
        const active = wins.flatMap((w) => w.tabs).find((t) => t.active);
        keep = active ? [active.id] : [];
      } catch (e) { keep = []; }
    }
    args.allExcept = keep;
  } else if (targets[0] === 'window') {
    const ids = idsFrom(targets.slice(1));
    if (!ids.length) return { ok: false, text: 'usage: close window <windowId> …' };
    return callTool(sessionId, 'chrome_close_tabs', { windowIds: ids });
  } else {
    const tabIds = [];
    let url = null;
    let domain = null;
    for (const t of targets) {
      if (t.startsWith('url:')) url = t.slice(4);
      else if (t.startsWith('domain:')) domain = t.slice(7);
      else {
        const n = Number(t);
        if (!isNaN(n)) tabIds.push(n);
      }
    }
    if (tabIds.length) args.tabIds = tabIds;
    else if (url) args.url = url;
    else if (domain) args.domain = domain;
    else return { ok: false, text: 'usage: close <tabIds…> | url:<u> | domain:<d> | all | others [--keep ids] | window <ids>' };
  }
  return callTool(sessionId, 'chrome_close_tabs', args);
}

async function cmdDup(sessionId, flags, ids) {
  if (!ids.length) return { ok: false, text: 'usage: dup <tabId> [tabId …]' };
  return callTool(sessionId, 'chrome_duplicate_tabs', { tabIds: ids });
}

async function cmdReload(sessionId, flags, ids) {
  const args = { bypassCache: !!flags.cache };
  if (flags.all) args.all = true;
  else if (ids.length) args.tabIds = ids;
  else Object.assign(args, tabArg(flags));
  return callTool(sessionId, 'chrome_reload_tabs', args);
}

async function cmdDiscard(sessionId, flags, ids) {
  const args = {};
  if (flags.all) args.all = true;
  else if (ids.length) args.tabIds = ids;
  else Object.assign(args, tabArg(flags));
  return callTool(sessionId, 'chrome_discard_tabs', args);
}

async function cmdPinUnpin(sessionId, flags, ids, mode) {
  if (!ids.length) return { ok: false, text: `usage: ${mode} <tabId> [tabId …]` };
  return callTool(sessionId, mode === 'pin' ? 'chrome_pin_tabs' : 'chrome_unpin_tabs', { tabIds: ids });
}

async function cmdMuteUnmute(sessionId, flags, ids, mode) {
  if (!ids.length) return { ok: false, text: `usage: ${mode} <tabId> [tabId …]` };
  return callTool(sessionId, mode === 'mute' ? 'chrome_mute_tabs' : 'chrome_unmute_tabs', { tabIds: ids });
}

async function cmdMove(sessionId, flags, ids) {
  if (!ids.length) return { ok: false, text: 'usage: move <tabId> [tabId …] [--window <id>] [--index N]' };
  const args = { tabIds: ids };
  if (flags.window) args.windowId = Number(flags.window);
  if (flags.index) args.index = Number(flags.index);
  return callTool(sessionId, 'chrome_move_tabs', args);
}

async function cmdGroup(sessionId, flags, ids) {
  if (!ids.length) return { ok: false, text: 'usage: group <tabId> [tabId …] [--name X] [--color C]' };
  const args = { tabIds: ids };
  if (flags.name) args.title = flags.name;
  if (flags.color) args.color = flags.color;
  if (flags.window) args.windowId = Number(flags.window);
  return callTool(sessionId, 'chrome_group_tabs', args);
}

async function cmdUngroup(sessionId, flags, ids) {
  const args = {};
  if (ids.length) args.tabIds = ids;
  else return { ok: false, text: 'usage: ungroup <tabId> [tabId …]' };
  return callTool(sessionId, 'chrome_ungroup_tabs', args);
}

async function cmdGroups(sessionId, flags) {
  return callTool(sessionId, 'chrome_tab_groups', {});
}

async function cmdSearch(sessionId, flags, query) {
  if (!query) return { ok: false, text: 'usage: search <query>' };
  const args = { query };
  if (flags.window) args.windowId = Number(flags.window);
  return callTool(sessionId, 'chrome_search_tabs', args);
}

async function cmdContentSearch(sessionId, flags, query) {
  if (!query) return { ok: false, text: 'usage: content-search <query>' };
  const args = { query };
  if (flags.limit) args.maxResults = Number(flags.limit);
  return callTool(sessionId, 'chrome_search_tabs_content', args);
}

async function cmdWindow(sessionId, flags, rest) {
  const sub = rest[0] || 'help';
  switch (sub) {
    case 'new': {
      const urls = rest.slice(1);
      const args = { urls, focused: true };
      if (flags.incognito) args.incognito = true;
      if (flags.w) args.width = Number(flags.w);
      if (flags.h) args.height = Number(flags.h);
      if (flags.state) args.state = flags.state;
      return callTool(sessionId, 'chrome_new_window', args);
    }
    case 'close': {
      const args = {};
      if (flags.all) args.all = true;
      else if (flags.current) args.current = true;
      else {
        const ids = idsFrom(rest.slice(1));
        if (ids.length) args.windowIds = ids;
        else return { ok: false, text: 'usage: window close <windowId> … | --all | --current' };
      }
      return callTool(sessionId, 'chrome_close_windows', args);
    }
    case 'state': {
      const id = Number(rest[1]);
      const state = rest[2];
      if (isNaN(id) || !state) return { ok: false, text: 'usage: window state <windowId> <normal|minimized|maximized|fullscreen>' };
      return callTool(sessionId, 'chrome_manage_window', { windowId: id, state });
    }
    case 'resize': {
      const id = Number(rest[1]);
      if (isNaN(id) || !flags.w || !flags.h) return { ok: false, text: 'usage: window resize <windowId> --w <width> --h <height>' };
      return callTool(sessionId, 'chrome_manage_window', { windowId: id, width: Number(flags.w), height: Number(flags.h) });
    }
    case 'focus': {
      const id = Number(rest[1]);
      if (isNaN(id)) return { ok: false, text: 'usage: window focus <windowId>' };
      return callTool(sessionId, 'chrome_manage_window', { windowId: id, focused: true });
    }
    case 'arrange': {
      const args = {};
      if (flags.layout) args.layout = flags.layout;
      if (flags.window) args.windowIds = idsFrom([flags.window]);
      return callTool(sessionId, 'chrome_arrange_windows', args);
    }
    case 'list': {
      return callTool(sessionId, 'get_windows_and_tabs', {});
    }
    default:
      return { ok: false, text: 'window subcommands: new <url…>, close <ids…|--all|--current>, state <id> <state>, resize <id> --w --h, focus <id>, arrange [--layout grid|vertical|horizontal|cascade] [--window ids], list' };
  }
}

async function cmdZoom(sessionId, flags, arg) {
  const args = Object.assign({}, tabArg(flags));
  if (!arg) return callTool(sessionId, 'chrome_zoom', args);
  if (arg === 'in') args.zoomIn = true;
  else if (arg === 'out') args.zoomOut = true;
  else if (arg === 'reset') args.reset = true;
  else {
    const f = Number(arg);
    if (isNaN(f)) return { ok: false, text: 'usage: zoom [<factor>|in|out|reset] [--tab <id>]' };
    args.factor = f;
  }
  return callTool(sessionId, 'chrome_zoom', args);
}

async function cmdCookies(sessionId, flags, rest) {
  const sub = rest[0] || 'list';
  const url = rest[1];
  const name = rest[2];
  const value = rest.slice(3).join(' ');
  const args = {};
  switch (sub) {
    case 'list':
      if (!url) return { ok: false, text: 'usage: cookies list <url> [--domain D]' };
      args.action = 'getAll';
      args.url = url;
      if (flags.domain) args.domain = flags.domain;
      break;
    case 'get':
      if (!url || !name) return { ok: false, text: 'usage: cookies get <url> <name>' };
      args.action = 'get';
      args.url = url;
      args.name = name;
      break;
    case 'set':
      if (!url || !name || !value) return { ok: false, text: 'usage: cookies set <url> <name> <value> [--secure] [--httpOnly]' };
      args.action = 'set';
      args.url = url;
      args.name = name;
      args.value = value;
      if (flags.secure) args.secure = true;
      if (flags.httpOnly) args.httpOnly = true;
      if (flags.path) args.path = flags.path;
      if (flags.domain) args.domain = flags.domain;
      break;
    case 'delete':
      if (!url || !name) return { ok: false, text: 'usage: cookies delete <url> <name>' };
      args.action = 'delete';
      args.url = url;
      args.name = name;
      break;
    case 'clear':
      if (!url) return { ok: false, text: 'usage: cookies clear <url>' };
      args.action = 'deleteAll';
      args.url = url;
      break;
    default:
      return { ok: false, text: 'cookies subcommands: list <url>, get <url> <name>, set <url> <name> <value>, delete <url> <name>, clear <url>' };
  }
  return callTool(sessionId, 'chrome_cookies', args);
}

async function cmdDownloads(sessionId, flags, rest) {
  const sub = rest[0] || 'list';
  const ids = idsFrom(rest.slice(1));
  const args = { action: sub };
  if (ids.length) args.ids = ids;
  if (sub === 'list') {
    if (flags.query) args.query = flags.query;
    if (flags.limit) args.limit = Number(flags.limit);
  }
  return callTool(sessionId, 'chrome_downloads', args);
}

async function cmdTrace(sessionId, flags, rest) {
  const sub = rest[0] || 'stop';
  switch (sub) {
    case 'start': {
      const args = Object.assign({}, tabArg(flags));
      if (flags.reload) args.reload = true;
      if (flags.auto) args.autoStop = true;
      if (flags.duration) args.durationMs = Number(flags.duration);
      if (flags.name) args.name = flags.name;
      return callTool(sessionId, 'performance_start_trace', args);
    }
    case 'stop': {
      const args = {};
      if (flags.noSave) args.saveToDownloads = false;
      if (flags.name) args.filenamePrefix = flags.name;
      const r = await callTool(sessionId, 'performance_stop_trace', args);
      // Strip giant base64 from the human-readable output.
      if (!flags.json && r.ok) {
        try {
          const parsed = JSON.parse(r.text);
          delete parsed.base64;
          r.text = JSON.stringify(parsed, null, 2);
        } catch (e) { /* leave as-is */ }
      }
      return r;
    }
    case 'analyze':
      return callTool(sessionId, 'performance_analyze_insight', {});
    default:
      return { ok: false, text: 'trace subcommands: start [--reload] [--auto] [--duration MS] [--name X], stop [--no-save] [--name PREFIX], analyze' };
  }
}

async function cmdGif(sessionId, flags, rest) {
  const sub = rest[0] || 'status';
  const args = { action: sub };
  if (sub === 'start' || sub === 'auto_start') {
    if (flags.fps) args.fps = Number(flags.fps);
    Object.assign(args, tabArg(flags));
  }
  if (sub === 'stop') {
    if (flags.noSave) args.save = false;
    if (flags.base64 || flags.out) args.includeBase64 = true;
    const r = await callTool(sessionId, 'chrome_gif_recorder', args);
    if (!flags.json && r.ok) {
      try {
        const parsed = JSON.parse(r.text);
        if (flags.out && parsed.base64) {
          fs.writeFileSync(flags.out, Buffer.from(parsed.base64, 'base64'));
          return { ok: true, saved: flags.out, frames: parsed.frames, size: parsed.size, bytes: Buffer.byteLength(parsed.base64, 'base64') };
        }
        delete parsed.base64;
        delete parsed.markdown;
        r.text = JSON.stringify(parsed, null, 2);
      } catch (e) { /* leave as-is */ }
    }
    return r;
  }
  return callTool(sessionId, 'chrome_gif_recorder', args);
}

async function cmdRead(sessionId, flags) {
  const args = Object.assign({}, tabArg(flags));
  if (flags.interactive) args.filter = 'interactive';
  if (flags.depth !== undefined) args.depth = Number(flags.depth);
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
  const args = Object.assign({}, tabArg(flags));
  if (target === 'reload') return callTool(sessionId, 'chrome_navigate', Object.assign({ refresh: true, background: true }, args));
  if (flags.newTab) {
    args.url = target;
    args.newTab = true;
    return callTool(sessionId, 'chrome_navigate', args);
  }
  return callTool(sessionId, 'chrome_navigate', Object.assign({ url: target }, args));
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
        const words = rest.split(/\s+/);
        let out;
        if (cmd === 'tabs') out = await cmdTabs(sessionId, flags);
        else if (cmd === 'active') out = await cmdActive(sessionId, flags);
        else if (cmd === 'read') { const f = { ...flags, interactive: /--interactive/.test(rest) }; out = await cmdRead(sessionId, f); }
        else if (cmd === 'eval') out = await cmdEval(sessionId, flags, rest);
        else if (cmd === 'run') out = await cmdRun(sessionId, flags, rest);
        else if (cmd === 'click') out = await cmdClick(sessionId, flags, words[0]);
        else if (cmd === 'fill') { const m = rest.match(/^(\S+)\s+([\s\S]+)$/); out = m ? await cmdFill(sessionId, flags, m[1], m[2]) : { ok: false, text: 'usage: fill <sel|ref> <value>' }; }
        else if (cmd === 'keys') out = await cmdKeys(sessionId, flags, rest);
        else if (cmd === 'nav') out = await cmdNav(sessionId, flags, words[0] || 'reload');
        else if (cmd === 'shot') out = await cmdShot(sessionId, flags);
        else if (cmd === 'storage') out = await cmdStorage(sessionId, flags);
        else if (cmd === 'status') out = await cmdStatus(sessionId, flags);
        else if (cmd === 'open') out = await cmdOpen(sessionId, flags, words);
        else if (cmd === 'close') out = await cmdClose(sessionId, flags, words);
        else if (cmd === 'dup') out = await cmdDup(sessionId, flags, idsFrom(words));
        else if (cmd === 'reload') out = await cmdReload(sessionId, flags, idsFrom(words));
        else if (cmd === 'discard') out = await cmdDiscard(sessionId, flags, idsFrom(words));
        else if (cmd === 'pin') out = await cmdPinUnpin(sessionId, flags, idsFrom(words), 'pin');
        else if (cmd === 'unpin') out = await cmdPinUnpin(sessionId, flags, idsFrom(words), 'unpin');
        else if (cmd === 'mute') out = await cmdMuteUnmute(sessionId, flags, idsFrom(words), 'mute');
        else if (cmd === 'unmute') out = await cmdMuteUnmute(sessionId, flags, idsFrom(words), 'unmute');
        else if (cmd === 'move') out = await cmdMove(sessionId, flags, idsFrom(words));
        else if (cmd === 'group') out = await cmdGroup(sessionId, flags, idsFrom(words));
        else if (cmd === 'ungroup') out = await cmdUngroup(sessionId, flags, idsFrom(words));
        else if (cmd === 'groups') out = await cmdGroups(sessionId, flags);
        else if (cmd === 'search') out = await cmdSearch(sessionId, flags, rest);
        else if (cmd === 'content-search') out = await cmdContentSearch(sessionId, flags, rest);
        else if (cmd === 'window') out = await cmdWindow(sessionId, flags, words);
        else if (cmd === 'zoom') out = await cmdZoom(sessionId, flags, words[0]);
        else if (cmd === 'cookies') out = await cmdCookies(sessionId, flags, words);
        else if (cmd === 'downloads') out = await cmdDownloads(sessionId, flags, words);
        else if (cmd === 'trace') out = await cmdTrace(sessionId, flags, words);
        else if (cmd === 'gif') out = await cmdGif(sessionId, flags, words);
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

Tabs & windows:
  open <url> [url2 …]    Open new tab(s): --bg --pin --window <id> --index N
  close <targets>        ids | url:<u> | domain:<d> | all | others [--keep ids] | window <ids>
  dup <ids>              Duplicate tab(s)
  reload [ids|--all] [--cache]
  discard [ids|--all]    Suspend tabs to free memory
  pin|unpin <ids>        Pin/unpin tab(s)
  mute|unmute <ids>      Mute/unmute tab(s)
  move <ids>             --window <id> --index N
  group <ids>            --name X --color C   | ungroup <ids> | groups
  search <query>         Find tabs by title/URL/host
  content-search <query> Search text inside open tabs
  window                 new|close|state|resize|focus|arrange|list (see "mcp window help")
  zoom [f|in|out|reset]  Tab zoom factor (0.25–5)
  switch <tabId>         Switch to tab
  tabs | active          List windows/tabs / active tab

Cookies & downloads:
  cookies                list <url> | get <url> <name> | set <url> <name> <value> | delete <url> <name> | clear <url>
  downloads              list [--query Q] | cancel|pause|resume|erase <ids> | open|show <id>

Recording & tracing:
  trace                  start [--reload] [--auto] [--duration MS] | stop [--no-save] | analyze
  gif                    start [--fps N] [--auto] | stop [--base64] [--out file.gif] | status | capture | export

Page interaction:
  read [--interactive] [--depth N] [--ref ref_X]
  eval '<js>' | run '<js>'
  click <sel|ref> | fill <sel|ref> <value> | keys '<keys>'
  nav <url|back|forward|reload> [--new-tab]
  shot [--full] [--out file.png]
  storage                Dump browser storage

Misc:
  status | restart | tools | call <tool> '{"args":…}' | repl | help`;

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
      case 'open': out = await cmdOpen(sessionId, flags, rest); break;
      case 'close': out = await cmdClose(sessionId, flags, rest); break;
      case 'dup': out = await cmdDup(sessionId, flags, idsFrom(rest)); break;
      case 'reload': out = await cmdReload(sessionId, flags, idsFrom(rest)); break;
      case 'discard': out = await cmdDiscard(sessionId, flags, idsFrom(rest)); break;
      case 'pin': out = await cmdPinUnpin(sessionId, flags, idsFrom(rest), 'pin'); break;
      case 'unpin': out = await cmdPinUnpin(sessionId, flags, idsFrom(rest), 'unpin'); break;
      case 'mute': out = await cmdMuteUnmute(sessionId, flags, idsFrom(rest), 'mute'); break;
      case 'unmute': out = await cmdMuteUnmute(sessionId, flags, idsFrom(rest), 'unmute'); break;
      case 'move': out = await cmdMove(sessionId, flags, idsFrom(rest)); break;
      case 'group': out = await cmdGroup(sessionId, flags, idsFrom(rest)); break;
      case 'ungroup': out = await cmdUngroup(sessionId, flags, idsFrom(rest)); break;
      case 'groups': out = await cmdGroups(sessionId, flags); break;
      case 'search': out = await cmdSearch(sessionId, flags, rest.join(' ')); break;
      case 'content-search': out = await cmdContentSearch(sessionId, flags, rest.join(' ')); break;
      case 'window': out = await cmdWindow(sessionId, flags, rest); break;
      case 'zoom': out = await cmdZoom(sessionId, flags, rest[0]); break;
      case 'cookies': out = await cmdCookies(sessionId, flags, rest); break;
      case 'downloads': out = await cmdDownloads(sessionId, flags, rest); break;
      case 'trace': out = await cmdTrace(sessionId, flags, rest); break;
      case 'gif': out = await cmdGif(sessionId, flags, rest); break;
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
