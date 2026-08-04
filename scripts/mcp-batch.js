#!/usr/bin/env node
// scripts/mcp-batch.js — run multiple bridge tool calls in ONE MCP session.
// Usage:
//   node scripts/mcp-batch.js '[["get_windows_and_tabs",{}],["chrome_read_page",{}]]'
// Prints a JSON array of results, one per call. Exits non-zero if any call fails.
'use strict';

const MCP_URL = 'http://127.0.0.1:12306/mcp';
let rpcCounter = 0;

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

function extractText(call) {
  const result = call.parsed && call.parsed.result;
  if (result && result.content) return result.content.map((c) => c.text || '').join('\n');
  if (call.parsed && call.parsed.error) return 'ERR: ' + JSON.stringify(call.parsed.error).slice(0, 300);
  return JSON.stringify(call.parsed || call).slice(0, 300);
}

async function main() {
  const jobs = JSON.parse(process.argv[2] || '[]');
  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.error('usage: node scripts/mcp-batch.js \'[["tool",{args}],...]\'');
    process.exit(1);
  }

  const init = await mcpRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-batch', version: '1.0.0' },
  }, null);
  if (init.status !== 200 || !init.sessionId) {
    console.error('initialize failed:', JSON.stringify(init.parsed).slice(0, 400));
    process.exit(1);
  }
  const sessionId = init.sessionId;
  await mcpRpc('notifications/initialized', {}, sessionId).catch(() => {});

  const out = [];
  let failed = false;
  for (const [tool, args] of jobs) {
    try {
      const call = await mcpRpc('tools/call', { name: tool, arguments: args || {} }, sessionId);
      const isError = call.parsed && call.parsed.result && call.parsed.result.isError;
      out.push({ tool, ok: !isError && call.status === 200, text: extractText(call) });
      if (isError || call.status !== 200) failed = true;
    } catch (e) {
      out.push({ tool, ok: false, text: 'THROW: ' + e.message });
      failed = true;
    }
  }

  try {
    await fetch(MCP_URL, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } });
  } catch (e) { /* ignore */ }

  console.log(JSON.stringify(out, null, 1));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
