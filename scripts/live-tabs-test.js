#!/usr/bin/env node
// scripts/live-tabs-test.js
// Live end-to-end test of the NEW tab/window toolkit through the real MCP
// endpoint (http://127.0.0.1:12306/mcp). Serves its own local page, opens and
// manages ONLY tabs/windows it creates (on its own domain/port), and cleans up
// after itself — your existing tabs and windows are never touched.
//
// Usage: node scripts/live-tabs-test.js
// Requires the clean-room extension RELOADED in the browser (chrome://extensions
// → reload → accept the new tabGroups/cookies/system.display permissions).
'use strict';
const http = require('http');
const { execSync, spawnSync } = require('child_process');

const MCP_URL = 'http://127.0.0.1:12306/mcp';
const MCP_PORT = 12306;
const PAGE_PORT = 8897;
const TEST_URL = `http://127.0.0.1:${PAGE_PORT}/tabtest`;
const MARKER = 'MCP-TAB-TOOLKIT-MARKER-7f3a';
const UNIQUE_TITLE = 'MCP Tab Toolkit Test Page';

// ---- Host restart helper (same as live-feature-test.js) ---------------------
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
  if (pid) { console.log(`[host] restarting stuck native host (PID ${pid})…`); killPid(pid); }
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (listeningPid(MCP_PORT)) { await sleep(1500); return true; }
  }
  return false;
}
async function initSessionWithRetry() {
  try { return await initSession(); }
  catch (e) {
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
<html lang="en"><head><meta charset="utf-8"><title>${UNIQUE_TITLE}</title></head>
<body>
  <h1 id="heading">${UNIQUE_TITLE}</h1>
  <p id="marker">${MARKER}</p>
  <input id="field" type="text" placeholder="type here">
  <script>document.title = '${UNIQUE_TITLE}';</script>
</body></html>`;

function startPageServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
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
  const sid = res.headers.get('mcp-session-id');
  const text = await res.text();
  const jsonLines = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  let parsed = null;
  for (const jl of jsonLines) { try { parsed = JSON.parse(jl); } catch (e) { /* skip */ } }
  if (!parsed) { try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text.slice(0, 300) }; } }
  return { status: res.status, sessionId: sid, parsed };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function closeSession(sessionId) {
  try { await fetch(MCP_URL, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } }); } catch (e) { /* ignore */ }
}
async function initSession() {
  const init = await mcpRpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-tabs-test', version: '1.0.0' } }, null);
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
let server = null; // hoisted so the error path can unref it before exit
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`\n${mark} — ${name}`);
  if (detail) console.log('       ' + String(detail).slice(0, 400).replace(/\n/g, '\n       '));
}

async function main() {
  server = await startPageServer();
  console.log(`[setup] test page serving at ${TEST_URL}`);
  const sid = await initSessionWithRetry();
  console.log('[setup] MCP session ok');

  // ---- Gate: are the NEW tools loaded? --------------------------------------
  const probe = await callTool(sid, 'chrome_search_tabs', { query: 'zzz-nonexistent' });
  if (probe.error && /Unknown tool/i.test(probe.error)) {
    console.error('\n[gate] The browser is still running the OLD extension.');
    console.error('       New tools are not registered. Please:');
    console.error('       1. Open chrome://extensions');
    console.error('       2. Click the reload ↻ button on "Chrome MCP Bridge (clean-room)"');
    console.error('       3. Accept the new permissions (tabGroups, cookies, system.display)');
    console.error('       4. Re-run: node scripts/live-tabs-test.js\n');
    await closeSession(sid); // don't leak the MCP session into the next run
    server.unref();
    process.exitCode = 2;
    return;
  }
  if (!probe.ok) { console.error('[gate] chrome_search_tabs failed:', probe.error); }

  // ---- Baseline tab count in the focused window -----------------------------
  const wt0 = await callTool(sid, 'get_windows_and_tabs', {});
  const wins0 = wt0.ok && Array.isArray(wt0.data) ? wt0.data : [];
  const focused0 = wins0.find((w) => w.focused) || wins0[0] || null;
  const baselineCount = focused0 ? focused0.tabs.length : 0;
  console.log(`[setup] baseline tabs in focused window: ${baselineCount}`);

  // ---- 1. Open three tabs ---------------------------------------------------
  const open = await callTool(sid, 'chrome_open_tabs', {
    urls: [TEST_URL, `${TEST_URL}?n=2`, `${TEST_URL}?n=3`],
    active: true,
  });
  const openedTabs = (open.ok && open.data && open.data.opened) || [];
  record('chrome_open_tabs (3 tabs)', open.ok && openedTabs.length === 3, JSON.stringify(open.ok ? open.data : open.error).slice(0, 300));
  const windowId = open.ok && open.data ? open.data.windowId : (focused0 && focused0.id);

  // ---- 2. Find them with chrome_search_tabs ---------------------------------
  // chrome.tabs.create resolves before the page finishes loading, so poll until
  // the new tabs actually carry the test URL.
  let foundBySearch = [];
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const search = await callTool(sid, 'chrome_search_tabs', { query: UNIQUE_TITLE });
    foundBySearch = (search.ok && search.data && search.data.matches || []).filter((m) => m.url.startsWith(TEST_URL));
    if (foundBySearch.length >= 3) break;
  }
  record('chrome_search_tabs finds all 3', foundBySearch.length >= 3, `found=${foundBySearch.length}`);

  // ---- 3. chrome_tab_details ------------------------------------------------
  const detailIds = openedTabs.map((t) => t.id).slice(0, 2);
  const details = await callTool(sid, 'chrome_tab_details', { tabIds: detailIds });
  const dTab = details.ok && details.data && details.data.tabs && details.data.tabs[0];
  // cookieStoreId is informational (Chrome only populates it for some windows);
  // url and groupId are the fields the toolkit promises.
  record('chrome_tab_details (url, groupId)', !!(dTab && dTab.url && dTab.groupId !== undefined),
    dTab ? `url=${dTab.url} groupId=${dTab.groupId} cookieStoreId=${dTab.cookieStoreId}` : JSON.stringify(details.error || details.data).slice(0, 200));

  // ---- 4. pin / unpin -------------------------------------------------------
  const pin = await callTool(sid, 'chrome_pin_tabs', { tabIds: detailIds });
  const pinTab = pin.ok && pin.data && pin.data.pinned && pin.data.pinned[0];
  const pinVerify = await callTool(sid, 'chrome_tab_details', { tabIds: [pinTab && pinTab.tabId] });
  const unpin = await callTool(sid, 'chrome_unpin_tabs', { tabIds: detailIds });
  record('chrome_pin_tabs / unpin_tabs', !!(pinTab && pinTab.pinned === true && unpin.ok),
    `pin=${JSON.stringify(pinTab)} unpinOk=${unpin.ok} ${unpin.error || ''}`);

  // ---- 5. mute / unmute -----------------------------------------------------
  const mute = await callTool(sid, 'chrome_mute_tabs', { tabIds: detailIds });
  const muteTab = mute.ok && mute.data && mute.data.muted && mute.data.muted[0];
  const unmute = await callTool(sid, 'chrome_unmute_tabs', { tabIds: detailIds });
  record('chrome_mute_tabs / unmute_tabs', !!(muteTab && muteTab.muted === true && unmute.ok),
    `muted=${JSON.stringify(muteTab)} unmuteOk=${unmute.ok}`);

  // ---- 6. duplicate ---------------------------------------------------------
  const dup = await callTool(sid, 'chrome_duplicate_tabs', { tabIds: [detailIds[0]] });
  const dupTab = dup.ok && dup.data && dup.data.duplicated && dup.data.duplicated[0];
  const dupVerify = await callTool(sid, 'chrome_search_tabs', { query: UNIQUE_TITLE });
  const dupCount = (dupVerify.ok && dupVerify.data && dupVerify.data.matches || []).filter((m) => m.url.startsWith(TEST_URL)).length;
  record('chrome_duplicate_tabs', !!(dupTab && dupTab.id !== detailIds[0] && dupTab.url.startsWith(TEST_URL)),
    `newTabId=${dupTab && dupTab.id} url=${dupTab && dupTab.url}`);

  // ---- 7. group / tab_groups / ungroup --------------------------------------
  const grp = await callTool(sid, 'chrome_group_tabs', { tabIds: detailIds, title: 'MCP Test Group', color: 'blue' });
  const groupId = grp.ok && grp.data ? grp.data.groupId : null;
  const groups = await callTool(sid, 'chrome_tab_groups', {});
  const groupListed = (groups.ok && groups.data && groups.data.groups || []).some((g) => g.groupId === groupId && g.title === 'MCP Test Group');
  const ungrp = await callTool(sid, 'chrome_ungroup_tabs', { tabIds: detailIds });
  record('chrome_group_tabs + tab_groups + ungroup_tabs', !!(grp.ok && groupListed && ungrp.ok),
    `groupId=${groupId} listed=${groupListed} title=${grp.ok && grp.data && grp.data.title} color=${grp.ok && grp.data && grp.data.color} ungroupOk=${ungrp.ok}`);

  // ---- 8. move --------------------------------------------------------------
  const moveTarget = dupTab ? dupTab.id : detailIds[0];
  const move = await callTool(sid, 'chrome_move_tabs', { tabIds: [moveTarget], windowId, index: 0 });
  const moved = move.ok && move.data && move.data.moved && move.data.moved[0];
  record('chrome_move_tabs to index 0', !!(moved && moved.index === 0),
    moved ? `tabId=${moved.tabId} windowId=${moved.windowId} index=${moved.index}` : JSON.stringify(move.error || move.data).slice(0, 200));

  // ---- 9. zoom --------------------------------------------------------------
  const zoomBase = await callTool(sid, 'chrome_zoom', { tabId: detailIds[0] });
  const zoomSet = await callTool(sid, 'chrome_zoom', { tabId: detailIds[0], factor: 1.5 });
  const zoomReset = await callTool(sid, 'chrome_zoom', { tabId: detailIds[0], reset: true });
  const zBase = zoomBase.ok && zoomBase.data ? zoomBase.data.factor : null;
  const zSet = zoomSet.ok && zoomSet.data ? zoomSet.data.factor : null;
  const zReset = zoomReset.ok && zoomReset.data ? zoomReset.data.factor : null;
  record('chrome_zoom get/set/reset', zSet === 1.5 && zReset === 1,
    `base=${zBase} afterSet=${zSet} afterReset=${zReset}`);

  // ---- 10. reload -----------------------------------------------------------
  const reload = await callTool(sid, 'chrome_reload_tabs', { tabIds: detailIds, bypassCache: true });
  const reloaded = (reload.ok && reload.data && reload.data.reloaded || []).filter((r) => r.ok);
  record('chrome_reload_tabs (bypassCache)', reload.ok && reloaded.length === detailIds.length,
    `ok=${reload.ok} reloaded=${reloaded.length}/${detailIds.length} ${reload.error || ''}`);

  // ---- 11. content search ---------------------------------------------------
  await sleep(600);
  const content = await callTool(sid, 'chrome_search_tabs_content', { query: MARKER, maxResults: 5 });
  const contentMatches = (content.ok && content.data && content.data.matches || []).filter((m) => m.url.startsWith(TEST_URL));
  record('chrome_search_tabs_content finds marker', contentMatches.length >= 1,
    `matches=${contentMatches.length} firstUrl=${contentMatches[0] && contentMatches[0].url}`);

  // ---- 12. cookies ----------------------------------------------------------
  const cookieUrl = `http://127.0.0.1:${PAGE_PORT}/`;
  const setCookie = await callTool(sid, 'chrome_cookies', { action: 'set', url: cookieUrl, name: 'mcp_test_cookie', value: 'ok' });
  const getCookie = await callTool(sid, 'chrome_cookies', { action: 'get', url: cookieUrl, name: 'mcp_test_cookie' });
  const gotCookie = getCookie.ok && getCookie.data && getCookie.data.cookie;
  const delCookie = await callTool(sid, 'chrome_cookies', { action: 'delete', url: cookieUrl, name: 'mcp_test_cookie' });
  record('chrome_cookies set/get/delete', !!(setCookie.ok && gotCookie && gotCookie.value === 'ok' && delCookie.ok),
    `set=${setCookie.ok} got=${gotCookie && gotCookie.value} del=${delCookie.ok}`);

  // ---- 13. downloads (read-only list) ----------------------------------------
  const dl = await callTool(sid, 'chrome_downloads', { action: 'list', limit: 5 });
  record('chrome_downloads list', dl.ok && Array.isArray(dl.data && dl.data.downloads),
    dl.ok ? `count=${dl.data.count}` : dl.error);

  // ---- 14. window: new / manage / arrange / close ----------------------------
  const nw = await callTool(sid, 'chrome_new_window', { urls: [TEST_URL], focused: false });
  const testWinId = nw.ok && nw.data ? nw.data.windowId : null;
  const mw = await callTool(sid, 'chrome_manage_window', { windowId: testWinId, state: 'maximized' });
  const mw2 = await callTool(sid, 'chrome_manage_window', { windowId: testWinId, state: 'normal', width: 900, height: 600 });
  const arr = testWinId ? await callTool(sid, 'chrome_arrange_windows', { windowIds: [testWinId], layout: 'grid' }) : { ok: false };
  const arrOk = arr.ok && arr.data && arr.data.arranged && arr.data.arranged.length === 1;
  const cw = await callTool(sid, 'chrome_close_windows', { windowIds: [testWinId] });
  record('chrome_new_window + manage + arrange + close_windows', !!(nw.ok && mw.ok && mw2.ok && arrOk && cw.ok),
    `new=${nw.ok} max=${mw.ok} resize=${mw2.ok} arranged=${arrOk} closed=${cw.ok} ${arr.error || ''}`);

  // ---- 15. performance trace (no file) ---------------------------------------
  const tr = await callTool(sid, 'performance_start_trace', { tabId: detailIds[0], autoStop: false });
  await sleep(900);
  const trStop = await callTool(sid, 'performance_stop_trace', { saveToDownloads: false });
  const evCount = trStop.ok && trStop.data ? trStop.data.eventCount : 0;
  const trAnalyze = await callTool(sid, 'performance_analyze_insight', {});
  record('performance trace start/stop/analyze', tr.ok && trStop.ok && evCount > 0 && trAnalyze.ok,
    `started=${tr.ok} stopped=${trStop.ok} events=${evCount} analyzeOk=${trAnalyze.ok} ${trStop.error || ''}`);

  // ---- 16. GIF recorder (no download) ----------------------------------------
  // Activate the target tab first so CDP frame capture is reliable.
  await callTool(sid, 'chrome_switch_tab', { tabId: detailIds[0] });
  const gifStart = await callTool(sid, 'chrome_gif_recorder', { action: 'start', fps: 2, tabId: detailIds[0], save: false });
  await sleep(1600);
  const gifStop = await callTool(sid, 'chrome_gif_recorder', { action: 'stop', save: false });
  const gifFrames = gifStop.ok && gifStop.data ? gifStop.data.frames : 0;
  const gifBytes = gifStop.ok && gifStop.data ? gifStop.data.size : 0;
  record('chrome_gif_recorder start/stop', gifStart.ok && gifStop.ok && gifFrames >= 1 && gifBytes > 0,
    `started=${gifStart.ok} frames=${gifFrames} bytes=${gifBytes} ${gifStop.error || gifStop.data && gifStop.data.error || ''}`);

  // ---- Cleanup: close every tab on the test domain ---------------------------
  const cleanup = await callTool(sid, 'chrome_close_tabs', { domain: `127.0.0.1:${PAGE_PORT}` });
  const closedCount = cleanup.ok && cleanup.data ? cleanup.data.count : 0;
  await sleep(400);
  const wt1 = await callTool(sid, 'get_windows_and_tabs', {});
  const wins1 = wt1.ok && Array.isArray(wt1.data) ? wt1.data : [];
  const focused1 = wins1.find((w) => w.focused) || wins1[0] || null;
  const finalCount = focused1 ? focused1.tabs.length : 0;
  record('cleanup: domain close restores baseline', closedCount >= 4 && finalCount === baselineCount,
    `closed=${closedCount} before=${baselineCount} after=${finalCount} ${cleanup.error || ''}`);

  server.close();
  await closeSession(sid);
  console.log('[cleanup] MCP session closed');

  // ---- Summary ---------------------------------------------------------------
  console.log('\n==================== SUMMARY ====================');
  let pass = 0;
  for (const r of results) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`);
    if (r.pass) pass++;
  }
  console.log(`  ${pass}/${results.length} features passed`);
  console.log('==================================================');
  // Let the event loop drain naturally (avoids a Windows libuv close/exit race
  // with the fetch keep-alive socket).
  server.unref();
  process.exitCode = pass === results.length ? 0 : 1;
}

main().catch((e) => {
  console.error('TEST ERROR:', e.message);
  if (server) server.unref();
  process.exitCode = 1;
});
