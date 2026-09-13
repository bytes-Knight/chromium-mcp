#!/usr/bin/env node
// scripts/probe-cdp.js — diagnostic: exercises the performance trace and GIF
// recorder CDP paths directly and dumps the RAW MCP responses (not test
// summaries). Opens its own controlled tab, always closes the MCP session in a
// finally block (so the host's singleton transport never wedges), and restarts
// the host if a stale session is detected.
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
  for (const jl of jsonLines) { try { parsed = JSON.parse(jl); } catch (e) { /* skip */ } }
  if (!parsed) { try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text.slice(0, 300) }; } }
  return { status: res.status, sessionId: sid, parsed };
}
async function callTool(sessionId, name, args, timeoutMs = 25000) {
  const call = await withTimeout(mcpRpc('tools/call', { name, arguments: args || {} }, sessionId), timeoutMs, `tool ${name} timed out`);
  const result = call.parsed && call.parsed.result;
  if (!result) return { ok: false, raw: call.parsed };
  const text = result.content && result.content[0] && result.content[0].text || '';
  return { ok: !result.isError, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
const show = (r) => {
  const s = (r.text && r.text.length) ? r.text : JSON.stringify(r.raw === undefined ? { empty: true } : r.raw);
  return String(s).slice(0, 700);
};

async function main() {
  let sid = null;
  let ctl = null;
  try {
    const init = await mcpRpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe-cdp', version: '1' } }, null);
    sid = init.sessionId;
    if (!sid) { console.error('init failed:', JSON.stringify(init.parsed).slice(0, 300)); return; }
    await mcpRpc('notifications/initialized', {}, sid).catch(() => {});

    const tabs = await callTool(sid, 'get_windows_and_tabs', {});
    let tabId = null;
    try {
      const wins = JSON.parse(tabs.text);
      const active = wins.flatMap((w) => w.tabs).find((t) => t.active) || wins.flatMap((w) => w.tabs).find((t) => t.url && /^https?:/.test(t.url));
      tabId = active && active.id;
      console.log('active tab:', tabId, active && active.url);
    } catch (e) { console.error('tabs parse failed', e.message); }

    // Phase 0: open a fresh plain-HTTP tab we fully control, so attach failures
    // can't be blamed on the active tab being an extension/restricted page.
    console.log('\n--- phase 0: open controlled http tab ---');
    const opened = await callTool(sid, 'chrome_open_tabs', { urls: ['http://127.0.0.1:8897/tabtest'], background: true });
    console.log('open ok:', opened.ok, '\n', (opened.text || JSON.stringify(opened.raw)).slice(0, 400));
    try { ctl = JSON.parse(opened.text).opened[0]; } catch (e) { /* ignore */ }
    if (ctl) {
      tabId = ctl.id;
      console.log('controlled tab:', tabId, 'http://127.0.0.1:8897/tabtest');
      // Give the new tab a moment to finish loading (it was opened in the
      // background, so no load-complete event was awaited).
      await sleep(2500);
    }

    console.log('\n--- performance_start_trace ---');
    const ts = await callTool(sid, 'performance_start_trace', { tabId, autoStop: false });
    console.log('ok:', ts.ok, '\n', (ts.text || JSON.stringify(ts.raw)).slice(0, 600));
    await sleep(1200);
    console.log('\n--- performance_stop_trace ---');
    const te = await callTool(sid, 'performance_stop_trace', { saveToDownloads: false });
    console.log('ok:', te.ok, '\n', (te.text || JSON.stringify(te.raw)).slice(0, 600));

    console.log('\n--- chrome_gif_recorder start ---');
    const gs = await callTool(sid, 'chrome_gif_recorder', { action: 'start', fps: 2, tabId, save: false });
    console.log('ok:', gs.ok, '\n', show(gs));
    await sleep(1400);
    console.log('\n--- chrome_gif_recorder status ---');
    const gst = await callTool(sid, 'chrome_gif_recorder', { action: 'status' });
    console.log('ok:', gst.ok, '\n', show(gst));
    console.log('\n--- chrome_gif_recorder stop ---');
    const rawCall = await withTimeout(
      mcpRpc('tools/call', { name: 'chrome_gif_recorder', arguments: { action: 'stop', save: false } }, sid),
      30000,
      'stop timed out'
    );
    const gd = { ok: !!(rawCall.parsed && rawCall.parsed.result && !rawCall.parsed.result.isError), text: (rawCall.parsed && rawCall.parsed.result && rawCall.parsed.result.content && rawCall.parsed.result.content[0] && rawCall.parsed.result.content[0].text) || '' };
    console.log('ok:', gd.ok);
    // Dump the RAW HTTP body so a silent failure can't hide its message.
    const rawBody = rawCall.parsed && rawCall.parsed.raw ? rawCall.parsed.raw : JSON.stringify(rawCall.parsed);
    console.log('raw status:', rawCall.status);
    console.log('raw body (first 800):', String(rawBody).slice(0, 800));
    console.log('raw body length:', String(rawBody).length);
    console.log('parsed result:', JSON.stringify(rawCall.parsed && rawCall.parsed.result).slice(0, 800));
  } catch (e) {
    console.error('probe error:', e.message);
  } finally {
    // Always release the MCP session and close the controlled tab so the host
    // never wedges on an orphaned session (its singleton transport refuses new
    // connections until the host process is restarted).
    if (ctl) {
      try { await callTool(sid, 'chrome_close_tabs', { tabIds: [ctl.id] }); } catch (e) { /* ignore */ }
    }
    if (sid) {
      try { await fetch(MCP_URL, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } }); } catch (e) { /* ignore */ }
    }
  }
}
main().then(() => process.exit(0), (e) => { console.error('probe error:', e.message); process.exit(1); });
