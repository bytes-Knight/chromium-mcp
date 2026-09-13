// tools/browser.js — window/tab management and navigation tools.
'use strict';

registerTool('get_windows_and_tabs', async () => {
  const windows = await chrome.windows.getAll({ populate: true });
  const data = windows.map((w) => ({
    id: w.id,
    focused: w.focused,
    type: w.type,
    state: w.state,
    incognito: w.incognito,
    tabs: (w.tabs || []).map((t) => ({
      id: t.id,
      index: t.index,
      active: t.active,
      pinned: t.pinned,
      url: t.url,
      title: t.title,
      favIconUrl: t.favIconUrl,
      audible: t.audible,
      muted: t.mutedInfo ? t.mutedInfo.muted : false,
      groupId: t.groupId || -1,
      windowId: t.windowId,
    })),
  }));
  return ok(data);
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
registerTool('chrome_navigate', async (args = {}) => {
  const { url, newWindow, newTab, background, width, height, refresh } = args;
  const tabId = args.tabId != null ? args.tabId : null;
  const windowId = args.windowId != null ? args.windowId : null;

  if (refresh || !url) {
    const tab = await resolveTab({ tabId, windowId });
    await chrome.tabs.reload(tab.id);
    await waitForTabComplete(tab.id, 30000);
    const reloaded = await chrome.tabs.get(tab.id);
    return ok({ tabId: reloaded.id, url: reloaded.url, title: reloaded.title, refreshed: true });
  }

  if (url === 'back' || url === 'forward') {
    const tab = await resolveTab({ tabId, windowId });
    if (url === 'back') await chrome.tabs.goBack(tab.id);
    else await chrome.tabs.goForward(tab.id);
    await waitForTabComplete(tab.id, 30000);
    const nav = await chrome.tabs.get(tab.id);
    return ok({ tabId: nav.id, url: nav.url, title: nav.title, navigation: url });
  }

  if (newTab) {
    const opened = await openTabsImpl({ urls: [url], active: !background, windowId });
    return ok({ tabId: opened.opened[0].id, url: opened.opened[0].url, title: opened.opened[0].title, newTab: true });
  }

  if (newWindow || (width != null) || (height != null)) {
    const win = await chrome.windows.create({
      url,
      focused: !background,
      width: width || 1280,
      height: height || 720,
    });
    const tab = win.tabs && win.tabs[0];
    await waitForTabComplete(tab.id, 30000);
    const final = tab ? await chrome.tabs.get(tab.id) : null;
    return ok({
      tabId: final ? final.id : null,
      windowId: win.id,
      url: final ? final.url : url,
      title: final ? final.title : null,
      newWindow: true,
    });
  }

  const tab = await resolveTab({ tabId, windowId });
  await navigateTab(tab, url, { background });
  const updated = await chrome.tabs.get(tab.id);
  return ok({ tabId: updated.id, url: updated.url, title: updated.title });
});

// ---------------------------------------------------------------------------
// Opening / duplicating / reloading / discarding
// ---------------------------------------------------------------------------
async function openTabsImpl(args = {}) {
  const { urls, url, active, background, pinned, index, windowId } = args;
  const list = (Array.isArray(urls) ? urls : urls != null ? [urls] : url != null ? [url] : []).filter(Boolean);
  if (!list.length) throw new Error('urls (or url) is required');

  let winId = windowId != null ? Number(windowId) : null;
  if (winId == null) {
    try {
      const win = await chrome.windows.getLastFocused({ populate: false });
      winId = win && win.id != null ? win.id : undefined;
    } catch (e) { /* fall back to undefined */ }
  }

  const firstActive = !background && active !== false;
  const created = [];
  for (let i = 0; i < list.length; i++) {
    const opts = {
      url: list[i],
      active: i === 0 ? firstActive : false,
      pinned: !!pinned,
    };
    if (winId != null) opts.windowId = winId;
    if (i === 0 && index != null) opts.index = index;
    const tab = await chrome.tabs.create(opts);
    const t = await chrome.tabs.get(tab.id);
    created.push({ id: t.id, url: t.url, title: t.title, pinned: t.pinned, active: t.active, windowId: t.windowId });
  }
  return { opened: created, count: created.length, windowId: winId != null ? winId : created[0] ? created[0].windowId : null };
}

registerTool('chrome_open_tabs', async (args = {}) => {
  const result = await openTabsImpl(args);
  return ok(result);
});

registerTool('chrome_duplicate_tabs', async (args = {}) => {
  const ids = await resolveTabIds(args);
  if (!ids.length) throw new Error('No tabs to duplicate');
  const duplicated = [];
  for (const id of ids) {
    const tab = await chrome.tabs.duplicate(id);
    duplicated.push({ id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId, active: tab.active });
  }
  return ok({ duplicated, count: duplicated.length });
});

registerTool('chrome_reload_tabs', async (args = {}) => {
  const ids = await resolveTabIds(args);
  if (!ids.length) throw new Error('No tabs to reload');
  const bypassCache = !!args.bypassCache;
  const wait = !!args.waitForComplete;
  const results = [];
  for (const id of ids) {
    try {
      await chrome.tabs.reload(id, { bypassCache });
      if (wait) await waitForTabComplete(id, args.timeout || 30000);
      const tab = await chrome.tabs.get(id);
      results.push({ tabId: id, url: tab.url, ok: true });
    } catch (e) {
      results.push({ tabId: id, ok: false, error: String(e.message || e) });
    }
  }
  return ok({ reloaded: results, count: results.length, bypassCache });
});

registerTool('chrome_discard_tabs', async (args = {}) => {
  const ids = await resolveTabIds(args);
  if (!ids.length) throw new Error('No tabs to discard');
  const results = [];
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.discard(id);
      results.push({ tabId: id, ok: true, discarded: true, url: tab.url });
    } catch (e) {
      results.push({ tabId: id, ok: false, error: String(e.message || e) });
    }
  }
  return ok({ discarded: results, count: results.length });
});

// ---------------------------------------------------------------------------
// Pin / mute
// ---------------------------------------------------------------------------
registerTool('chrome_pin_tabs', async (args = {}) => {
  const ids = await resolveTabIds(args);
  if (!ids.length) throw new Error('No tabs to pin');
  const results = [];
  for (const id of ids) {
    const tab = await chrome.tabs.update(id, { pinned: true });
    results.push({ tabId: id, url: tab.url, pinned: true });
  }
  return ok({ pinned: results, count: results.length });
});

registerTool('chrome_unpin_tabs', async (args = {}) => {
  const ids = await resolveTabIds(args);
  if (!ids.length) throw new Error('No tabs to unpin');
  const results = [];
  for (const id of ids) {
    const tab = await chrome.tabs.update(id, { pinned: false });
    results.push({ tabId: id, url: tab.url, pinned: false });
  }
  return ok({ unpinned: results, count: results.length });
});

registerTool('chrome_mute_tabs', async (args = {}) => {
  const ids = await resolveTabIds(args);
  if (!ids.length) throw new Error('No tabs to mute');
  const results = [];
  for (const id of ids) {
    const tab = await chrome.tabs.update(id, { muted: true });
    results.push({ tabId: id, url: tab.url, muted: true });
  }
  return ok({ muted: results, count: results.length });
});

registerTool('chrome_unmute_tabs', async (args = {}) => {
  const ids = await resolveTabIds(args);
  if (!ids.length) throw new Error('No tabs to unmute');
  const results = [];
  for (const id of ids) {
    const tab = await chrome.tabs.update(id, { muted: false });
    results.push({ tabId: id, url: tab.url, muted: false });
  }
  return ok({ unmuted: results, count: results.length });
});

// ---------------------------------------------------------------------------
// Moving / grouping
// ---------------------------------------------------------------------------
registerTool('chrome_move_tabs', async (args = {}) => {
  const ids = await resolveTabIds(args);
  if (!ids.length) throw new Error('No tabs to move');
  const moveOpts = {};
  if (args.windowId != null) moveOpts.windowId = Number(args.windowId);
  if (args.index != null) moveOpts.index = Number(args.index);
  const tabs = await chrome.tabs.move(ids, moveOpts);
  const list = (Array.isArray(tabs) ? tabs : [tabs]).map((t) => ({
    tabId: t.id, url: t.url, title: t.title, windowId: t.windowId, index: t.index,
  }));
  return ok({ moved: list, count: list.length });
});

registerTool('chrome_group_tabs', async (args = {}) => {
  const ids = await resolveTabIds(args);
  if (!ids.length) throw new Error('No tabs to group');
  const groupOpts = { tabIds: ids };
  if (args.groupId != null) groupOpts.groupId = Number(args.groupId);
  if (args.windowId != null) groupOpts.createProperties = { windowId: Number(args.windowId) };
  const groupId = await chrome.tabs.group(groupOpts);
  const group = { id: groupId };
  if (args.title != null || args.color != null) {
    const upd = {};
    if (args.title != null) upd.title = String(args.title);
    if (args.color != null) upd.color = args.color;
    try {
      const updated = await chrome.tabGroups.update(groupId, upd);
      group.title = updated.title;
      group.color = updated.color;
    } catch (e) { /* color may be invalid */ }
  }
  const tabs = await chrome.tabs.query({ groupId });
  return ok({
    groupId,
    title: group.title != null ? group.title : null,
    color: group.color != null ? group.color : null,
    tabs: tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, index: t.index })),
    count: tabs.length,
  });
});

registerTool('chrome_ungroup_tabs', async (args = {}) => {
  let ids = [];
  if (args.groupId != null) {
    const tabs = await chrome.tabs.query({ groupId: Number(args.groupId) });
    ids = tabs.map((t) => t.id);
  } else {
    ids = await resolveTabIds(args);
  }
  if (!ids.length) return ok({ ungrouped: [], count: 0 });
  await chrome.tabs.ungroup(ids);
  return ok({ ungrouped: ids, count: ids.length });
});

registerTool('chrome_tab_groups', async (args = {}) => {
  const groups = await chrome.tabGroups.query({});
  const out = [];
  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    out.push({
      groupId: g.id,
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
      windowId: g.windowId,
      tabs: tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, index: t.index })),
    });
  }
  return ok({ count: out.length, groups: out });
});

// ---------------------------------------------------------------------------
// Searching / details
// ---------------------------------------------------------------------------
registerTool('chrome_search_tabs', async (args = {}) => {
  const query = args.query || args.text || '';
  const maxResults = args.maxResults || 100;
  const tabs = await chrome.tabs.query({});
  let matches = tabs;
  if (args.windowId != null) matches = matches.filter((t) => t.windowId === Number(args.windowId));
  if (args.pinned != null) matches = matches.filter((t) => t.pinned === !!args.pinned);
  if (args.audible != null) matches = matches.filter((t) => !!t.audible === !!args.audible);
  if (query) {
    const q = query.toLowerCase();
    matches = matches.filter((t) => {
      const inTitle = (t.title || '').toLowerCase().includes(q);
      const inUrl = (t.url || '').toLowerCase().includes(q);
      const inHost = (() => {
        try { return new URL(t.url).hostname.toLowerCase().includes(q); } catch (e) { return false; }
      })();
      return inTitle || inUrl || inHost;
    });
  }
  const items = matches.slice(0, maxResults).map((t) => ({
    tabId: t.id, index: t.index, active: t.active, pinned: t.pinned,
    windowId: t.windowId, url: t.url, title: t.title, favIconUrl: t.favIconUrl,
    audible: t.audible, muted: t.mutedInfo ? t.mutedInfo.muted : false, groupId: t.groupId || -1,
  }));
  return ok({ count: items.length, matches: items });
});

registerTool('chrome_tab_details', async (args = {}) => {
  const ids = await resolveTabIds(args);
  const out = [];
  for (const id of ids) {
    const t = await chrome.tabs.get(id);
    out.push({
      tabId: t.id, windowId: t.windowId, index: t.index, active: t.active,
      highlighted: t.highlighted, pinned: t.pinned, audible: t.audible,
      discarded: t.discarded, autoDiscardable: t.autoDiscardable, incognito: t.incognito,
      muted: t.mutedInfo ? t.mutedInfo.muted : false, mutedReason: t.mutedInfo ? t.mutedInfo.reason : null,
      groupId: t.groupId || -1, url: t.url, pendingUrl: t.pendingUrl || null,
      title: t.title, favIconUrl: t.favIconUrl, status: t.status,
      cookieStoreId: t.cookieStoreId, openerTabId: t.openerTabId != null ? t.openerTabId : null,
      successorTabId: t.successorTabId != null ? t.successorTabId : null,
      width: t.width != null ? t.width : null, height: t.height != null ? t.height : null,
    });
  }
  return ok({ count: out.length, tabs: out });
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------
registerTool('chrome_close_tabs', async (args = {}) => {
  // Extended close: tabIds / url / domain / windowId / windowIds / all / allExcept / pinned
  if (args.windowIds != null) {
    const wins = Array.isArray(args.windowIds) ? args.windowIds : [args.windowIds];
    for (const wid of wins) await chrome.windows.remove(Number(wid));
    return ok({ closedWindows: wins.map(Number), count: wins.length });
  }
  if (args.windowId != null && args.closeWindow) {
    await chrome.windows.remove(Number(args.windowId));
    return ok({ closedWindows: [Number(args.windowId)], count: 1 });
  }
  let ids = [];
  if (args.tabIds != null) {
    ids = (Array.isArray(args.tabIds) ? args.tabIds : [args.tabIds]).map(Number);
  } else if (args.url || args.domain || args.all || args.allExcept != null || args.pinned != null || args.windowId != null) {
    ids = await resolveTabIds(args);
  } else {
    const tab = await resolveTab({});
    ids = [tab.id];
  }
  if (!ids.length) return ok({ closed: [], count: 0 });
  await chrome.tabs.remove(ids);
  return ok({ closed: ids, count: ids.length });
});

registerTool('chrome_go_back_or_forward', async (args = {}) => {
  const tab = await resolveTab(args);
  const action = args.direction === 'forward' ? 'forward' : 'back';
  if (action === 'forward') await chrome.tabs.goForward(tab.id);
  else await chrome.tabs.goBack(tab.id);
  await waitForTabComplete(tab.id, 30000);
  const after = await chrome.tabs.get(tab.id);
  return ok({ tabId: after.id, url: after.url, title: after.title, direction: action });
});

registerTool('chrome_switch_tab', async (args = {}) => {
  if (args.tabId == null) throw new Error('tabId is required');
  await chrome.tabs.update(args.tabId, { active: true });
  if (args.windowId != null) {
    try { await chrome.windows.update(args.windowId, { focused: true }); } catch (e) { /* ignore */ }
  }
  const tab = await chrome.tabs.get(args.tabId);
  return ok({ tabId: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId });
});
