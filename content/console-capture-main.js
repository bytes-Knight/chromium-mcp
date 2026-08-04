// content/console-capture-main.js — MAIN-world console hook.
// Runs at document_start in the MAIN world (declared with "world": "MAIN" in
// the manifest) so it overrides the console object page scripts actually use.
// Captured entries are relayed to the isolated-world content script via a
// window CustomEvent; that script forwards them to the background worker.
(() => {
  if (window.__chromeMcpMainHooked) return;
  window.__chromeMcpMainHooked = true;

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

  function push(level, args, source) {
    try {
      const text = args.map(stringify).join(' ');
      if (!text) return;
      window.dispatchEvent(new CustomEvent('__chromeMcpConsoleEntry', {
        detail: {
          level,
          text: text.slice(0, 4000),
          time: Date.now(),
          source,
        },
      }));
    } catch (e) { /* ignore */ }
  }

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };

  console.log = (...args) => { original.log(...args); push('log', args, 'console.log'); };
  console.warn = (...args) => { original.warn(...args); push('warn', args, 'console.warn'); };
  console.error = (...args) => { original.error(...args); push('error', args, 'console.error'); };
  console.info = (...args) => { original.info(...args); push('info', args, 'console.info'); };
  console.debug = (...args) => { original.debug(...args); push('debug', args, 'console.debug'); };

  window.addEventListener('error', (e) => {
    push('error', [e.message || String(e.error || 'error')], 'window.onerror');
  });
  window.addEventListener('unhandledrejection', (e) => {
    push('error', [e.reason ? (e.reason.message || String(e.reason)) : 'Unhandled rejection'], 'unhandledrejection');
  });
})();
