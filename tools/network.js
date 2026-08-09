// tools/network.js — network request + capture tools.
'use strict';

registerTool('chrome_network_request', async (args = {}) => {
  if (!args.url) throw new Error('url is required');
  const tab = await resolveTab(args);
  const result = await executeInTab(tab.id, function (url, method, headers, body, timeout, formData) {
    return (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout || 30000);
      try {
        let finalBody = body;
        if (formData && typeof formData === 'object') {
          const fd = new FormData();
          if (formData.fields) {
            for (const [k, v] of Object.entries(formData.fields)) fd.append(k, String(v));
          }
          finalBody = fd;
        }
        const res = await fetch(url, {
          method: method || 'GET',
          headers: headers || {},
          body: finalBody,
          credentials: 'include',
          signal: controller.signal,
          redirect: 'follow',
        });
        const text = await res.text();
        const respHeaders = {};
        res.headers.forEach((v, k) => { respHeaders[k] = v; });
        return {
          ok: true,
          status: res.status,
          statusText: res.statusText,
          url: res.url,
          redirected: res.redirected,
          headers: respHeaders,
          body: text.slice(0, 500000),
        };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      } finally {
        clearTimeout(timer);
      }
    })();
  }, [args.url, args.method, args.headers || null, args.body || null, args.timeout, args.formData || null]);

  if (!result.ok) return err(result.error || 'Request failed');
  return ok(result);
});

// ---- Network capture (webRequest-based, optional response bodies via debugger)
let captureSessions = new Map(); // tabId -> session

registerTool('chrome_network_capture', async (args = {}) => {
  const action = args.action;
  const tab = await resolveTab(args);
  const tabId = tab.id;

  if (action === 'start') {
    if (captureSessions.has(tabId)) return err('Capture already running for this tab; call stop first');
    const session = {
      entries: [],
      startedAt: Date.now(),
      needResponseBody: !!args.needResponseBody,
      includeStatic: !!args.includeStatic,
      maxCaptureTime: args.maxCaptureTime || 180000,
      inactivityTimeout: args.inactivityTimeout || 60000,
      lastActivity: Date.now(),
      filterUrl: args.url || null,
      bodyByRequestId: new Map(),
      debuggerAttached: false,
    };
    captureSessions.set(tabId, session);

    const record = (details) => {
      if (session.filterUrl) {
        let href = details.url;
        try { href = new URL(details.url).href; } catch (e) { /* keep raw */ }
        if (!href.includes(session.filterUrl)) return;
      }
      const existing = session.entries.find((e) => e.requestId === details.requestId);
      if (existing) Object.assign(existing, details);
      else session.entries.push({ requestId: details.requestId, url: details.url, ...details });
      session.lastActivity = Date.now();
    };
    session.listener = (details) => record(details);
    session.completedListener = (details) => record(details);

    chrome.webRequest.onBeforeRequest.addListener(session.listener, { urls: ['<all_urls>'] });
    chrome.webRequest.onCompleted.addListener(session.completedListener, { urls: ['<all_urls>'] });
    chrome.webRequest.onErrorOccurred.addListener(session.listener, { urls: ['<all_urls>'] });

    if (session.needResponseBody) {
      try {
        await cdpAttach(tabId);
        session.debuggerAttached = true;
        session.bodyByRequestId = new Map();
        session.networkEvents = (debuggee, method, params) => {
          if (debuggee.tabId !== tabId) return;
          if (method === 'Network.loadingFinished') {
            cdpSend(tabId, 'Network.getResponseBody', { requestId: params.requestId })
              .then((r) => session.bodyByRequestId.set(params.requestId, r.body || null))
              .catch(() => {});
          } else if (method === 'Network.responseReceived') {
            const e = session.entries.find((x) => x.requestId === params.response.requestId);
            if (e) e.status = params.response.status;
          }
        };
        chrome.debugger.onEvent.addListener(session.networkEvents);
        await cdpSend(tabId, 'Network.enable', {});
      } catch (e) {
        session.needResponseBody = false;
      }
    }

    // Auto-stop timers
    session.maxTimer = setTimeout(() => { runNetworkStop(tabId); }, session.maxCaptureTime);
    session.inactivityTimer = setInterval(() => {
      if (Date.now() - session.lastActivity > session.inactivityTimeout) runNetworkStop(tabId);
    }, 5000);

    return ok({ action: 'started', tabId, captureStartedAt: session.startedAt });
  }

  if (action === 'stop') {
    return ok(await runNetworkStop(tabId));
  }

  return err('action must be "start" or "stop"');
});

async function runNetworkStop(tabId) {
  const session = captureSessions.get(tabId);
  if (!session) return { action: 'stopped', entries: [], count: 0, note: 'No active capture' };

  if (session.listener) chrome.webRequest.onBeforeRequest.removeListener(session.listener);
  if (session.completedListener) chrome.webRequest.onCompleted.removeListener(session.completedListener);
  if (session.listener) chrome.webRequest.onErrorOccurred.removeListener(session.listener);
  clearTimeout(session.maxTimer);
  clearInterval(session.inactivityTimer);

  if (session.debuggerAttached) {
    if (session.networkEvents) chrome.debugger.onEvent.removeListener(session.networkEvents);
    await cdpDetach(tabId);
  }

  const STATIC_RE = /\.(png|jpe?g|gif|svg|webp|css|woff2?|ttf|eot|ico|mp4|webm|mp3|avif|js)(\?|#|$)/i;
  let entries = session.entries.map((e) => {
    const body = session.bodyByRequestId.get(e.requestId);
    const out = {
      url: e.url,
      method: e.method || 'GET',
      status: e.statusCode || e.status || null,
      type: e.type || null,
      requestId: e.requestId,
      fromCache: e.fromCache || false,
      ip: e.ip || null,
      timeStamp: e.timeStamp,
      requestHeaders: e.requestHeaders || null,
      responseHeaders: e.responseHeaders || null,
    };
    if (session.needResponseBody) out.body = body || null;
    return out;
  });
  if (!session.includeStatic) entries = entries.filter((e) => !STATIC_RE.test(e.url));
  entries.sort((a, b) => (a.timeStamp || 0) - (b.timeStamp || 0));

  captureSessions.delete(tabId);
  return { action: 'stopped', tabId, count: entries.length, entries };
}
