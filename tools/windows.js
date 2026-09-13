// tools/windows.js — window creation/management, arrangement, and tab zoom.
'use strict';

registerTool('chrome_new_window', async (args = {}) => {
  const { urls, url, incognito, focused, width, height, left, top, state } = args;
  const list = (Array.isArray(urls) ? urls : urls != null ? [urls] : url != null ? [url] : ['chrome://newtab/']).filter(Boolean);
  const createOpts = {
    url: list[0],
    focused: focused !== false,
  };
  if (incognito) createOpts.incognito = true;
  if (width != null) createOpts.width = Number(width);
  if (height != null) createOpts.height = Number(height);
  if (left != null) createOpts.left = Number(left);
  if (top != null) createOpts.top = Number(top);
  if (state) createOpts.state = state;

  const win = await chrome.windows.create(createOpts);
  const tabs = [];
  if (win.tabs && win.tabs.length) {
    for (const t of win.tabs) {
      tabs.push({ tabId: t.id, url: t.url, title: t.title, active: t.active, index: t.index });
    }
  }
  // Open remaining URLs as background tabs in the new window
  for (const u of list.slice(1)) {
    const t = await chrome.tabs.create({ url: u, active: false, windowId: win.id });
    tabs.push({ tabId: t.id, url: t.url, title: t.title, active: false, index: t.index });
  }
  return ok({
    windowId: win.id, state: win.state, incognito: win.incognito,
    focused: win.focused, tabs, count: tabs.length,
  });
});

registerTool('chrome_close_windows', async (args = {}) => {
  let ids = [];
  if (args.windowIds != null) {
    ids = (Array.isArray(args.windowIds) ? args.windowIds : [args.windowIds]).map(Number);
  } else if (args.windowId != null) {
    ids = [Number(args.windowId)];
  } else if (args.current) {
    const win = await chrome.windows.getLastFocused({});
    ids = [win.id];
  } else if (args.allExcept != null) {
    const keep = new Set((Array.isArray(args.allExcept) ? args.allExcept : [args.allExcept]).map(Number));
    const wins = await chrome.windows.getAll({});
    ids = wins.filter((w) => !keep.has(w.id)).map((w) => w.id);
  } else if (args.all) {
    const wins = await chrome.windows.getAll({});
    ids = wins.map((w) => w.id);
  }
  if (!ids.length) throw new Error('Provide windowIds, windowId, current, allExcept, or all');
  for (const id of ids) await chrome.windows.remove(id);
  return ok({ closedWindows: ids, count: ids.length });
});

registerTool('chrome_manage_window', async (args = {}) => {
  const windowId = args.windowId != null ? Number(args.windowId) : (await chrome.windows.getLastFocused({})).id;
  const upd = {};
  const VALID_STATES = ['normal', 'minimized', 'maximized', 'fullscreen'];
  if (args.state != null) {
    if (!VALID_STATES.includes(args.state)) throw new Error(`state must be one of: ${VALID_STATES.join(', ')}`);
    upd.state = args.state;
  }
  if (args.focused != null) upd.focused = !!args.focused;
  if (args.width != null) upd.width = Number(args.width);
  if (args.height != null) upd.height = Number(args.height);
  if (args.left != null) upd.left = Number(args.left);
  if (args.top != null) upd.top = Number(args.top);
  if (args.bounds && typeof args.bounds === 'object') {
    if (args.bounds.width != null) upd.width = Number(args.bounds.width);
    if (args.bounds.height != null) upd.height = Number(args.bounds.height);
    if (args.bounds.left != null) upd.left = Number(args.bounds.left);
    if (args.bounds.top != null) upd.top = Number(args.bounds.top);
  }
  if (!Object.keys(upd).length) throw new Error('Provide at least one of: state, focused, width, height, left, top, bounds');
  const win = await chrome.windows.update(windowId, upd);
  return ok({ windowId: win.id, state: win.state, focused: win.focused, left: win.left, top: win.top, width: win.width, height: win.height });
});

// Tile all (or the given) windows in a grid on the primary display.
registerTool('chrome_arrange_windows', async (args = {}) => {
  let wins = [];
  if (args.windowIds != null) {
    const ids = new Set((Array.isArray(args.windowIds) ? args.windowIds : [args.windowIds]).map(Number));
    const all = await chrome.windows.getAll({});
    wins = all.filter((w) => ids.has(w.id));
  } else {
    wins = await chrome.windows.getAll({});
  }
  wins = wins.filter((w) => w.type === 'normal');
  if (!wins.length) throw new Error('No normal windows to arrange');

  // Determine usable display area.
  let bounds = null;
  try {
    const displays = await chrome.system.display.getDisplayInfo();
    const primary = displays.find((d) => d.isPrimary) || displays[0];
    if (primary && primary.workArea) {
      bounds = { left: primary.workArea.left, top: primary.workArea.top, width: primary.workArea.width, height: primary.workArea.height };
    }
  } catch (e) { /* fall back to first window bounds */ }
  if (!bounds) {
    const ref = wins[0];
    bounds = { left: ref.left, top: ref.top, width: ref.width, height: ref.height };
  }

  const layout = args.layout || 'grid';
  const padding = args.padding != null ? Number(args.padding) : 4;
  const sorted = wins.slice().sort((a, b) => a.id - b.id);
  const N = sorted.length;
  let cells = [];

  if (layout === 'cascade') {
    const stepX = Math.max(40, Math.round(bounds.width * 0.05));
    const stepY = Math.max(30, Math.round(bounds.height * 0.05));
    const w = Math.round(bounds.width / Math.max(2, Math.min(N, 4)));
    const h = Math.round(bounds.height / Math.max(2, Math.min(N, 4)));
    for (let i = 0; i < N; i++) {
      cells.push({ left: bounds.left + i * stepX, top: bounds.top + i * stepY, width: w, height: h });
    }
  } else if (layout === 'vertical') {
    const w = Math.round(bounds.width / N);
    for (let i = 0; i < N; i++) {
      cells.push({ left: bounds.left + i * w, top: bounds.top, width: w, height: bounds.height });
    }
  } else if (layout === 'horizontal') {
    const h = Math.round(bounds.height / N);
    for (let i = 0; i < N; i++) {
      cells.push({ left: bounds.left, top: bounds.top + i * h, width: bounds.width, height: h });
    }
  } else { // grid
    const cols = Math.ceil(Math.sqrt(N));
    const rows = Math.ceil(N / cols);
    const cw = Math.round(bounds.width / cols);
    const ch = Math.round(bounds.height / rows);
    for (let i = 0; i < N; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      cells.push({ left: bounds.left + c * cw, top: bounds.top + r * ch, width: cw, height: ch });
    }
  }

  const arranged = [];
  for (let i = 0; i < sorted.length; i++) {
    const cell = cells[i];
    const win = await chrome.windows.update(sorted[i].id, {
      state: 'normal',
      left: cell.left + padding,
      top: cell.top + padding,
      width: Math.max(200, cell.width - padding * 2),
      height: Math.max(150, cell.height - padding * 2),
      focused: i === 0,
    });
    arranged.push({ windowId: win.id, left: win.left, top: win.top, width: win.width, height: win.height });
  }
  return ok({ layout, count: arranged.length, arranged });
});

registerTool('chrome_zoom', async (args = {}) => {
  const tab = await resolveTab(args);
  const { factor, zoomIn, zoomOut, reset } = args;
  let target;
  if (reset) {
    await chrome.tabs.setZoom(tab.id, 1);
    target = 1;
  } else if (factor != null) {
    target = Math.min(5, Math.max(0.25, Number(factor)));
    await chrome.tabs.setZoom(tab.id, target);
  } else if (zoomIn) {
    const current = await chrome.tabs.getZoom(tab.id);
    target = Math.min(5, Math.round((current + 0.1) * 100) / 100);
    await chrome.tabs.setZoom(tab.id, target);
  } else if (zoomOut) {
    const current = await chrome.tabs.getZoom(tab.id);
    target = Math.max(0.25, Math.round((current - 0.1) * 100) / 100);
    await chrome.tabs.setZoom(tab.id, target);
  } else {
    target = await chrome.tabs.getZoom(tab.id);
  }
  const final = await chrome.tabs.getZoom(tab.id);
  return ok({ tabId: tab.id, factor: final, requested: target });
});
