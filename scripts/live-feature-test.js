#!/usr/bin/env node
// scripts/live-feature-test.js
// Live end-to-end test of the clean-room extension through the real MCP
// endpoint (http://127.0.0.1:12306/mcp). Verifies five feature areas:
//   1. console command running (chrome_javascript + chrome_console capture)
//   2. page source checking     (chrome_get_web_content with htmlContent)
//   3. http request monitoring  (chrome_network_capture start/stop)
//   4. form filling             (chrome_fill_or_select)
//   5. clicking objects         (chrome_click_element)
//
// Serves its own local test page so behavior is deterministic and no external
// network is needed. Restores the original tab URL when done.
'use strict';
const http = require('http');
const { execSync, spawnSync } = require('child_process');

const MCP_URL = 'http://127.0.0.1:12306/mcp';
const MCP_PORT = 12306;
const PAGE_PORT = 8899;
const TEST_URL = `http://127.0.0.1:${PAGE_PORT}/test`;

// ---- Host restart helper -----------------------------------------------------
// The mcp-chrome-bridge host's MCP server is a singleton: once a client
// initializes a session and doesn't close it, every later initialize fails with
// "Already connected to a transport". Restarting the host (the Brave/Chrome
// extension auto-respawns it) clears the stuck state.
function listeningPid(port) {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  const line = (out.stdout || '').split(/\r?\n/).find((l) => l.includes(`127.0.0.1:${port}`) && l.includes('LISTENING'));
  if (!line) return null;
  const pid = line.trim().split(/\s+/).pop();
  return pid && /^\d+$/.test(pid) ? pid : null;
}

function killPid(pid) {
  try { execSync(`taskkill //F //PID ${pid}`, { stdio: 'pipe' }); return true; } catch (e) { return false; }
}

async function restartHost() {
  const pid = listeningPid(MCP_PORT);
  if (pid) {
    console.log(`[host] restarting stuck native host (PID ${pid})…`);
    killPid(pid);
  }
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (listeningPid(MCP_PORT)) {
      // Port listening ≠ Fastify booted; let the host finish initializing.
      await sleep(1500);
      return true;
    }
  }
  return false;
}

async function initSessionWithRetry() {
  try {
    return await initSession();
  } catch (e) {
    if (/Already connected|Internal Server Error/i.test(String(e.message))) {
      console.log('[host] session blocked (stale singleton) — restarting host…');
      await restartHost();
      return await initSession();
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Local test page server
// ---------------------------------------------------------------------------
const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8">
<title>MCP Feature Test Page</title></head>
<body data-test-marker="mcp-test-page">
  <h1 id="page-heading">MCP Feature Test Page</h1>
  <form id="demo-form" action="/submit" method="post">
    <label for="name">Name</label>
    <input id="name" name="name" type="text" placeholder="Enter name" value="">
    <span id="echo"></span>
    <label for="color">Color</label>
    <select id="color" name="color">
      <option value="red">Red</option>
      <option value="green">Green</option>
      <option value="blue">Blue</option>
    </select>
    <label for="bio">Bio</label>
    <textarea id="bio" name="bio" rows="2"></textarea>
    <button id="btn" type="button">Click me</button>
  </form>
  <div id="counter">0</div>
  <div id="fetch-result">none</div>
  <script>
    console.log('TESTPAGE loaded', location.href);
    console.warn('TESTPAGE warn line');
    console.error('TESTPAGE error line');
    let clicks = 0;
    const nameInput = document.getElementById('name');
    nameInput.addEventListener('input', function () {
      document.getElementById('echo').textContent = 'echo:' + this.value;
    });
    document.getElementById('btn').addEventListener('click', function () {
      clicks++;
      document.getElementById('counter').textContent = String(clicks);
      console.log('TESTPAGE clicked ' + clicks);
      fetch('/api/click').catch(function () {});
    });
    setTimeout(function () {
      fetch('/api/ping').then(function (r) { return r.text(); })
        .then(function (t) { document.getElementById('fetch-result').textContent = t; })
        .catch(function () {});
    }, 100);
  </script>
</body>
</html>`;

function startPageServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || '/';
      if (url === '/test' || url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
      } else if (url === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('pong');
      } else if (url === '/api/click') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('clicked');
      } else if (url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: [1, 2, 3] }));
      } else if (url === '/submit') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('submitted:' + body);
        });
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    });
    server.listen(PAGE_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Minimal MCP streamable-HTTP client
// ---------------------------------------------------------------------------
let rpcCounter = 0;
async function mcpRpc(method, params, sessionId) {
  rpcCounter++;
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcCounter, method, params });
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(MCP_URL, { method: 'POST', headers, body });
  let sid = res.headers.get('mcp-session-id');
  const text = await res.text();
  const jsonLines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  let parsed = null;
  for (const jl of jsonLines) {
    try { parsed = JSON.parse(jl); } catch (e) { /* skip */ }
  }
  if (!parsed) { try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text.slice(0, 300) }; } }
  return { status: res.status, sessionId: sid, parsed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MCP streamable-HTTP sessions are terminated with DELETE + Mcp-Session-Id.
// The host's MCP server is a singleton (one Server instance), so closing the
// session is required to let a later client connect again.
async function closeSession(sessionId) {
  try {
    await fetch(MCP_URL, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId },
    });
  } catch (e) { /* ignore */ }
}

async function initSession() {
  const init = await mcpRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'live-feature-test', version: '1.0.0' },
  }, null);
  if (init.status !== 200 || !init.sessionId) throw new Error('initialize failed: ' + JSON.stringify(init.parsed).slice(0, 300));
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': init.sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  }).catch(() => {});
  return init.sessionId;
}

async function callTool(sessionId, name, args) {
  const call = await mcpRpc('tools/call', { name, arguments: args || {} }, sessionId);
  const result = call.parsed && call.parsed.result;
  if (!result) {
    const err = call.parsed && call.parsed.error;
    return { ok: false, error: (err && err.message) || 'no result', raw: call.parsed };
  }
  const text = result.content && result.content[0] && result.content[0].text || '';
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { ok: !result.isError, error: result.isError ? text : null, data };
}

// ---------------------------------------------------------------------------
// Test bookkeeping
// ---------------------------------------------------------------------------
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`\n${mark} — ${name}`);
  if (detail) console.log('       ' + String(detail).slice(0, 400).replace(/\n/g, '\n       '));
}

async function main() {
  const server = await startPageServer();
  console.log(`[setup] test page serving at ${TEST_URL}`);
  console.log('[setup] initializing MCP session…');
  const sid = await initSessionWithRetry();
  console.log('[setup] session ok');

  const tools = await mcpRpc('tools/list', {}, sid);
  const names = (tools.parsed && tools.parsed.result && tools.parsed.result.tools || []).map((t) => t.name);
  console.log(`[setup] ${names.length} tools available`);
  const need = ['chrome_javascript', 'chrome_console', 'chrome_get_web_content', 'chrome_network_capture', 'chrome_fill_or_select', 'chrome_click_element', 'chrome_navigate'];
  const missing = need.filter((n) => !names.includes(n));
  if (missing.length) {
    console.log('[setup] missing tools: ' + missing.join(', '));
  }

  // Save original URL so we can restore the user's tab at the end.
  const wt = await callTool(sid, 'get_windows_and_tabs', {});
  let originalUrl = null;
  let tabId = null;
  if (wt.ok && Array.isArray(wt.data) && wt.data[0] && wt.data[0].tabs && wt.data[0].tabs[0]) {
    const tab = wt.data[0].tabs[0];
    originalUrl = tab.url;
    tabId = tab.id;
    console.log(`[setup] using tab ${tabId} (original: ${originalUrl})`);
  }

  // ---- Navigate to the test page -------------------------------------------
  const nav = await callTool(sid, 'chrome_navigate', { url: TEST_URL });
  if (nav.ok) tabId = nav.data.tabId || tabId;
  await sleep(1200);

  // ---- 1. Page source checking ---------------------------------------------
  let pageSourceOk = false;
  {
    const r = await callTool(sid, 'chrome_get_web_content', { tabId, htmlContent: true });
    if (r.ok && r.data && r.data.meta && r.data.html) {
      const hasMarker = r.data.html.includes('data-test-marker="mcp-test-page"') && r.data.html.includes('id="page-heading"');
      const hasTitle = r.data.meta.title === 'MCP Feature Test Page';
      pageSourceOk = hasMarker && hasTitle;
      record('page source checking (chrome_get_web_content htmlContent)',
        pageSourceOk,
        `title="${r.data.meta.title}" marker=${hasMarker} htmlLen=${r.data.html.length}`);
    } else {
      record('page source checking (chrome_get_web_content htmlContent)', false, r.error || 'no html returned');
    }
  }

  // ---- 2. Console command running (chrome_javascript) ----------------------
  let jsRunOk = false;
  {
    const code = `document.title = 'JS-RAN-THROUGH-MCP'; return { sum: 21 + 21, tag: document.querySelector('h1').innerText };`;
    const r = await callTool(sid, 'chrome_javascript', { tabId, code });
    if (r.ok) {
      try {
        const v = JSON.parse(r.data && r.data.result || '{}');
        jsRunOk = v.sum === 42 && v.tag === 'MCP Feature Test Page';
        record('console command running (chrome_javascript)', jsRunOk, `result=${r.data.result}`);
      } catch (e) {
        record('console command running (chrome_javascript)', false, 'unparseable result: ' + String(r.data));
      }
    } else {
      record('console command running (chrome_javascript)', false, r.error);
    }
  }

  // ---- 3. Console capture (chrome_console) ---------------------------------
  let consoleCapOk = false;
  {
    // Read the buffered stream first; fall back to a CDP snapshot window if the
    // buffer is empty (content script may not be active in the loaded extension).
    const r = await callTool(sid, 'chrome_console', { tabId, mode: 'buffer' });
    let data = r.ok && Array.isArray(r.data.messages) ? r.data : null;
    if (!data || !data.messages.length) {
      const snap = await callTool(sid, 'chrome_console', { tabId, mode: 'snapshot', snapshotMs: 1500 });
      if (snap.ok && Array.isArray(snap.data.messages) && snap.data.messages.length) data = snap.data;
    }
    if (data && Array.isArray(data.messages)) {
      const texts = data.messages.map((m) => m.text).join('\n');
      const found = texts.includes('TESTPAGE loaded') && texts.includes('TESTPAGE warn line') && texts.includes('TESTPAGE error line');
      const levels = data.messages.map((m) => m.level);
      consoleCapOk = found && levels.includes('log') && levels.includes('warn') && levels.includes('error');
      record('console capture (chrome_console buffer/snapshot)', consoleCapOk,
        `${data.total} messages; levels=[${[...new Set(levels)].join(',')}]`);
    } else {
      record('console capture (chrome_console buffer/snapshot)', false, (r.error || 'no messages'));
    }
  }

  // ---- 4. HTTP request monitoring (chrome_network_capture) -----------------
  let netOk = false;
  {
    const start = await callTool(sid, 'chrome_network_capture', { tabId, action: 'start' });
    if (start.ok) {
      const trigger = await callTool(sid, 'chrome_javascript', {
        tabId,
        code: `return fetch('/api/data').then(r => r.json());`,
      });
      await sleep(1200);
      const stop = await callTool(sid, 'chrome_network_capture', { tabId, action: 'stop' });
      if (stop.ok && Array.isArray(stop.data.entries)) {
        const urls = stop.data.entries.map((e) => e.url);
        const dataHit = urls.some((u) => u.includes('/api/data'));
        const pingHit = urls.some((u) => u.includes('/api/ping'));
        const statusOk = stop.data.entries.filter((e) => e.url.includes('/api/data')).every((e) => e.status === 200);
        netOk = dataHit && statusOk;
        record('http request monitoring (chrome_network_capture)', netOk,
          `${stop.data.count} entries; data=${dataHit}(status200=${statusOk}) ping=${pingHit}; methods=${JSON.stringify([...new Set(stop.data.entries.map((e) => e.method))])}`);
      } else {
        record('http request monitoring (chrome_network_capture)', false, (stop.error || 'no entries') + ' trigger=' + JSON.stringify(trigger.data && trigger.data.result));
      }
    } else {
      record('http request monitoring (chrome_network_capture)', false, start.error);
    }
  }

  // ---- 5. Form filling (chrome_fill_or_select) -----------------------------
  let fillOk = false;
  {
    const fill = await callTool(sid, 'chrome_fill_or_select', { tabId, selector: '#name', value: 'Alice' });
    const verify = await callTool(sid, 'chrome_javascript', {
      tabId,
      code: `return { value: document.querySelector('#name').value, echo: document.querySelector('#echo').textContent };`,
    });
    if (fill.ok && verify.ok) {
      let v = null;
      try { v = JSON.parse(verify.data && verify.data.result || '{}'); } catch (e) { /* ignore */ }
      fillOk = v && v.value === 'Alice' && v.echo === 'echo:Alice';
      record('form filling (chrome_fill_or_select)', fillOk,
        `fill=${JSON.stringify(fill.data)} pageState=${JSON.stringify(v)}`);
    } else {
      record('form filling (chrome_fill_or_select)', false, (fill.error || '') + (verify.error || ''));
    }
  }

  // ---- 6. Clicking objects (chrome_click_element) --------------------------
  let clickOk = false;
  {
    const click = await callTool(sid, 'chrome_click_element', { tabId, selector: '#btn' });
    await sleep(400);
    const verify = await callTool(sid, 'chrome_javascript', {
      tabId,
      code: `return { counter: document.querySelector('#counter').textContent };`,
    });
    if (click.ok && verify.ok) {
      let v = null;
      try { v = JSON.parse(verify.data && verify.data.result || '{}'); } catch (e) { /* ignore */ }
      clickOk = v && v.counter === '1';
      record('clicking objects (chrome_click_element)', clickOk,
        `click=${JSON.stringify(click.data)} counter=${v && v.counter}`);
    } else {
      record('clicking objects (chrome_click_element)', false, (click.error || '') + (verify.error || ''));
    }
  }

  // ---- Restore the original tab --------------------------------------------
  if (originalUrl) {
    const back = await callTool(sid, 'chrome_navigate', { tabId, url: originalUrl });
    console.log(`\n[cleanup] restored tab to ${originalUrl} (ok=${back.ok})`);
  }
  server.close();
  await closeSession(sid);
  console.log('[cleanup] MCP session closed');

  // ---- Summary -------------------------------------------------------------
  console.log('\n==================== SUMMARY ====================');
  let pass = 0;
  for (const r of results) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
    if (r.pass) pass++;
  }
  console.log(`  ${pass}/${results.length} features passed`);
  console.log('==================================================');
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { console.error('TEST ERROR:', e.message); process.exit(1); });
