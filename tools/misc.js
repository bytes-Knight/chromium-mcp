// tools/misc.js — read_page, computer (subset), element selection, dialogs,
// downloads, uploads, and stubs for exotic tools.
'use strict';

registerTool('chrome_read_page', async (args = {}) => {
  const tab = await resolveTab(args);
  const filter = args.filter === 'interactive' ? 'interactive' : 'all';
  const depth = args.depth != null ? args.depth : 12;
  const refId = args.refId || null;

  const tree = await executeInTab(tab.id, function (filter, depth, refId) {
    const INTERACTIVE = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"],summary,label[for],details';
    const out = [];
    let counter = 0;
    const seen = new Set();

    function visible(el) {
      if (!el || el.nodeType !== 1) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      return true;
    }

    function buildRef(el) {
      if (el.id) {
        const sel = '#' + CSS.escape(el.id);
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && parts.length < 6) {
        let part = node.tagName.toLowerCase();
        if (node.id) { part = '#' + CSS.escape(node.id); parts.unshift(part); break; }
        if (node.className && typeof node.className === 'string') {
          const cls = node.className.split(/\s+/).filter(Boolean).slice(0, 2);
          if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
        }
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((s) => s.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(' > ');
    }

    function walk(root, level) {
      if (level > depth) return;
      if (root.nodeType !== 1) return;
      const matchesInteractive = filter === 'all' || root.matches(INTERACTIVE) || root.getAttribute('role');
      if (matchesInteractive && visible(root) && !seen.has(root)) {
        seen.add(root);
        counter++;
        const ref = 'ref_' + counter;
        const rect = root.getBoundingClientRect();
        const item = {
          ref,
          tag: root.tagName.toLowerCase(),
          role: root.getAttribute('role') || null,
          text: (root.innerText || root.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) || null,
          ariaLabel: root.getAttribute('aria-label') || root.getAttribute('title') || null,
          href: root.href || null,
          selector: buildRef(root),
          bounds: {
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          depth: level,
        };
        out.push(item);
      }
      if (root.shadowRoot) walk(root.shadowRoot, level + 1);
      for (const child of root.children || []) walk(child, level + 1);
    }
    walk(document.body || document.documentElement, 0);

    // Focus on subtree of a specific ref if requested
    if (refId) {
      const target = out.find((i) => i.ref === refId);
      if (target) {
        const idx = out.indexOf(target);
        return { focused: refId, subtree: out.slice(idx) };
      }
    }
    return { focused: null, subtree: out };
  }, [filter, depth, refId]);

  // Store ref -> selector map so click/fill can resolve refs later
  const state = getTabState(tab.id);
  for (const item of tree.subtree) state.refs.set(item.ref, { selector: item.selector, tag: item.tag });

  return ok({ tabId: tab.id, filter, count: tree.subtree.length, refs: tree.subtree });
});

registerTool('chrome_computer', async (args = {}) => {
  // Subset implementation of the computer tool: screenshot, click, type, key,
  // scroll, scroll_to, wait, resize_page, hover, fill.
  const tab = await resolveTab(args);
  const action = args.action;

  switch (action) {
    case 'screenshot': {
      const shot = await captureVisible(tab, args);
      if (!shot) return err('Screenshot failed');
      return ok({
        action: 'screenshot',
        format: 'png',
        base64: shot.split(',')[1],
        markdown: `![screenshot](data:image/png;base64,${shot.split(',')[1]})`,
      });
    }
    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      const clickArgs = {
        ref: args.ref,
        selector: args.selector,
        selectorType: args.selectorType,
        coordinates: args.coordinates,
        double: action === 'double_click' || action === 'triple_click',
        button: action === 'right_click' ? 'right' : 'left',
        modifiers: args.modifiers,
      };
      const result = await chrome_click_element_impl(clickArgs, tab);
      return ok({ action, ...result });
    }
    case 'scroll': {
      const direction = args.scrollDirection || 'down';
      const amount = args.scrollAmount != null ? args.scrollAmount : 3;
      const delta = { up: -400, down: 400, left: -400, right: 400 }[direction] * (amount / 3);
      await executeInTab(tab.id, function (delta, direction) {
        if (direction === 'left' || direction === 'right') window.scrollBy({ left: delta, behavior: 'instant' });
        else window.scrollBy({ top: delta, behavior: 'instant' });
        return { scrolled: true };
      }, [delta, direction]);
      return ok({ action: 'scroll', direction, amount });
    }
    case 'scroll_to': {
      let selector = null;
      if (args.ref) {
        const st = getTabState(tab.id);
        const h = st.refs.get(args.ref);
        if (h) selector = h.selector;
      }
      const scrolled = await executeInTab(tab.id, function (selector, coordinates) {
        if (selector) {
          const el = document.querySelector(selector);
          if (el) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); return { scrolled: true, via: 'ref' }; }
        }
        if (coordinates && coordinates.x != null && coordinates.y != null) {
          window.scrollTo({ left: coordinates.x, top: coordinates.y, behavior: 'instant' });
          return { scrolled: true, via: 'coordinates' };
        }
        return { scrolled: false, error: 'Provide ref or coordinates' };
      }, [selector, args.coordinates || null]);
      return ok({ action: 'scroll_to', ...scrolled });
    }
    case 'type':
    case 'key': {
      const text = args.text;
      const sent = await executeInTab(tab.id, function (text, isKey) {
        const KEYMAP = {
          Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
          Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
          Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
          Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
          ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
          ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        };
        const el = document.activeElement;
        function dispatch(type, key, code, keyCode, mods) {
          el.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta }));
        }
        if (isKey) {
          const parts = text.split(' ');
          for (const tok of parts) {
            const mods = {};
            const pieces = tok.split('+');
            pieces.forEach((p) => { if (/^(ctrl|shift|alt|meta)$/i.test(p)) mods[p.toLowerCase()] = true; });
            const base = pieces.find((p) => !/^(ctrl|shift|alt|meta)$/i.test(p));
            const mapped = KEYMAP[base] || { key: base, code: base, keyCode: base.charCodeAt(0) };
            dispatch('keydown', mapped.key, mapped.code, mapped.keyCode, mods);
            dispatch('keyup', mapped.key, mapped.code, mapped.keyCode, mods);
          }
          return { typed: text, asKey: true };
        }
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter && el.tagName !== 'TEXTAREA' && !el.isContentEditable) {
            setter.call(el, el.value + text);
          } else {
            el.focus();
            document.execCommand('insertText', false, text);
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { typed: text, asKey: false };
        }
        return { typed: text, asKey: false, note: 'no focusable input; sent as key events' };
      }, [args.text, action === 'key']);
      return ok({ action, ...sent });
    }
    case 'fill': {
      const fillArgs = { ref: args.ref, selector: args.selector, value: args.value };
      const filled = await chrome_fill_or_select_impl(fillArgs, tab);
      return ok({ action: 'fill', ...filled });
    }
    case 'fill_form': {
      const results = [];
      for (const item of args.elements || []) {
        const r = await chrome_fill_or_select_impl({ ref: item.ref, value: item.value }, tab);
        results.push({ ref: item.ref, ok: !!r.ok, value: r.value });
      }
      return ok({ action: 'fill_form', results });
    }
    case 'wait': {
      const duration = Math.min(args.duration || 1, 30);
      await sleep(duration * 1000);
      return ok({ action: 'wait', waitedSeconds: duration });
    }
    case 'resize_page': {
      const w = args.width || 1280;
      const h = args.height || 720;
      await chrome.windows.update(tab.windowId, { width: w, height: h });
      return ok({ action: 'resize_page', width: w, height: h });
    }
    case 'hover': {
      const result = await chrome_click_element_impl({ ref: args.ref, selector: args.selector, coordinates: args.coordinates }, tab, true);
      return ok({ action: 'hover', ...result });
    }
    default:
      return err(`chrome_computer action "${action}" is not supported in this build`);
  }
});

// Shared helpers referenced above (registered via globalThis so they can be
// called across modules).
globalThis.chrome_click_element_impl = async (args, tab, hoverOnly = false) => {
  const { handle, frameId } = await resolveElementHandle(tab.id, args);
  const clicked = await executeInTab(tab.id, function (handle, coordinates, hoverOnly) {
    function findBySelector(sel, type) {
      if (type === 'xpath') {
        const xr = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return xr.singleNodeValue;
      }
      return document.querySelector(sel);
    }
    let el = null;
    if (coordinates && coordinates.x != null && coordinates.y != null) {
      el = document.elementFromPoint(coordinates.x, coordinates.y);
    } else {
      el = findBySelector(handle.selector, handle.selectorType);
    }
    if (!el) return { ok: false, error: 'Element not found' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const x = coordinates && coordinates.x != null ? coordinates.x : rect.left + rect.width / 2;
    const y = coordinates && coordinates.y != null ? coordinates.y : rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, detail: 1, button: 0, buttons: 1 };
    if (hoverOnly) {
      el.dispatchEvent(new MouseEvent('pointerover', opts));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mouseenter', opts));
      return { ok: true, hovered: true };
    }
    el.dispatchEvent(new MouseEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    el.dispatchEvent(new MouseEvent('pointerup', opts));
    return { ok: true, tag: el.tagName.toLowerCase() };
  }, [handle, args.coordinates || null, hoverOnly], { frameId });
  return clicked.ok === false ? { ok: false, error: clicked.error } : clicked;
};

globalThis.chrome_fill_or_select_impl = async (args, tab) => {
  const { handle, frameId } = await resolveElementHandle(tab.id, args);
  const filled = await executeInTab(tab.id, function (handle, value) {
    function findBySelector(sel, type) {
      if (type === 'xpath') {
        const xr = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return xr.singleNodeValue;
      }
      return document.querySelector(sel);
    }
    const el = findBySelector(handle.selector, handle.selectorType);
    if (!el) return { ok: false, error: 'Element not found' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  }, [handle, args.value], { frameId });
  return filled.ok === false ? { ok: false, error: filled.error } : filled;
};

registerTool('chrome_request_element_selection', async (args = {}) => {
  const tab = await resolveTab(args);
  const requests = args.requests || [];
  const timeoutMs = Math.min(args.timeoutMs || 180000, 600000);

  const picked = await executeInTab(tab.id, function (requests, timeoutMs) {
    return new Promise((resolve) => {
      const results = [];
      let index = 0;
      let done = false;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.15);';
      const label = document.createElement('div');
      label.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#0e1326;color:#fff;padding:10px 16px;border-radius:10px;font:13px/1.4 system-ui;box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:70vw;';
      label.textContent = requests.length ? `Click: ${requests[0].name}` : 'Click elements';
      document.documentElement.appendChild(overlay);
      document.documentElement.appendChild(label);

      let hovered = null;
      overlay.addEventListener('mousemove', (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (hovered) hovered.style.outline = '';
        hovered = el;
        if (hovered) hovered.style.outline = '2px solid #3ddc97';
      });
      overlay.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === overlay) return;
        let sel = el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase();
        if (!el.id) {
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
            if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(el) + 1})`;
          }
        }
        const req = requests[index] || { name: `element_${index + 1}` };
        results.push({ requestId: req.id || req.name, name: req.name, selector: sel, tag: el.tagName.toLowerCase() });
        index++;
        if (index >= requests.length) {
          finish();
        } else {
          label.textContent = `Click: ${requests[index].name}`;
        }
      });
      overlay.addEventListener('contextmenu', (e) => { e.preventDefault(); finish(); });
      const finish = () => {
        if (done) return;
        done = true;
        overlay.remove();
        label.remove();
        if (hovered) hovered.style.outline = '';
        resolve({ ok: true, results });
      };
      setTimeout(finish, timeoutMs);
    });
  }, [requests, timeoutMs]);

  return ok({ tabId: tab.id, count: picked.results.length, picks: picked.results });
});

// ---- Dialogs / downloads / uploads ------------------------------------------
registerTool('chrome_handle_dialog', async (args = {}) => {
  const tab = await resolveTab(args);
  const action = args.action === 'dismiss' ? 'dismiss' : 'accept';
  try {
    await cdpAttach(tab.id);
    await cdpSend(tab.id, 'Page.enable', {});
    const result = await withTimeout(cdpSend(tab.id, 'Page.handleJavaScriptDialog', {
      accept: action === 'accept',
      promptText: args.promptText || '',
    }), 10000, 'No JavaScript dialog is currently open');
    return ok({ action, handled: true });
  } catch (e) {
    return err(e.message);
  } finally {
    try { await cdpDetach(tab.id); } catch (e) { /* ignore */ }
  }
});

registerTool('chrome_handle_download', async (args = {}) => {
  const filenameContains = args.filenameContains || '';
  const timeoutMs = Math.min(args.timeoutMs || 60000, 300000);
  const waitForComplete = args.waitForComplete !== false;

  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(err('Timed out waiting for download')); }, timeoutMs);
    let matched = null;
    const onCreated = (item) => {
      if (filenameContains && !(item.filename || '').includes(filenameContains) && !(item.url || '').includes(filenameContains)) return;
      matched = item;
      if (!waitForComplete) finish(item);
    };
    const onChanged = (delta) => {
      if (!matched || delta.id !== matched.id) return;
      if (delta.state && delta.state.current === 'complete') finish(matched);
    };
    const finish = (item) => {
      cleanup();
      chrome.downloads.search({ id: item.id }, (results) => {
        const d = results && results[0];
        resolve(ok({
          id: item.id,
          filename: d ? d.filename : item.filename,
          url: d ? d.url : item.url,
          state: d ? d.state : 'complete',
          totalBytes: d ? d.totalBytes : null,
          mime: d ? d.mime : null,
        }));
      });
    };
    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
    };
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    // Check for already-existing downloads
    chrome.downloads.search({ limit: 20 }, (items) => {
      for (const item of items) {
        if (item.state === 'in_progress' || item.state === 'complete') {
          if (!filenameContains || (item.filename || '').includes(filenameContains)) {
            matched = item;
            if (item.state === 'complete' || !waitForComplete) finish(item);
            return;
          }
        }
      }
    });
  });
});

registerTool('chrome_upload_file', async (args = {}) => {
  const tab = await resolveTab(args);
  if (!args.selector) throw new Error('selector is required');
  if (!args.filePath) {
    if (args.base64Data || args.fileUrl) {
      throw new Error('base64Data/fileUrl upload requires writing to a temp file, which is not supported in this build — use a local filePath');
    }
    throw new Error('filePath is required');
  }
  try {
    await cdpAttach(tab.id);
    await cdpSend(tab.id, 'DOM.enable', {});
    const doc = await cdpSend(tab.id, 'DOM.getDocument', { depth: -1 });
    const q = await cdpSend(tab.id, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: args.selector });
    if (!q.nodeId) throw new Error(`File input not found: ${args.selector}`);
    await cdpSend(tab.id, 'DOM.setFileInputFiles', { nodeId: q.nodeId, files: [args.filePath] });
    return ok({ uploaded: true, file: args.filePath, selector: args.selector });
  } catch (e) {
    return err(e.message);
  } finally {
    try { await cdpDetach(tab.id); } catch (e) { /* ignore */ }
  }
});

// The GIF recorder (tools/gif.js) and performance tracing (tools/perf.js) are
// implemented in their own modules — no stubs here. rr_list_published_flows is
// answered by the service worker directly (see background.js).
