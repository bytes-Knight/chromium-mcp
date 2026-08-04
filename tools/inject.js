// tools/inject.js — content-script injection + command dispatch tools.
'use strict';

registerTool('chrome_inject_script', async (args = {}) => {
  if (!args.jsScript) throw new Error('jsScript is required');
  const tab = await resolveTab(args);
  const world = args.type === 'MAIN' ? 'MAIN' : 'ISOLATED';
  const script = args.jsScript;

  const result = await executeInTab(tab.id, function (src) {
    const scriptEl = document.createElement('script');
    scriptEl.textContent = src;
    (document.head || document.documentElement).appendChild(scriptEl);
    scriptEl.remove();
    return { ok: true, injected: true };
  }, [script], { world });

  const state = getTabState(tab.id);
  state.injected.add(script.slice(0, 64));

  // If the script exposes a listener API, register it for send_command
  await executeInTab(tab.id, function (src) {
    try {
      if (typeof window.__chromeMcpListeners === 'undefined') {
        window.__chromeMcpListeners = {};
        window.addEventListener('chromeMcpCommand', (e) => {
          const { eventName, payload } = e.detail || {};
          if (eventName && typeof window.__chromeMcpListeners[eventName] === 'function') {
            window.__chromeMcpListeners[eventName](payload);
          }
        });
      }
      // Evaluate the user script so it can register listeners
      try {
        // eslint-disable-next-line no-new-func
        new Function('window', src)(window);
      } catch (e) { /* script may already be running */ }
    } catch (e) { /* ignore */ }
  }, [script], { world }).catch(() => {});

  return ok({ tabId: tab.id, world, injected: true });
});

registerTool('chrome_send_command_to_inject_script', async (args = {}) => {
  const tab = await resolveTab(args);
  if (!args.eventName) throw new Error('eventName is required');
  let payload = args.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (e) { /* keep as string */ }
  }
  await executeInTab(tab.id, function (eventName, payload) {
    window.dispatchEvent(new CustomEvent('chromeMcpCommand', { detail: { eventName, payload } }));
    return { ok: true };
  }, [args.eventName, payload]);
  return ok({ tabId: tab.id, eventName: args.eventName, delivered: true });
});
