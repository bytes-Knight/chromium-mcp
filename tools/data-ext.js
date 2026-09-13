// tools/data-ext.js — cookies, downloads management, and cross-tab content search.
'use strict';

// ---------------------------------------------------------------------------
// Cookies (chrome.cookies)
// ---------------------------------------------------------------------------
registerTool('chrome_cookies', async (args = {}) => {
  const action = args.action || 'getAll';
  switch (action) {
    case 'get': {
      if (!args.url || !args.name) throw new Error('url and name are required for get');
      const cookie = await chrome.cookies.get({ url: args.url, name: args.name });
      return ok({ cookie: cookie ? serializeCookie(cookie) : null });
    }
    case 'getAll': {
      const filter = {};
      if (args.url) filter.url = args.url;
      if (args.domain) filter.domain = args.domain;
      if (args.name) filter.name = args.name;
      if (args.path) filter.path = args.path;
      if (args.secure != null) filter.secure = !!args.secure;
      if (args.session != null) filter.session = !!args.session;
      if (args.storeId) filter.storeId = args.storeId;
      const cookies = await chrome.cookies.getAll(filter);
      return ok({ count: cookies.length, cookies: cookies.map(serializeCookie) });
    }
    case 'set': {
      if (!args.url || !args.name || args.value === undefined) throw new Error('url, name, and value are required for set');
      const details = {
        url: args.url,
        name: args.name,
        value: String(args.value),
      };
      if (args.domain) details.domain = args.domain;
      if (args.path) details.path = args.path;
      if (args.secure != null) details.secure = !!args.secure;
      if (args.httpOnly != null) details.httpOnly = !!args.httpOnly;
      if (args.expirationDate != null) details.expirationDate = Number(args.expirationDate);
      if (args.sameSite) details.sameSite = args.sameSite;
      if (args.storeId) details.storeId = args.storeId;
      const cookie = await chrome.cookies.set(details);
      return ok({ cookie: serializeCookie(cookie) });
    }
    case 'delete': {
      if (!args.url || !args.name) throw new Error('url and name are required for delete');
      const removed = await chrome.cookies.remove({ url: args.url, name: args.name });
      return ok({ removed });
    }
    case 'deleteAll': {
      const filter = {};
      if (args.domain) filter.domain = args.domain;
      if (args.url) filter.url = args.url;
      const cookies = await chrome.cookies.getAll(filter);
      let deleted = 0;
      for (const c of cookies) {
        try { await chrome.cookies.remove({ url: cookieUrl(c), name: c.name }); deleted++; } catch (e) { /* ignore */ }
      }
      return ok({ deleted, count: cookies.length });
    }
    default:
      throw new Error('action must be get | getAll | set | delete | deleteAll');
  }
});

function serializeCookie(c) {
  return {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, session: c.session,
    hostOnly: c.hostOnly, sameSite: c.sameSite, storeId: c.storeId,
    expirationDate: c.expirationDate != null ? c.expirationDate : null,
  };
}

function cookieUrl(c) {
  const scheme = c.secure ? 'https' : 'http';
  const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
  return `${scheme}://${host}${c.path || '/'}`;
}

// ---------------------------------------------------------------------------
// Downloads (chrome.downloads)
// ---------------------------------------------------------------------------
registerTool('chrome_downloads', async (args = {}) => {
  const action = args.action || 'list';
  switch (action) {
    case 'list': {
      const query = {};
      if (args.query) query.query = args.query;
      if (args.filename) query.filename = args.filename;
      if (args.url) query.url = args.url;
      if (args.limit != null) query.limit = Math.min(Number(args.limit) || 50, 200);
      else query.limit = 50;
      if (args.state) query.state = args.state;
      if (args.ids != null) query.id = Array.isArray(args.ids) ? args.ids : [Number(args.ids)];
      const items = await chrome.downloads.search(query);
      return ok({ count: items.length, downloads: items.map(serializeDownload) });
    }
    case 'cancel':
    case 'pause':
    case 'resume': {
      const ids = (args.ids != null ? (Array.isArray(args.ids) ? args.ids : [args.ids]) : args.id != null ? [args.id] : []).map(Number);
      if (!ids.length) throw new Error('Provide id or ids to ' + action);
      const results = [];
      for (const id of ids) {
        try {
          await chrome.downloads[action === 'resume' ? 'resume' : action](id);
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, error: String(e.message || e) });
        }
      }
      return ok({ action, results, count: results.length });
    }
    case 'erase': {
      const ids = (args.ids != null ? (Array.isArray(args.ids) ? args.ids : [args.ids]) : args.id != null ? [args.id] : []).map(Number);
      if (!ids.length) throw new Error('Provide id or ids to erase');
      const erased = await chrome.downloads.erase({ id: ids });
      return ok({ erased, count: erased.length });
    }
    case 'open':
    case 'show': {
      if (args.id == null) throw new Error('Provide id to ' + action);
      const fn = action === 'open' ? chrome.downloads.open : chrome.downloads.show;
      await fn(Number(args.id));
      return ok({ action, id: Number(args.id), done: true });
    }
    case 'removeFile': {
      if (args.id == null) throw new Error('Provide id to removeFile');
      await chrome.downloads.removeFile(Number(args.id));
      return ok({ action: 'removeFile', id: Number(args.id), done: true });
    }
    default:
      throw new Error('action must be list | cancel | pause | resume | erase | open | show | removeFile');
  }
});

function serializeDownload(d) {
  return {
    id: d.id, url: d.url, filename: d.filename, state: d.state,
    mime: d.mime, startTime: d.startTime, endTime: d.endTime,
    bytesReceived: d.bytesReceived, totalBytes: d.totalBytes,
    fileSize: d.fileSize, danger: d.danger, paused: d.paused,
    error: d.error != null ? d.error : null,
  };
}

// ---------------------------------------------------------------------------
// Cross-tab content search
// ---------------------------------------------------------------------------
registerTool('chrome_search_tabs_content', async (args = {}) => {
  if (!args.query) throw new Error('query is required');
  const query = String(args.query).toLowerCase();
  const maxResults = args.maxResults || 20;
  const maxTabs = args.maxTabs || 50;
  const contextChars = args.contextChars != null ? Number(args.contextChars) : 120;

  const tabs = await chrome.tabs.query({});
  const candidates = tabs
    .filter((t) => t.url && /^https?:/i.test(t.url))
    .slice(0, maxTabs);

  const results = [];
  for (const tab of candidates) {
    try {
      const text = await executeInTab(tab.id, function () {
        return (document.body && (document.body.innerText || document.body.textContent || '')) || '';
      });
      if (!text) continue;
      const idx = text.toLowerCase().indexOf(query);
      if (idx === -1) continue;
      const start = Math.max(0, idx - contextChars / 2);
      const snippet = text.slice(start, idx + query.length + contextChars / 2).replace(/\s+/g, ' ').trim();
      results.push({
        tabId: tab.id,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        snippet: snippet.length > contextChars + query.length + 40 ? snippet.slice(0, contextChars + query.length + 40) + '…' : snippet,
      });
      if (results.length >= maxResults) break;
    } catch (e) { /* skip pages that can't be scripted */ }
  }
  return ok({ query: args.query, count: results.length, matches: results });
});
