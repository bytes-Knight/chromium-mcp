#!/usr/bin/env node
// test-mcpctl-instances.js — end-to-end test of mcpctl's multi-browser support.
//
// Spins up several mock MCP bridges on a private port range (so it never
// touches the real 12306 bridge) and drives the actual CLI against them:
// discovery, --browser selectors, ambiguity handling, the identity cache that
// covers busy instances, and the fallback for an older extension.
//
//   node scripts/test-mcpctl-instances.js
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '..', 'app', 'mcpctl.js');
const BASE = 12410;
const RANGE = `${BASE}-${BASE + 3}`;
const CACHE = path.join(os.tmpdir(), 'mcpctl-instances.json');

let failures = 0;
let checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// NOTE: async, not spawnSync. The mock bridges live in THIS process, so a
// synchronous child would block the event loop and the mocks could never
// answer - every probe would just time out.
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* ignore */ } }, 60000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
async function cliJson(args) {
  const r = await cli(args);
  let parsed = null;
  try { parsed = JSON.parse(r.out); } catch (e) { /* leave null */ }
  return Object.assign({}, r, { json: parsed });
}

// ---- mock bridge -------------------------------------------------------------
function createBridge(port, opts) {
  const state = {
    sessions: new Set(),
    label: opts.label || '',
    busy: !!opts.busy,
    hasIdentityTool: opts.hasIdentityTool !== false,
    browser: opts.browser,
    calls: [],
  };
  let seq = 0;

  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'DELETE' && url === '/mcp') {
      state.sessions.delete(req.headers['mcp-session-id']);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method !== 'POST' || url !== '/mcp') { res.writeHead(404); res.end(); return; }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let rpc = {};
      try { rpc = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
      const send = (obj, headers) => {
        res.writeHead(obj.__status || 200, Object.assign({ 'content-type': 'application/json' }, headers || {}));
        delete obj.__status;
        res.end(JSON.stringify(obj));
      };
      const okResult = (data) => ({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false } });
      const errResult = (msg) => ({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'Error: ' + msg }], isError: true } });

      if (rpc.method === 'initialize') {
        if (state.busy) {
          // What the real host says when a session is already held.
          send({ __status: 409, jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'Already connected to a transport' } });
          return;
        }
        const sid = `sess-${port}-${++seq}`;
        state.sessions.add(sid);
        send({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-bridge', version: '1' } } }, { 'mcp-session-id': sid });
        return;
      }
      if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (rpc.method === 'tools/list') { send({ jsonrpc: '2.0', id: rpc.id, result: { tools: [] } }); return; }
      if (rpc.method === 'tools/call') {
        const name = (rpc.params && rpc.params.name) || '';
        state.calls.push(name);
        if (name === 'get_windows_and_tabs') {
          send(okResult([{ id: 1, focused: true, tabs: [{ id: 10, active: true, url: opts.activeUrl || 'https://example.com/', title: opts.activeTitle || 'Example' }] }]));
          return;
        }
        if (name === 'bridge_get_instance_info') {
          if (!state.hasIdentityTool) { send(errResult('Unknown tool: bridge_get_instance_info')); return; }
          send(okResult({
            instanceId: opts.instanceId,
            label: state.label,
            browser: state.browser,
            extensionId: 'agfodficabgggjoapjaphagdcpnoeggc',
            mcpPort: port,
            endpoint: `http://127.0.0.1:${port}/mcp`,
            connected: true,
            serverRunning: true,
          }));
          return;
        }
        if (name === 'bridge_set_instance_label') {
          state.label = String(((rpc.params.arguments || {}).label) || '').trim().slice(0, 60);
          send(okResult({ ok: true, label: state.label }));
          return;
        }
        send(errResult('Unknown tool: ' + name));
        return;
      }
      send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port, server, state })));
}

(async () => {
  console.log(`multi-browser CLI test (mock bridges on ${RANGE})\n`);
  try { fs.unlinkSync(CACHE); } catch (e) { /* no cache yet */ }

  const bridges = [];
  bridges.push(await createBridge(BASE, {
    browser: { name: 'chrome', version: '126.0.0.0', platform: 'win' },
    instanceId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', label: 'work',
  }));
  bridges.push(await createBridge(BASE + 1, {
    browser: { name: 'chrome', version: '126.0.0.0', platform: 'win' },
    instanceId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', label: '',
  }));
  bridges.push(await createBridge(BASE + 2, {
    browser: { name: 'edge', version: '126.0.0.0', platform: 'win' },
    instanceId: 'cccccccc-3333-4333-8333-cccccccccccc', label: 'edge-victim',
  }));
  bridges.push(await createBridge(BASE + 3, {
    // Older extension: no identity tool at all.
    hasIdentityTool: false,
    browser: { name: 'brave', version: '126.0.0.0', platform: 'win' },
    instanceId: 'dddddddd-4444-4444-8444-dddddddddddd',
    activeTitle: 'Brave-only tab', activeUrl: 'https://brave.example/',
  }));

  try {
    // ---- 1. discovery ------------------------------------------------------
    console.log('discovery');
    const t0 = Date.now();
    const disc = await cliJson(['browsers', '--json', '--range', RANGE]);
    const scanMs = Date.now() - t0;
    check('browsers exits 0', disc.code === 0, `code=${disc.code} err=${disc.err.slice(0, 120)}`);
    check('browsers returns JSON', !!disc.json, disc.out.slice(0, 160));
    const inst = (disc.json && disc.json.instances) || [];
    eq('finds all four bridges', inst.length, 4);
    check('scan is parallel/fast (< 5s)', scanMs < 5000, `${scanMs}ms`);
    eq('every instance reports ok', inst.filter((i) => i.state === 'ok').length, 4);

    const byPort = {};
    for (const i of inst) byPort[i.port] = i;
    eq('port A browser', byPort[BASE].info.browser.name, 'chrome');
    eq('port A label', byPort[BASE].info.label, 'work');
    eq('port A selector prefers the label', byPort[BASE].selector, 'work');
    eq('port B is unlabeled', byPort[BASE + 1].info.label, '');
    eq('port B selector falls back to name:port', byPort[BASE + 1].selector, `chrome:${BASE + 1}`);
    eq('port C browser', byPort[BASE + 2].info.browser.name, 'edge');
    eq('port C selector', byPort[BASE + 2].selector, 'edge-victim');
    eq('port D has no identity', byPort[BASE + 3].info, null);
    check('port D is described by its tabs', !!byPort[BASE + 3].unidentified, JSON.stringify(byPort[BASE + 3]).slice(0, 160));
    eq('port D fallback sees the active tab', byPort[BASE + 3].unidentified.activeTab.title, 'Brave-only tab');

    const human = await cli(['browsers', '--range', RANGE]);
    check('human output lists the label', human.out.includes('work'), human.out.slice(0, 200));
    check('human output lists the edge browser', /edge/.test(human.out), human.out.slice(0, 200));
    check('human output warns about the old extension', /reload the extension/i.test(human.out), human.out.slice(0, 400));

    // ---- 2. --browser selectors -------------------------------------------
    console.log('\n--browser selectors');
    const byLabel = await cli(['--browser', 'edge-victim', 'status', '--range', RANGE]);
    check('label selector resolves', byLabel.err.includes(`127.0.0.1:${BASE + 2}`), byLabel.err.slice(0, 160));
    check('label selector reaches the bridge', /"state": "ok"/.test(byLabel.out), byLabel.out.slice(0, 200));

    const byNamePort = await cli(['--browser', `chrome:${BASE + 1}`, 'status', '--range', RANGE]);
    check('name:port selector resolves', byNamePort.err.includes(`127.0.0.1:${BASE + 1}`), byNamePort.err.slice(0, 160));
    check('name:port selector is healthy', /"state": "ok"/.test(byNamePort.out), byNamePort.out.slice(0, 200));

    const byPortSel = await cli(['--browser', `port:${BASE + 2}`, 'ping', '--range', RANGE]);
    check('port: selector resolves', byPortSel.err.includes(`127.0.0.1:${BASE + 2}`), byPortSel.err.slice(0, 160));
    check('port: selector pings', byPortSel.code === 0, `code=${byPortSel.code} ${byPortSel.err.slice(0, 120)}`);

    const byIdPrefix = await cli(['--browser', 'id:bbbbbbbb', 'status', '--range', RANGE]);
    check('id: prefix selector resolves', byIdPrefix.err.includes(`127.0.0.1:${BASE + 1}`), byIdPrefix.err.slice(0, 160));

    // Two chromes are live -> a bare browser name must NOT guess.
    const ambiguous = await cli(['--browser', 'chrome', 'status', '--range', RANGE]);
    eq('ambiguous name exits 3', ambiguous.code, 3);
    check('ambiguous name is reported', /ambiguous/.test(ambiguous.err), ambiguous.err.slice(0, 200));
    check('ambiguous name lists both candidates', ambiguous.err.includes(`:${BASE}`) && ambiguous.err.includes(`:${BASE + 1}`), ambiguous.err.slice(0, 300));

    const unmatched = await cli(['--browser', 'nosuchbrowser', 'status', '--range', RANGE]);
    eq('unknown selector exits 3', unmatched.code, 3);
    check('unknown selector lists candidates', unmatched.err.includes(`:${BASE}`), unmatched.err.slice(0, 200));

    // ---- 3. labeling from the CLI -----------------------------------------
    console.log('\nlabel');
    const setLabel = await cli(['--browser', `port:${BASE + 1}`, 'label', 'second-chrome', '--range', RANGE]);
    check('label command succeeds', setLabel.code === 0, `code=${setLabel.code} ${setLabel.err.slice(0, 160)}`);
    check('label is persisted on the instance', bridges[1].state.label === 'second-chrome', bridges[1].state.label);
    const afterLabel = await cliJson(['browsers', '--json', '--range', RANGE]);
    const pb = (afterLabel.json.instances || []).find((i) => i.port === BASE + 1);
    eq('browsers reflects the new label', pb.selector, 'second-chrome');

    // ---- 4. busy instance resolves from the cache --------------------------
    console.log('\nbusy instance + cache');
    // Re-read once so the cache is definitely warm, then hold a session.
    await cli(['browsers', '--json', '--range', RANGE]);
    bridges[0].state.busy = true;
    const busyDisc = await cliJson(['browsers', '--json', '--range', RANGE]);
    const busy = (busyDisc.json.instances || []).find((i) => i.port === BASE);
    eq('busy instance is detected as busy', busy.state, 'busy');
    check('busy instance still has identity from cache', !!busy.info, JSON.stringify(busy).slice(0, 200));
    eq('busy instance still exposes its label selector', busy.selector, 'work');
    // status takes no lock and never restarts the host, so it is safe here.
    const busyTarget = await cli(['--browser', 'work', 'status', '--range', RANGE]);
    check('--browser still resolves a busy instance from cache', busyTarget.err.includes(`127.0.0.1:${BASE}`), busyTarget.err.slice(0, 200));
    bridges[0].state.busy = false;

    // ---- 5. label-less identity stays honest ------------------------------
    console.log('\nno identity tool');
    const noIdentity = await cli(['browsers', '--range', RANGE]);
    check('unidentified instance is flagged', /unidentified browser/.test(noIdentity.out), noIdentity.out.slice(0, 400));
    check('unidentified instance still gets a port selector', noIdentity.out.includes(`mcpctl --port ${BASE + 3}`), noIdentity.out.slice(0, 500));
  } finally {
    for (const b of bridges) b.server.close();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) { console.log(`${failures} FAILED`); process.exitCode = 1; }
  else console.log('mcpctl multi-browser test PASSED');
})();
