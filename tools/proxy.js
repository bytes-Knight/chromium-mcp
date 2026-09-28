// tools/proxy.js — route the whole browser through a local intercepting proxy.
//
// Bug-bounty hunting needs EVERY browser request to land in the interceptor
// (Caido default: http://127.0.0.1:9999), not just the tabs mcpctl explicitly
// captures. chrome.proxy.settings with a fixed_servers config does this at the
// network-stack level, so it covers XHR/fetch, subresources, navigations,
// service workers, WebSockets and third-party iframes alike — no per-tab wiring.
//
// The chosen config is persisted in chrome.storage.local so a browser restart
// (or a service-worker respawn) re-applies it instead of silently dropping out
// of interception mid-hunt.
'use strict';

const PROXY_STORE_KEY = 'interceptProxy';

const DEFAULT_PROXY = {
  host: '127.0.0.1',
  port: 9999,
  scheme: 'http',
  scope: 'regular',
  // Never send the interceptor's own control traffic through itself.
  bypassList: ['localhost', '127.0.0.1', '[::1]', '*.local'],
};

function proxySupported() {
  return !!(chrome && chrome.proxy && chrome.proxy.settings);
}

async function readProxyConfig() {
  try {
    const got = await chrome.storage.local.get(PROXY_STORE_KEY);
    return got && got[PROXY_STORE_KEY] ? got[PROXY_STORE_KEY] : null;
  } catch (e) {
    return null;
  }
}

async function writeProxyConfig(cfg) {
  try {
    await chrome.storage.local.set({ [PROXY_STORE_KEY]: cfg });
  } catch (e) { /* non-fatal */ }
}

function normalizePort(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) throw new Error(`Invalid proxy port: ${v}`);
  return n;
}

function buildValue(cfg) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: cfg.scheme || 'http', host: cfg.host, port: cfg.port },
      bypassList: Array.isArray(cfg.bypassList) ? cfg.bypassList.slice() : [],
    },
  };
}

// Best-effort liveness probe of the interceptor port. A closed port fails fast
// (connection refused), so this stays cheap; it is only used to warn, never to
// silently block enabling interception.
async function probeProxy(cfg, timeoutMs = 1500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    await fetch(`http://${cfg.host}:${cfg.port}/`, { method: 'GET', signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    return true;
  } catch (e) {
    // An HTTP error status still proves something is listening on the port.
    return /Failed to fetch|NetworkError|aborted|AbortError/i.test(String(e && e.message || e)) ? false : true;
  }
}

async function currentSettings() {
  if (!proxySupported()) return null;
  const s = await chrome.proxy.settings.get({ incognito: false });
  return s && s.value ? s.value : null;
}

registerTool('chrome_proxy', async (args = {}) => {
  const action = String(args.action || (args.enabled === false ? 'off' : 'on')).toLowerCase();

  if (!proxySupported()) {
    return err('The chrome.proxy API is unavailable in this browser — interception cannot be toggled from the extension here. Launch the browser with --proxy-server=127.0.0.1:9999 instead.');
  }

  if (action === 'status' || action === 'get') {
    const stored = await readProxyConfig();
    const value = await currentSettings();
    let reachable = null;
    if (stored) reachable = await probeProxy(stored);
    return ok({
      enabled: !!(value && value.mode === 'fixed_servers'),
      mode: value && value.mode,
      host: stored && stored.host,
      port: stored && stored.port,
      scheme: stored && stored.scheme,
      bypassList: stored && stored.bypassList,
      reachable,
      activeRules: value && value.rules ? value.rules : null,
    });
  }

  if (action === 'off' || action === 'clear' || action === 'disable') {
    await chrome.proxy.settings.clear({ scope: args.scope || DEFAULT_PROXY.scope });
    const stored = await readProxyConfig();
    if (stored) await writeProxyConfig({ ...stored, enabled: false });
    return ok({ enabled: false, message: 'Proxy cleared — browser is back on its direct connection.' });
  }

  if (action !== 'on' && action !== 'set' && action !== 'enable') {
    return err(`Unknown action "${args.action}" — use on | off | status.`);
  }

  const prev = (await readProxyConfig()) || {};
  const cfg = {
    ...DEFAULT_PROXY,
    ...prev,
    host: args.host || args.proxyHost || prev.host || DEFAULT_PROXY.host,
    scheme: args.scheme || prev.scheme || DEFAULT_PROXY.scheme,
    scope: args.scope || prev.scope || DEFAULT_PROXY.scope,
    port: args.port ? normalizePort(args.port) : (prev.port || DEFAULT_PROXY.port),
    bypassList: Array.isArray(args.bypassList) ? args.bypassList : (prev.bypassList || DEFAULT_PROXY.bypassList),
  };

  const reachable = await probeProxy(cfg);
  if (!reachable && !args.force) {
    // Do not hard-fail: the interceptor may be starting up. Report the state so
    // the caller can decide, and keep the previous config untouched.
    await writeProxyConfig({ ...cfg, enabled: false });
    return ok({
      enabled: false,
      reachable: false,
      host: cfg.host,
      port: cfg.port,
      warning: `Nothing answered on ${cfg.host}:${cfg.port} — interception left DISABLED so browsing keeps working. Start the interceptor, then retry, or pass force:true.`,
    });
  }

  await chrome.proxy.settings.set({ value: buildValue(cfg), scope: cfg.scope });
  await writeProxyConfig({ ...cfg, enabled: true });

  const verify = await currentSettings();
  return ok({
    enabled: !!(verify && verify.mode === 'fixed_servers'),
    reachable,
    host: cfg.host,
    port: cfg.port,
    scheme: cfg.scheme,
    bypassList: cfg.bypassList,
    message: `All browser traffic is now routed through ${cfg.scheme}://${cfg.host}:${cfg.port} — it appears in the interceptor's history.`,
  });
});

// Re-apply the saved config when the browser starts or the worker is respawned
// while interception is supposed to be on. Silent on failure: never break a
// browsing session because the interceptor happens to be offline.
globalThis.reapplyInterceptProxy = async function reapplyInterceptProxy() {
  try {
    if (!proxySupported()) return;
    const cfg = await readProxyConfig();
    if (!cfg || !cfg.enabled) return;
    await chrome.proxy.settings.set({ value: buildValue(cfg), scope: cfg.scope || 'regular' });
  } catch (e) { /* ignore */ }
};

if (chrome && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => { globalThis.reapplyInterceptProxy(); });
}
