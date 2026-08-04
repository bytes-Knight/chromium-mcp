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
      windowId: t.windowId,
    })),
  }));
  return ok(data);
});

registerTool('chrome_navigate', async (args = {}) => {
  const { url, newWindow, background, width, height, refresh } = args;
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

registerTool('chrome_switch_tab', async (args = {}) => {
  if (args.tabId == null) throw new Error('tabId is required');
  await chrome.tabs.update(args.tabId, { active: true });
  if (args.windowId != null) {
    try { await chrome.windows.update(args.windowId, { focused: true }); } catch (e) { /* ignore */ }
  }
  const tab = await chrome.tabs.get(args.tabId);
  return ok({ tabId: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId });
});

registerTool('chrome_close_tabs', async (args = {}) => {
  let ids = [];
  if (Array.isArray(args.tabIds) && args.tabIds.length) {
    ids = args.tabIds;
  } else if (args.url) {
    const tabs = await chrome.tabs.query({ url: args.url });
    ids = tabs.map((t) => t.id);
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
