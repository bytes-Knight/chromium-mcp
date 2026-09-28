#!/usr/bin/env node
// scripts/test-auto-connect.js — simulate background.js (the service worker) in
// Node to prove the bridge connects ITSELF: at service-worker start, after a
// disconnect, and after connectNative() throws because the native-messaging host
// manifest is missing for THIS browser profile (Chrome/Brave/Edge each keep
// their own host list).
//
// Regression guard for "I have to click Connect every time I open the browser".
//
// Only lib/protocol.js and lib/instance.js are evaluated alongside background.js
// — the tools/*.js registrations aren't needed to exercise the connection logic.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- minimal chrome.* / worker mock -----------------------------------------
function makeHarness({ failTimes = 0 } = {}) {
  const state = {
    connectCalls: 0,
    failTimes,                 // first N connectNative() calls throw (host missing)
    hostNames: [],
    ports: [],
    alarms: new Map(),
    alarmsCleared: [],
    badge: null,
    storage: {},
    messageListener: null,
    onStartup: null,
    sentFromWorker: [],        // messages the worker posts to the native host
    warned: [],
  };

  function makePort() {
    const p = {
      _msg: [],
      _disc: [],
      postMessage: (m) => state.sentFromWorker.push(m),
      disconnect: () => {},
    };
    p.onMessage = { addListener: (fn) => p._msg.push(fn) };
    p.onDisconnect = { addListener: (fn) => p._disc.push(fn) };
    return p;
  }

  const chrome = {
    runtime: {
      connectNative: (name) => {
        state.connectCalls += 1;
        state.hostNames.push(name);
        if (state.connectCalls <= state.failTimes) {
          throw new Error('Specified native messaging host not found.');
        }
        const p = makePort();
        state.ports.push(p);
        return p;
      },
      onMessage: { addListener: (fn) => { state.messageListener = fn; } },
      onStartup: { addListener: (fn) => { state.onStartup = fn; } },
      onInstalled: { addListener: () => {} },
      getPlatformInfo: async () => ({ os: 'win' }),
    },
    alarms: {
      create: (name, info) => { state.alarms.set(name, info); },
      clear: async (name) => { state.alarmsCleared.push(name); state.alarms.delete(name); return true; },
      onAlarm: { addListener: (fn) => { state.alarmListener = fn; } },
    },
    action: {
      setBadgeText: (o) => { state.badge = o.text; },
      setBadgeBackgroundColor: () => {},
    },
    storage: {
      local: {
        get: async (key) => {
          if (typeof key === 'string') return key in state.storage ? { [key]: state.storage[key] } : {};
          return { ...state.storage };
        },
        set: async (obj) => Object.assign(state.storage, obj),
      },
    },
  };

  const sandbox = {
    chrome,
    console: { log() {}, warn: (...a) => state.warned.push(a.join(' ')), error() {} },
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
      userAgentData: undefined,
      brave: { isBrave: async () => true },
    },
    crypto: globalThis.crypto,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error('no network in sim')),
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Evaluate only the libs the connection logic depends on.
  sandbox.importScripts = (...files) => {
    for (const f of files) {
      if (!/^lib\/(protocol|instance)\.js$/.test(f)) continue;
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
    }
  };

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
  return { state, sandbox };
}

// Drive the worker's runtime.onMessage listener like the popup does.
function sendMessage(h, msg) {
  return new Promise((resolve) => {
    let done = false;
    const respond = (v) => { if (!done) { done = true; resolve(v); } };
    const ret = h.state.messageListener(msg, {}, respond);
    if (ret !== true) respond(undefined);
  });
}

function lastPort(h) { return h.state.ports[h.state.ports.length - 1]; }

(async () => {
  console.log('== auto-connect: host registered (normal launch) ==');
  {
    const h = makeHarness({ failTimes: 0 });
    await sleep(60);
    check('connects by itself at service-worker start', h.state.connectCalls === 1, `connectCalls=${h.state.connectCalls}`);
    check('asks the host to start the MCP server', h.state.sentFromWorker.some((m) => m.type === 'start'), JSON.stringify(h.state.sentFromWorker));
    const port = h.state.sentFromWorker[0].payload.port;
    check('port is inside the bridge range', port >= 12306 && port < 12336, String(port));
    check('badge stays off until the server confirms', h.state.badge === '', `badge=${JSON.stringify(h.state.badge)}`);

    lastPort(h)._msg.forEach((fn) => fn({ type: 'server_started', payload: {} }));
    check('badge turns ON once the server is up', h.state.badge === 'ON', `badge=${JSON.stringify(h.state.badge)}`);
    // An auto-chosen port is deliberately NOT persisted: the next launch retries
    // this instance's deterministic default instead of ratcheting upward.
    check('auto-chosen port is not persisted', h.state.storage.bridgeMcpPort === undefined, String(h.state.storage.bridgeMcpPort));

    const status = await sendMessage(h, { type: 'bridge-status' });
    check('status reports connected + server running', status.connected === true && status.serverRunning === true, JSON.stringify(status));
    check('status reports no host error', !status.hostError, String(status.hostError));
  }

  console.log('== auto-connect: host NOT registered for this browser (the Brave bug) ==');
  {
    const h = makeHarness({ failTimes: 1 });   // first attempt throws, like an unregistered Brave
    await sleep(60);
    check('schedules a reconnect alarm instead of sitting offline', h.state.alarms.has('bridge-reconnect'), [...h.state.alarms.keys()].join(','));
    check('reports the failure to the popup', /\S/.test(h.state.warned.join(' ')));
    check('connected stays false right after the failure', h.sandbox.bridge.connected === false);

    await sleep(2200);                          // fast retry is ~1.5s, no user action
    check('retries on its own without any user action', h.state.connectCalls >= 2, `connectCalls=${h.state.connectCalls}`);
    check('gets connected on the retry', h.sandbox.bridge.connected === true);
    lastPort(h)._msg.forEach((fn) => fn({ type: 'server_started', payload: {} }));
    check('clears the reconnect alarm once connected', h.state.alarmsCleared.includes('bridge-reconnect'), h.state.alarmsCleared.join(','));
    check('badge turns ON after the self-heal', h.state.badge === 'ON', `badge=${JSON.stringify(h.state.badge)}`);
  }

  console.log('== auto-connect: recovery after the host dies ==');
  {
    const h = makeHarness({ failTimes: 0 });
    await sleep(60);
    const before = h.state.connectCalls;
    lastPort(h)._disc.forEach((fn) => fn());    // host process died
    check('disconnect flips connected to false', h.sandbox.bridge.connected === false);
    check('disconnect schedules the reconnect alarm', h.state.alarms.has('bridge-reconnect'));

    await sleep(2200);
    check('reconnects by itself after a disconnect', h.state.connectCalls > before, `connectCalls=${h.state.connectCalls}`);
  }

  console.log('== port handling: no ratchet, explicit pin sticks ==');
  {
    const h = makeHarness({ failTimes: 0 });
    await sleep(60);
    const before = h.sandbox.bridge.mcpPort;
    // The host reports the port is taken -> the worker moves to the next port.
    lastPort(h)._msg.forEach((fn) => fn({ type: 'error', payload: { message: 'Port 12306 is already running' } }));
    await sleep(700);                    // reallocatePort waits ~400ms before reconnecting
    check('moves to the next port on a collision', h.sandbox.bridge.mcpPort === before + 1, `${before} -> ${h.sandbox.bridge.mcpPort}`);
    check('an automatic move is NOT persisted', h.state.storage.bridgeMcpPort === undefined && h.state.storage.bridgePortPinned === undefined, JSON.stringify(h.state.storage));
    check('reconnects on the new port after moving', h.state.connectCalls >= 2, `connectCalls=${h.state.connectCalls}`);

    // A port the user typed in the popup, by contrast, must stick.
    const r = await sendMessage(h, { type: 'bridge-connect', port: 12330 });
    check('user-pinned port is honored', r.mcpPort === 12330 && h.sandbox.bridge.mcpPort === 12330, JSON.stringify(r));
    check('user-pinned port is persisted + flagged', h.state.storage.bridgeMcpPort === 12330 && h.state.storage.bridgePortPinned === true, JSON.stringify(h.state.storage));
  }

  console.log('== popup "ensure" path ==');
  {
    const h = makeHarness({ failTimes: 0 });
    await sleep(60);
    const before = h.state.connectCalls;
    const savedPort = h.state.storage.bridgeMcpPort;
    const r1 = await sendMessage(h, { type: 'bridge-ensure' });
    check('bridge-ensure is a no-op while already connected', r1.connected === true && h.state.connectCalls === before, JSON.stringify(r1));

    lastPort(h)._disc.forEach((fn) => fn());
    const r2 = await sendMessage(h, { type: 'bridge-ensure' });
    check('bridge-ensure reconnects a dropped host', r2.connected === true && h.state.connectCalls > before, JSON.stringify(r2));
    check('bridge-ensure never rewrites the saved port', h.state.storage.bridgeMcpPort === savedPort, String(h.state.storage.bridgeMcpPort));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
