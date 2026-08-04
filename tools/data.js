// tools/data.js — browsing history and bookmark tools.
'use strict';

registerTool('chrome_history', async (args = {}) => {
  const text = args.text || '';
  const maxResults = args.maxResults || 100;
  const now = Date.now();
  const startTime = parseTime(args.startTime, now - 24 * 3600 * 1000, now);
  const endTime = parseTime(args.endTime, now, now);

  const results = await chrome.history.search({
    text,
    startTime,
    endTime,
    maxResults: Math.max(maxResults * 5, 500),
  });

  let items = results.map((h) => ({
    id: h.id,
    url: h.url,
    title: h.title || null,
    visitCount: h.visitCount,
    lastVisitTime: h.lastVisitTime,
  }));

  if (args.excludeCurrentTabs) {
    const tabs = await chrome.tabs.query({});
    const open = new Set(tabs.map((t) => t.url));
    items = items.filter((i) => !open.has(i.url));
  }
  items = items.slice(0, maxResults);

  return ok({ count: items.length, items });
});

function parseTime(value, fallback, now) {
  if (value == null || value === '') return fallback;
  const t = value.trim().toLowerCase();
  if (t === 'now') return now;
  if (t === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  }
  if (t === 'yesterday') {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() - 24 * 3600 * 1000;
  }
  const rel = t.match(/^(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unitMs = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 }[rel[2]];
    return now - n * unitMs;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? fallback : d.getTime();
}

registerTool('chrome_bookmark_search', async (args = {}) => {
  const query = args.query || '';
  const maxResults = args.maxResults || 50;
  const tree = await chrome.bookmarks.getTree();
  const results = [];
  const folderPath = args.folderPath ? args.folderPath.split('/').filter(Boolean) : null;

  function walk(nodes, path) {
    for (const node of nodes) {
      const current = node.title ? [...path, node.title] : path;
      if (node.url) {
        const matchesQuery = !query || (node.title || '').toLowerCase().includes(query.toLowerCase()) || (node.url || '').toLowerCase().includes(query.toLowerCase());
        const matchesPath = !folderPath || folderPath.every((f, i) => (current[i] || '').toLowerCase() === f.toLowerCase());
        if (matchesQuery && matchesPath) {
          results.push({ id: node.id, title: node.title, url: node.url, parentId: node.parentId, path: current.join(' / ') });
        }
      }
      if (node.children) walk(node.children, current);
    }
  }
  walk(tree, []);
  return ok({ count: results.length, items: results.slice(0, maxResults) });
});

registerTool('chrome_bookmark_add', async (args = {}) => {
  const tab = await resolveTab({ tabId: args.tabId });
  const url = args.url || tab.url;
  let title = args.title;
  if (!title) {
    const [info] = await chrome.tabs.query({ url });
    title = info ? info.title : url;
  }
  let parentId = null;
  if (args.parentId) {
    parentId = await findFolderId(args.parentId, args.createFolder);
  } else {
    const [bar] = await chrome.bookmarks.getTree();
    const barNode = bar.children && bar.children.find((n) => n.title === 'Bookmarks bar');
    parentId = barNode ? barNode.id : '1';
  }
  const bookmark = await chrome.bookmarks.create({ parentId, title: title || 'Bookmark', url });
  return ok({ id: bookmark.id, title: bookmark.title, url: bookmark.url, parentId: bookmark.parentId });
});

registerTool('chrome_bookmark_delete', async (args = {}) => {
  let targets = [];
  if (args.bookmarkId) {
    try {
      const nodes = await chrome.bookmarks.getSubTree(args.bookmarkId);
      targets = flattenBookmarks(nodes).filter((n) => n.url || !n.children);
    } catch (e) { /* not found */ }
  } else if (args.url) {
    const results = await chrome.bookmarks.search({ url: args.url });
    if (args.title) targets = results.filter((b) => (b.title || '').includes(args.title));
    else targets = results;
  }
  if (!targets.length) return err('No matching bookmark found');
  for (const t of targets) {
    try {
      if (t.url) await chrome.bookmarks.remove(t.id);
      else await chrome.bookmarks.removeTree(t.id);
    } catch (e) { /* ignore */ }
  }
  return ok({ deleted: targets.map((t) => ({ id: t.id, title: t.title, url: t.url })), count: targets.length });
});

function flattenBookmarks(nodes) {
  const out = [];
  for (const n of nodes) {
    out.push(n);
    if (n.children) out.push(...flattenBookmarks(n.children));
  }
  return out;
}

async function findFolderId(pathOrId, createFolder) {
  // If it's a plain id, use it directly
  if (/^[0-9]+$/.test(String(pathOrId))) return String(pathOrId);
  const parts = String(pathOrId).split('/').filter(Boolean);
  if (!parts.length) return '1';
  const tree = await chrome.bookmarks.getTree();
  let nodes = tree[0].children || [];
  let currentId = tree[0].id;
  for (const part of parts) {
    let next = nodes.find((n) => !n.url && n.title === part);
    if (!next) {
      if (!createFolder) throw new Error(`Folder not found: ${pathOrId}`);
      next = await chrome.bookmarks.create({ parentId: currentId, title: part });
    }
    currentId = next.id;
    nodes = next.children || [];
  }
  return currentId;
}
