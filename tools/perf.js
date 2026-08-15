// tools/perf.js — performance tracing via CDP Tracing domain.
// Replaces the earlier not-implemented stubs with a real recorder.
'use strict';

let traceSession = null; // { tabId, events, attached, categories, traceName, completePromise }
let lastTraceEvents = null; // events from the most recently stopped trace (for analysis after stop)

const TRACE_CATEGORIES = [
  'devtools.timeline',
  'v8.execute',
  'blink.user_timing',
  'loading',
  'navigation',
  'disabled-by-default-devtools.timeline',
];

registerTool('performance_start_trace', async (args = {}) => {
  if (traceSession) throw new Error('A trace is already running; call performance_stop_trace first');
  const tab = await resolveTab(args);
  const categories = Array.isArray(args.categories) && args.categories.length
    ? args.categories
    : TRACE_CATEGORIES;

  const session = {
    tabId: tab.id,
    events: [],
    categories,
    attached: false,
    traceName: args.name || `trace-${Date.now()}`,
  };

  session.onEvent = (debuggee, method, params) => {
    if (!debuggee || debuggee.tabId !== tab.id) return;
    if (method === 'Tracing.dataCollected' && Array.isArray(params.value)) {
      session.events.push(...params.value);
    } else if (method === 'Tracing.tracingComplete') {
      if (session.completeResolve) { session.completeResolve(); session.completeResolve = null; }
    }
  };

  try {
    await cdpAttach(tab.id);
    session.attached = true;
    chrome.debugger.onEvent.addListener(session.onEvent);
    await cdpSend(tab.id, 'Page.enable', {});
    // Note: there is no Tracing.enable in CDP — Tracing.start is the only
    // entry point for the Tracing domain.
    await cdpSend(tab.id, 'Tracing.start', {
      traceConfig: {
        recordMode: 'record-until-full',
        includedCategories: categories,
      },
    });
  } catch (e) {
    if (session.attached) {
      try { chrome.debugger.onEvent.removeListener(session.onEvent); } catch (e2) { /* ignore */ }
      try { await cdpDetach(tab.id); } catch (e2) { /* ignore */ }
    }
    throw e;
  }

  session.completePromise = new Promise((resolve) => { session.completeResolve = resolve; });
  traceSession = session;

  if (args.reload) {
    try { await cdpSend(tab.id, 'Page.reload', { ignoreCache: true }); } catch (e) { /* ignore */ }
  }
  if (args.autoStop) {
    const durationMs = args.durationMs != null ? Number(args.durationMs) : 5000;
    setTimeout(() => { stopTrace({ saveToDownloads: true }).catch(() => {}); }, Math.min(durationMs, 120000));
  }

  return ok({
    tabId: tab.id,
    started: true,
    autoStop: !!args.autoStop,
    reload: !!args.reload,
    categories,
    traceName: session.traceName,
  });
});

registerTool('performance_stop_trace', async (args = {}) => {
  const result = await stopTrace(args);
  return ok(result);
});

async function stopTrace(args = {}) {
  const session = traceSession;
  if (!session) return { stopped: false, error: 'No active trace; call performance_start_trace first' };
  traceSession = null;

  const saveToDownloads = args.saveToDownloads !== false;

  try {
    await withTimeout(cdpSend(session.tabId, 'Tracing.end', {}), 5000, 'Tracing.end timed out');
  } catch (e) { /* already stopped */ }

  try {
    if (session.completePromise) await withTimeout(session.completePromise, 15000, 'Waiting for trace data timed out');
  } catch (e) { /* use what we have */ }

  if (session.attached) {
    try { await cdpSend(session.tabId, 'Tracing.disable', {}); } catch (e) { /* ignore */ }
    if (session.onEvent) chrome.debugger.onEvent.removeListener(session.onEvent);
    try { await cdpDetach(session.tabId); } catch (e) { /* ignore */ }
  }

  const events = session.events;
  lastTraceEvents = events;
  const summary = analyzeTrace(events);
  const traceJson = JSON.stringify({
    traceEvents: events,
    metadata: {
      name: session.traceName,
      startedAt: Date.now(),
      categories: session.categories,
      tabId: session.tabId,
    },
  });

  let saved = null;
  if (saveToDownloads) {
    try {
      const prefix = args.filenamePrefix || session.traceName;
      const blob = new Blob([traceJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const id = await chrome.downloads.download({ url, filename: `${prefix}.json`, saveAs: false });
      saved = { downloadId: id, filename: `${prefix}.json`, bytes: traceJson.length };
    } catch (e) {
      saved = { error: String(e.message || e) };
    }
  }

  return {
    stopped: true,
    tabId: session.tabId,
    traceName: session.traceName,
    eventCount: events.length,
    summary,
    saved,
    base64: args.includeBase64 ? btoa(unescape(encodeURIComponent(traceJson))) : undefined,
  };
}

registerTool('performance_analyze_insight', async (args = {}) => {
  // Analyze the most recent trace data — works both during an active trace
  // (live, incremental) and after the trace has been stopped.
  const events = (traceSession && traceSession.events.length ? traceSession.events : null) || lastTraceEvents;
  if (!events || !events.length) {
    return err('No trace data available. Run performance_start_trace then performance_stop_trace first.');
  }
  return ok(analyzeTrace(events));
});

// Lightweight trace summary: duration, per-category counts, slow tasks, and the
// most expensive events by duration.
function analyzeTrace(events) {
  if (!events || !events.length) {
    return { eventCount: 0, durationMs: 0, categories: {}, slowTasks: 0, note: 'No trace events collected' };
  }
  const byCat = {};
  let minTs = Infinity;
  let maxTs = -Infinity;
  let slowTasks = 0;
  const durations = [];
  for (const ev of events) {
    const cat = ev.cat || 'unknown';
    byCat[cat] = (byCat[cat] || 0) + 1;
    const ts = ev.ts != null ? Number(ev.ts) : 0;
    if (ts > 0) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    if (ev.ph === 'X' && ev.dur != null) {
      const durMs = Number(ev.dur) / 1000;
      durations.push({ name: ev.name || '?', durMs });
      if (durMs > 50) slowTasks++;
    }
  }
  durations.sort((a, b) => b.durMs - a.durMs);
  return {
    eventCount: events.length,
    durationMs: maxTs > minTs && maxTs !== Infinity ? Math.round((maxTs - minTs) / 1000) : 0,
    categories: byCat,
    slowTasks,
    topEvents: durations.slice(0, 15),
  };
}
