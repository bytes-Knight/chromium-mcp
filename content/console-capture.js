// content/console-capture.js — isolated-world relay for console capture.
//
// The actual page console (main world) is hooked by console-capture-main.js
// (a "world": "MAIN" content script); it dispatches a __chromeMcpConsoleEntry
// CustomEvent on window. This isolated-world script listens for those events
// and forwards every entry to the background worker via chrome.runtime.sendMessage.
//
// It ALSO hooks this isolated world's own console so that console calls made by
// injected isolated-world scripts are captured too.
(() => {
  if (window.__chromeMcpConsoleRelay) return;
  window.__chromeMcpConsoleRelay = true;

  function stringify(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message || String(a);
    try {
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch (e) {
      return String(a);
    }
  }

  function forward(level, text, time, source) {
    try {
      if (!text) return;
      // sendMessage returns a promise in MV3; handle rejection so it never
      // surfaces as an unhandled rejection (which the MAIN-world hook would
      // capture and re-relay, creating a feedback loop).
      chrome.runtime.sendMessage({
        type: 'console-entry',
        level,
        text: text.slice(0, 4000),
        time,
        source,
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  // 1) Relay entries coming from the MAIN-world hook.
  window.addEventListener('__chromeMcpConsoleEntry', (e) => {
    const d = (e && e.detail) || {};
    if (d.text) forward(d.level || 'log', d.text, d.time || Date.now(), d.source || 'page');
  });

  // 2) Capture console calls made from THIS isolated world (e.g. by injected
  //    isolated-world scripts). Dedupe identical bursts without dropping them:
  //    queue each message, then flush in a microtask. Every message is sent.
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };
  const pending = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const batch = pending.splice(0, pending.length);
    for (const m of batch) forward(m.level, m.text, m.time, m.source);
  };
  const queue = (level, args, source) => {
    try {
      const text = args.map(stringify).join(' ');
      if (!text) return;
      pending.push({ level, text: text.slice(0, 4000), time: Date.now(), source });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    } catch (e) { /* ignore */ }
  };

  console.log = (...args) => { original.log(...args); queue('log', args, 'console.log'); };
  console.warn = (...args) => { original.warn(...args); queue('warn', args, 'console.warn'); };
  console.error = (...args) => { original.error(...args); queue('error', args, 'console.error'); };
  console.info = (...args) => { original.info(...args); queue('info', args, 'console.info'); };
  console.debug = (...args) => { original.debug(...args); queue('debug', args, 'console.debug'); };
})();
