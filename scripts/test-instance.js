#!/usr/bin/env node
// test-instance.js — verify the multi-browser instance layer without a browser.
//
// lib/instance.js and tools/instance.js are service-worker modules, so this
// harness stubs the chrome/navigator globals they touch and loads them exactly
// as background.js does (registerTool/ok come from lib/protocol.js). It asserts
// the behaviour the CLI depends on: a stable instanceId, a deterministic port
// inside the shared range, persisted labels, and both instance tools' output.
//
//   node scripts/test-instance.js
'use strict';

const path = require('path');

let failures = 0;
let checks = 0;
function check(name, cond, detail) {
  checks++;
  if (cond) { console.log(`  ok    ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// ---- stubs ------------------------------------------------------------------
function makeStorage() {
  const store = new Map();
  // NOTE: the real shape is chrome.storage.local.{get,set} - keep it nested so
  // the harness exercises the same call path the service worker uses.
  return {
    _store: store,
    storage: {
      local: {
        get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      },
    },
  };
}

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_EDGE = UA_CHROME.replace('Chrome/126.0.0.0', 'Chrome/126.0.0.0 Edg/126.0.0.0');
const UA_OPERA = UA_CHROME.replace('Safari/537.36', 'OPR/112.0.0.0');

function freshGlobals(ua) {
  globalThis.chrome = Object.assign(makeStorage(), {
    runtime: { id: 'agfodficabgggjoapjaphagdcpnoeggc', getPlatformInfo: async () => ({ os: 'win' }) },
  });
  // Node >= 21 exposes `navigator` as a getter-only accessor, so assignment throws.
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: ua }, configurable: true, writable: true });
  globalThis.bridge = { mcpPort: 12311, connected: true, serverRunning: true };
}
function loadModules() {
  const libInstance = path.join(__dirname, '..', 'lib', 'instance.js');
  const toolInstance = path.join(__dirname, '..', 'tools', 'instance.js');
  delete require.cache[require.resolve(libInstance)];
  delete require.cache[require.resolve(toolInstance)];
  // protocol.js defines registerTool/ok as module-locals; in the service worker
  // importScripts() shares one global scope. Mirror that here, using the same
  // shapes protocol.js uses (ok = JSON text content, Registry keyed by name).
  globalThis.REGISTRY = {};
  globalThis.registerTool = (name, fn) => { globalThis.REGISTRY[name] = fn; };
  globalThis.ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false });
  require(libInstance);
  require(toolInstance);
  return globalThis.BRIDGE_INSTANCE;
}

// protocol.js defines ok(); tools/instance.js references `ok` and `registerTool`
// as free identifiers, which resolve to these globals.
(async () => {
  console.log('multi-browser instance layer\n');

  // ---- identity + ports -----------------------------------------------------
  freshGlobals(UA_CHROME);
  let BI = loadModules();

  eq('port range starts at 12306', BI.PORT_BASE, 12306);
  check('port span is sane', BI.PORT_SPAN >= 2, String(BI.PORT_SPAN));

  const id1 = await BI.getInstanceId();
  const id2 = await BI.getInstanceId();
  eq('instanceId is stable across reads', id1, id2);
  check('instanceId looks like a uuid', /^[0-9a-f-]{36}$/i.test(id1), id1);

  const p1 = await BI.defaultPort();
  const p2 = await BI.defaultPort();
  eq('defaultPort is deterministic', p1, p2);
  check('defaultPort is inside the shared range', p1 >= BI.PORT_BASE && p1 <= BI.PORT_BASE + BI.PORT_SPAN - 1, String(p1));

  // Ports must differ for different instances (that is the whole point).
  let distinct = new Set();
  for (let i = 0; i < 25; i++) distinct.add(BI.PORT_BASE + (Math.abs(i * 2654435761) % BI.PORT_SPAN));
  check('port span spreads instances', distinct.size >= 2, [...distinct].join(','));

  eq('nextPort wraps to PORT_BASE at the end', BI.nextPort(BI.PORT_BASE + BI.PORT_SPAN - 1), BI.PORT_BASE);
  eq('nextPort advances one', BI.nextPort(12306), 12307);

  // ---- label persistence ----------------------------------------------------
  eq('label defaults to empty', await BI.getLabel(), '');
  await BI.setLabel('  work  ');
  eq('label is trimmed', await BI.getLabel(), 'work');
  await BI.setLabel('x'.repeat(200));
  eq('label is capped at 60 chars', (await BI.getLabel()).length, 60);

  // ---- saved port -----------------------------------------------------------
  eq('no saved port initially', await BI.getSavedPort(), null);
  await BI.savePort(12345);
  eq('saved port roundtrips', await BI.getSavedPort(), 12345);
  await BI.savePort(80);
  eq('out-of-range port is ignored', await BI.getSavedPort(), 12345);

  // ---- browser fingerprinting ----------------------------------------------
  let bi = await BI.getBrowserInfo();
  eq('chrome UA -> chrome', bi.name, 'chrome');
  eq('chrome version parsed', bi.version, '126.0.0.0');
  eq('platform from chrome.runtime', bi.platform, 'win');

  freshGlobals(UA_EDGE);
  BI = loadModules();
  bi = await BI.getBrowserInfo();
  eq('edge UA -> edge', bi.name, 'edge');

  freshGlobals(UA_OPERA);
  BI = loadModules();
  bi = await BI.getBrowserInfo();
  eq('opera UA -> opera', bi.name, 'opera');

  // ---- the tools the CLI calls ---------------------------------------------
  freshGlobals(UA_CHROME);
  BI = loadModules();
  await BI.setLabel('work');

  const infoTool = globalThis.REGISTRY['bridge_get_instance_info'];
  check('bridge_get_instance_info is registered', typeof infoTool === 'function');
  const infoRes = await infoTool({});
  const info = JSON.parse(infoRes.content[0].text);
  check('info carries the instanceId', info.instanceId === (await BI.getInstanceId()));
  eq('info carries the label', info.label, 'work');
  eq('info carries the live mcpPort', info.mcpPort, 12311);
  eq('info carries an endpoint', info.endpoint, 'http://127.0.0.1:12311/mcp');
  eq('info reports the browser', info.browser.name, 'chrome');
  check('info reports the extensionId', !!info.extensionId, String(info.extensionId));
  eq('info reports connected', info.connected, true);
  eq('info reports serverRunning', info.serverRunning, true);

  const setTool = globalThis.REGISTRY['bridge_set_instance_label'];
  check('bridge_set_instance_label is registered', typeof setTool === 'function');
  const setRes = await setTool({ label: 'edge-victim' });
  const setOut = JSON.parse(setRes.content[0].text);
  eq('setter reports ok', setOut.ok, true);
  eq('setter persists the label', setOut.label, 'edge-victim');
  eq('setter echoes the new identity', setOut.instance.label, 'edge-victim');
  eq('setter survives a re-read', await BI.getLabel(), 'edge-victim');

  const cleared = await setTool({});
  eq('setter with no name clears the label', JSON.parse(cleared.content[0].text).label, '');

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) { console.log(`${failures} FAILED`); process.exitCode = 1; }
  else console.log('instance self-test PASSED');
})();
