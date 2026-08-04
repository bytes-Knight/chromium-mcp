#!/usr/bin/env node
// scripts/unit-sim-console.js — simulate the two console-capture content scripts
// in Node to prove the relay chain works without a live browser:
//   MAIN-world hook (console-capture-main.js) -> CustomEvent on window
//   -> isolated-world relay (console-capture.js) -> chrome.runtime.sendMessage
'use strict';
const fs = require('fs');
const path = require('path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'content', 'console-capture-main.js'), 'utf8');
const relaySrc = fs.readFileSync(path.join(__dirname, '..', 'content', 'console-capture.js'), 'utf8');

// ---- Minimal DOM/window mock -------------------------------------------------
class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
    this.message = init.message;
    this.error = init.error;
    this.reason = init.reason;
  }
}
class FakeWindow {
  constructor() {
    this._listeners = {};
    this.__captured = [];
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  dispatchEvent(ev) {
    for (const fn of this._listeners[ev.type] || []) fn(ev);
    return true;
  }
}
function makeRealConsole() {
  const c = {};
  ['log', 'warn', 'error', 'info', 'debug'].forEach((m) => { c[m] = (...a) => {}; });
  return c;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} — ${detail}`); }
}

// In a real browser both content scripts share the SAME DOM window (only the JS
// variable namespace differs per world). So we use one shared window object for
// both scripts, but give each world its own console + chrome.runtime.
const sharedWindow = new FakeWindow();

// ---- World A: MAIN world (page console lives here) ---------------------------
const mainConsole = makeRealConsole();
new Function('window', 'console', 'CustomEvent', mainSrc)(sharedWindow, mainConsole, FakeEvent);

// ---- World B: isolated world (relay + chrome.runtime bridge) -----------------
const relayConsole = makeRealConsole();
const messages = [];
const chromeMock = { runtime: { sendMessage: (msg) => { messages.push(msg); } } };
new Function('window', 'console', 'chrome', 'queueMicrotask', relaySrc)(sharedWindow, relayConsole, chromeMock, (f) => f());

// ---- Test 1: page console.log from MAIN world --------------------------------
messages.length = 0;
mainConsole.log('hello', 42);
mainConsole.warn({ a: 1 });
mainConsole.error(new Error('boom'));
check('page console.log/warn/error captured', messages.length === 3, `got ${messages.length}: ${JSON.stringify(messages.map((m) => m.text))}`);
if (messages[0]) check('level mapping log', messages[0].level === 'log' && messages[0].text === 'hello 42', JSON.stringify(messages[0]));
if (messages[2]) check('Error serialized as stack/message', /boom/.test(messages[2].text), messages[2].text);

// ---- Test 2: hook flags set --------------------------------------------------
check('main-world hook flag set', sharedWindow.__chromeMcpMainHooked === true, String(sharedWindow.__chromeMcpMainHooked));
check('relay flag set', sharedWindow.__chromeMcpConsoleRelay === true, String(sharedWindow.__chromeMcpConsoleRelay));

// ---- Test 3: window error / unhandledrejection --------------------------------
messages.length = 0;
sharedWindow.dispatchEvent(new FakeEvent('error', { message: 'page-throw' }));
sharedWindow.dispatchEvent(new FakeEvent('unhandledrejection', { reason: new Error('rej') }));
check('window.onerror + unhandledrejection captured', messages.length === 2, `got ${messages.length}`);
if (messages[0]) check('error source/level', messages[0].level === 'error' && /page-throw/.test(messages[0].text), JSON.stringify(messages[0]));

// ---- Test 4: relay queue doesn't drop rapid isolated-world logs ----------------
messages.length = 0;
for (let i = 0; i < 5; i++) relayConsole.log('iso-' + i);
check('no drop-throttle: 5 rapid isolated logs all delivered', messages.length === 5, `got ${messages.length}`);

// ---- Test 5: text truncation cap ---------------------------------------------
messages.length = 0;
mainConsole.log('x'.repeat(6000));
check('text capped at 4000', messages[0] && messages[0].text.length === 4000, `len=${messages[0] && messages[0].text.length}`);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
