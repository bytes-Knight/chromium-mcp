#!/usr/bin/env node
// mcpctl.js — standalone CLI for the Chrome MCP bridge (127.0.0.1:12306).
// Zero dependencies (node built-ins only) so it compiles cleanly to a single
// .exe via Node SEA. Drop-in superset of the legacy scripts/mcp.js.
'use strict';

const net = require('net');
const fs = require('fs');
const { execSync } = require('child_process');
const readline = require('readline');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 12306;
const FUSE_OK = 'Already connected'; // substring matched on stale-session errors

let rpcCounter = 0;
let cfg = { host: DEFAULT_HOST, port: DEFAULT_PORT, json: false, tab: null, timeout: 120000 };

const mcpUrl = () => `http://${cfg.host}:${cfg.port}/mcp`;

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

async function mcpRpc(method, params, sessionId, timeoutMs) {
  rpcCounter++;
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcCounter, method, params });
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || cfg.timeout);
  let res;
  try {
    res = await fetch(mcpUrl(), { method: 'POST', headers, body, signal: ctl.signal });
  } catch (e) {
    throw new Error(`bridge unreachable at ${mcpUrl()} (${e.message}). Start Chrome with the extension connected, or run "mcpctl restart".`);
  } finally {
    clearTimeout(timer);
  }
  const sid = res.headers.get('mcp-session-id');
  const text = await res.text();
  return { status: res.status, sessionId: sid, parsed: parseResponse(text), raw: text };
}

async function initSession() {
  const init = await mcpRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcpctl', version: '2.0.0' },
  }, null, 15000);
  if (init.status !== 200 || !init.sessionId) {
    const p = init.parsed;
    const msg = (p && (p.message || (p.error && p.error.message))) || `HTTP ${init.status}${init.raw ? ': ' + init.raw.slice(0, 200) : ''}`;
    throw new Error(String(msg));
  }
  await mcpRpc('notifications/initialized', {}, init.sessionId).catch(() => {});
  return init.sessionId;
}

async function closeSession(sessionId) {
  try { await fetch(mcpUrl(), { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } }); } catch (e) { /* ignore */ }
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
  if (pid) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /F /PID ${pid}`, { windowsHide: true });
      else execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
    } catch (e) { /* already dead */ }
  }
  // Wait for the port to actually close, then for the extension to respawn the
  // host fresh, then a short boot grace so the MCP server is ready.
  await waitPortClosed(cfg.host, cfg.port, 15000);
  const ok = await waitPortOpen(cfg.host, cfg.port, 45000);
  if (ok) await sleep(1200);
  return ok;
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

let activeSession = null;
process.on('SIGINT', () => {
  if (activeSession) closeSession(activeSession).then(() => process.exit(130));
  else process.exit(130);
});
process.on('SIGTERM', () => {
  if (activeSession) closeSession(activeSession).then(() => process.exit(143));
  else process.exit(143);
});

// The bridge's McpServer is a singleton — a stale session makes every new
// initialize fail with "Already connected to a transport". Recover by killing
// the host (the extension respawns it fresh) and retrying. The same recovery
// applies when the host dies mid-call (transport errors like "terminated" —
// the service worker can be idle-killed by the browser, dropping the native
// port and taking the in-flight HTTP stream down with it).
const TRANSPORT_ERROR_RE = /terminated|fetch failed|ECONNRESET|socket hang up|UND_ERR|other side closed/i;
async function withSession(fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let sessionId = null;
    try {
      sessionId = await initSession();
      activeSession = sessionId;
      return await fn(sessionId);
    } catch (e) {
      const msg = String((e && e.message) || e);
      const recoverable = msg.includes(FUSE_OK) || TRANSPORT_ERROR_RE.test(msg);
      if (recoverable && attempt < 3) {
        process.stderr.write(`[mcpctl] bridge disrupted (${msg.slice(0, 60)}) - restarting host...\n`);
        const ok = await restartHost();
        if (!ok) throw new Error('host did not respawn; click Connect in the extension popup or reload the extension');
        continue;
      }
      throw e;
    } finally {
      if (sessionId) await closeSession(sessionId);
      activeSession = null;
    }
  }
}

// ---------------------------------------------------------------- tool call ---
function tryParseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function callTool(sessionId, tool, args, timeoutMs) {
  const call = await mcpRpc('tools/call', { name: tool, arguments: args || {} }, sessionId, timeoutMs);
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

const GLOBAL_FLAGS = ['json', 'tab', 'timeout', 'port', 'host'];

function applyGlobalFlags(flags) {
  if (flags.json) cfg.json = true;
  if (flags.tab != null) cfg.tab = parseInt(flags.tab, 10);
  if (flags.timeout != null) cfg.timeout = parseInt(flags.timeout, 10) * 1000;
  if (flags.port != null) cfg.port = parseInt(flags.port, 10);
  if (flags.host) cfg.host = flags.host;
}

class UsageError extends Error {}

// ------------------------------------------------------------- sub-commands ---
async function cmdStatus(sessionId, flags) {
  const pid = hostPid();
  const open = await portOpen(cfg.port, cfg.host, 800);
  return { ok: open, host: cfg.host, port: cfg.port, hostPid: pid, mcpUrl: mcpUrl(), note: open ? 'bridge healthy' : 'bridge DOWN' };
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
  'json', 'tab', 'timeout', 'port', 'host',
  'interactive', 'depth', 'ref', 'full', 'selector', 'out',
  'html', 'text', 'double', 'button', 'value', 'delay',
  'query', 'max', 'ago', 'exclude-open', 'filter', 'bodies', 'static',
  'errors', 'clear', 'buffer', 'pattern', 'limit', 'main',
  'file', 'folder', 'url', 'duration', 'direction', 'amount', 'width', 'height',
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
      case 'ping': { o = { ok: true, latency: 'roundtrip ok', mcpUrl: mcpUrl() }; break; }
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
      case 'repl': await repl(sessionId); o = null; break;
      case 'help': case '-h': case '--help': process.stdout.write(USAGE + '\n'); o = null; break;
      default: throw new UsageError(`unknown command: ${cmd} (try: help)`);
    }
    if (o) {
      if (!cfg.json) {
        if (cmd === 'tabs' || cmd === 'windows') o = fmtTabs(o.parsed);
        else if (cmd === 'read') o = fmtRead(o.parsed);
        else if (cmd === 'console') o = fmtConsole(o.parsed);
        else if (cmd === 'bookmarks') o = fmtBookmarks(o.parsed);
        else if (cmd === 'history') o = fmtHistory(o.parsed);
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

// ------------------------------------------------------------------- main ---
const USAGE = `mcpctl - standalone CLI for the Chrome MCP bridge

Usage: mcpctl <command> [args] [--json] [--tab <id>] [--port <n>] [--timeout <sec>]

Commands:
  status                  Bridge health + host PID
  ping                    Verify an MCP session can be opened
  restart                 Kill stuck host, wait for extension to respawn it
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

Environment: MCP_PORT, MCP_HOST (defaults 12306 / 127.0.0.1)`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(USAGE + '\n');
    return;
  }

  if (process.env.MCP_PORT) cfg.port = parseInt(process.env.MCP_PORT, 10);
  if (process.env.MCP_HOST) cfg.host = process.env.MCP_HOST;

  const command = argv[0];
  const rest = argv.slice(1);
  let flags;
  try {
    flags = parseFlags(rest, FLAG_WHITELIST);
  } catch (e) {
    process.stderr.write('[mcpctl] ' + e.message + '\n');
    process.exit(2);
  }

  if (command === 'restart') {
    const ok = await restartHost();
    out({ ok, hostPid: hostPid() });
    process.exit(ok ? 0 : 1);
  }
  if (command === 'status') {
    applyGlobalFlags(flags);
    const o = await cmdStatus(null, flags);
    out(o);
    process.exit(o.ok ? 0 : 1);
  }

  applyGlobalFlags(flags);

  await withSession(async (sessionId) => {
    await runCommand(sessionId, command, flags, null);
  }).catch((e) => {
    process.stderr.write('[mcpctl] FATAL: ' + ((e && e.message) || e) + '\n');
    process.exit(1);
  });
}

main();
