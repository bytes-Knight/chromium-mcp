#!/usr/bin/env node
// scripts/host-roundtrip-test.js
// Full-chain smoke test for the mcp-chrome-bridge host + MCP server.
//
// Two modes:
//  A) LIVE MODE (default when 127.0.0.1:12306 already answers): the real
//     extension + host are up — we initialize a fresh MCP session, list tools,
//     and call get_windows_and_tabs through the live endpoint, checking real
//     browser data comes back. This is the strongest proof the whole chain works.
//  B) SIMULATED MODE (when nothing is listening): spawn the host binary
//     ourselves, speak the native-messaging protocol as a fake extension, and
//     verify the tool call round-trips.
//
// Usage: node scripts/host-roundtrip-test.js
'use strict';
const { spawn } = require('child_process');
const net = require('net');

const HOST_JS = 'C:/Users/mdlim/AppData/Roaming/npm/node_modules/mcp-chrome-bridge/dist/index.js';
const PORT = 12306;
const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;

// ---- Native messaging framing (4-byte LE length prefix) ---------------------
function frame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

// ---- Minimal MCP streamable-HTTP client (fresh session per mcpRpc call) -----
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

async function initSession() {
  const init = await mcpRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'roundtrip-test', version: '1.0.0' },
  }, null);
  if (init.status !== 200 || !init.sessionId) return { ok: false, init };
  await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': init.sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  }).catch(() => {});
  return { ok: true, sessionId: init.sessionId, init };
}

async function liveMode() {
  console.log(`[live] endpoint ${MCP_URL} is answering — validating the real extension chain …`);
  const s = await initSession();
  if (!s.ok) {
    console.log('[live] initialize failed:', JSON.stringify(s.init.parsed).slice(0, 300));
    return false;
  }
  const tools = await mcpRpc('tools/list', {}, s.sessionId);
  const names = (tools.parsed && tools.parsed.result && tools.parsed.result.tools || []).map((t) => t.name);
  console.log(`[live] tools/list → ${names.length} tools (${names.slice(0, 8).join(', ')}…)`);

  const call = await mcpRpc('tools/call', { name: 'get_windows_and_tabs', arguments: {} }, s.sessionId);
  const result = call.parsed && call.parsed.result;
  const text = result && result.content && result.content[0] && result.content[0].text || '';
  console.log(`[live] get_windows_and_tabs → ${text.length} chars`);
  const realData = text.includes('"id"') && text.includes('tabs');
  if (realData) {
    // show the first tab summary for proof
    try {
      const arr = JSON.parse(text);
      const first = arr[0];
      console.log(`[live] window ${first.id}: ${(first.tabs || []).length} tabs; first tab: ${first.tabs && first.tabs[0] && first.tabs[0].url}`);
    } catch (e) { /* ignore */ }
  }
  console.log(realData
    ? '✅ LIVE PASS — real browser data is flowing through the MCP endpoint.'
    : '❌ LIVE FAIL — endpoint responded but returned no browser data.');
  return realData;
}

async function simulatedMode() {
  console.log(`[sim] no live server — spawning host and simulating the extension …`);
  const child = spawn('node', [HOST_JS], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = Buffer.alloc(0);
  let pendingTool = null;

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break;
      const raw = buffer.slice(4, 4 + len).toString('utf8');
      buffer = buffer.slice(4 + len);
      try {
        const msg = JSON.parse(raw);
        handleHostMessage(msg);
      } catch (e) { /* bad frame */ }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write('  [host stderr] ' + d));
  child.on('exit', (code) => {
    console.log(`[host] exited ${code}`);
    if (pendingTool) { pendingTool.resolve(false); pendingTool = null; }
  });

  function handleHostMessage(msg) {
    if (msg.responseToRequestId && pendingTool && pendingTool.requestId === msg.responseToRequestId) {
      pendingTool.resolve(true);
      pendingTool = null;
      return;
    }
    if (msg.type === 'call_tool' && msg.requestId) {
      const { name } = msg.payload || {};
      console.log(`[sim] host → fake-extension: call_tool "${name}"`);
      child.stdin.write(frame({
        responseToRequestId: msg.requestId,
        payload: { status: 'success', data: { content: [{ type: 'text', text: 'FAKE_EXT_OK' }], isError: false } },
      }));
      return;
    }
    if (msg.type === 'rr_list_published_flows' && msg.requestId) {
      child.stdin.write(frame({ responseToRequestId: msg.requestId, payload: { status: 'success', items: [] } }));
      return;
    }
    if (msg.type === 'started' || msg.type === 'server_started') {
      console.log('[sim] host → fake-extension: server_started');
      return;
    }
    if (msg.type === 'error' || msg.type === 'error_from_native_host') {
      console.log('[sim] host error:', JSON.stringify(msg.payload || msg.error));
      return;
    }
  }

  child.stdin.write(frame({ type: 'start', payload: { port: PORT } }));
  const opened = await portOpen(PORT, 15000);
  if (!opened) { console.log('❌ SIM FAIL — MCP server never bound the port'); child.kill(); return false; }
  console.log(`[sim] MCP server listening on ${MCP_URL}`);

  const s = await initSession();
  if (!s.ok) { console.log('❌ SIM FAIL — initialize failed'); child.kill(); return false; }
  const tools = await mcpRpc('tools/list', {}, s.sessionId);
  const names = (tools.parsed && tools.parsed.result && tools.parsed.result.tools || []).map((t) => t.name);
  console.log(`[sim] tools/list → ${names.length} tools`);

  const callPromise = new Promise((resolve) => { pendingTool = { requestId: 'rt-1', resolve }; });
  const call = await mcpRpc('tools/call', { name: 'get_windows_and_tabs', arguments: {} }, s.sessionId);
  const forwarded = await Promise.race([callPromise, sleep(12000).then(() => false)]);
  const text = call.parsed && call.parsed.result && call.parsed.result.content && call.parsed.result.content[0] && call.parsed.result.content[0].text || '';
  console.log(`[sim] MCP result: ${text}`);

  child.stdin.write(frame({ type: 'stop' }));
  await sleep(400);
  child.kill();

  const pass = forwarded && text === 'FAKE_EXT_OK';
  console.log(pass
    ? '✅ SIM PASS — host boots, server binds, tool calls round-trip through native messaging.'
    : '❌ SIM FAIL');
  return pass;
}

async function main() {
  const live = await portOpen(PORT, 1500);
  const pass = live ? await liveMode() : await simulatedMode();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('TEST ERROR:', e.message); process.exit(1); });
