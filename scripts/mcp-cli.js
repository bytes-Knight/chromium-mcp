#!/usr/bin/env node
// scripts/mcp-cli.js — minimal MCP streamable-HTTP client for the chrome bridge.
// Usage:
//   node scripts/mcp-cli.js tools/list
//   node scripts/mcp-cli.js <tool_name> '<json args>'
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
  if (!parsed) { try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text.slice(0, 500) }; } }
  return { status: res.status, sessionId: sid, parsed };
}

async function main() {
  const [tool, argsJson = '{}'] = process.argv.slice(2);
  if (!tool) { console.error('usage: node scripts/mcp-cli.js <tool_name> [json_args]'); process.exit(1); }
  let args = {};
  try { args = JSON.parse(argsJson); } catch (e) { console.error('bad args json'); process.exit(1); }

  const init = await mcpRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-cli', version: '1.0.0' },
  }, null);
  if (init.status !== 200 || !init.sessionId) {
    console.error('initialize failed:', JSON.stringify(init).slice(0, 400));
    process.exit(1);
  }
  const sessionId = init.sessionId;
  await mcpRpc('notifications/initialized', {}, sessionId).catch(() => {});

  if (tool === 'tools/list') {
    const r = await mcpRpc('tools/list', {}, sessionId);
    const names = (r.parsed && r.parsed.result && r.parsed.result.tools || []).map((t) => `${t.name}(${JSON.stringify((t.inputSchema && t.inputSchema.properties) || {})})`);
    console.log(names.join('\n'));
    process.exit(0);
  }

  const call = await mcpRpc('tools/call', { name: tool, arguments: args }, sessionId);
  const result = call.parsed && call.parsed.result;
  const text = result && result.content && result.content.map((c) => c.text || '').join('\n') || JSON.stringify(call.parsed || call).slice(0, 500);
  console.log(text);
  // Release the session so the singleton server can serve the next client.
  try {
    await fetch(MCP_URL, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } });
  } catch (e) { /* ignore */ }
  process.exit(0);
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
