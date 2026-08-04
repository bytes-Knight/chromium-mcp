// tools/interaction.js — click, fill/select, keyboard, and JS execution tools.
'use strict';

// Resolve an element by selector/xpath/ref inside the page, returning a stable
// "handle" (css selector string) + optional frame index.
async function resolveElementHandle(tabId, args) {
  const { selector, selectorType, ref, frameId } = args;
  let handle = null;
  if (ref) {
    const st = getTabState(tabId);
    handle = st.refs.get(ref) || null;
    if (!handle) throw new Error(`Unknown ref "${ref}" — it may have expired; re-run chrome_read_page.`);
  } else if (selector) {
    handle = { selector, selectorType: selectorType || 'css' };
  } else {
    throw new Error('Provide selector, xpath, or ref');
  }
  return { handle, frameId };
}

registerTool('chrome_click_element', async (args = {}) => {
  const tab = await resolveTab(args);
  const { handle, frameId } = await resolveElementHandle(tab.id, args);
  const double = !!args.double;
  const button = args.button || 'left';
  const modifiers = args.modifiers || {};

  const clicked = await executeInTab(tab.id, function (handle, double, button, modifiers, coordinates) {
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
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: button === 'right' ? 2 : button === 'middle' ? 1 : 0,
      buttons: button === 'right' ? 2 : button === 'middle' ? 4 : 1,
      clientX: x,
      clientY: y,
      detail: double ? 2 : 1,
      ctrlKey: !!modifiers.ctrlKey,
      shiftKey: !!modifiers.shiftKey,
      altKey: !!modifiers.altKey,
      metaKey: !!modifiers.metaKey,
    };
    el.dispatchEvent(new MouseEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    if (double) {
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
    }
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    el.dispatchEvent(new MouseEvent('pointerup', opts));
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || '').trim().slice(0, 100),
      selector: handle.selector,
      x: Math.round(x),
      y: Math.round(y),
      double,
    };
  }, [handle, double, button, modifiers, args.coordinates || null], { frameId });

  if (clicked.ok === false) return err(clicked.error || 'Click failed');
  if (args.waitForNavigation) await waitForTabComplete(tab.id, args.timeout || 10000);
  return ok(clicked);
});

registerTool('chrome_fill_or_select', async (args = {}) => {
  const tab = await resolveTab(args);
  const { handle, frameId } = await resolveElementHandle(tab.id, args);
  const value = args.value;

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
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const result = { tag, type, selector: handle.selector };

    const nativeSetter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? HTMLInputElement.prototype
        : HTMLSelectElement.prototype,
      'value'
    )?.set;

    if (tag === 'select') {
      const target = Array.from(el.options).find(
        (o) => String(o.value) === String(value) || o.text === String(value)
      );
      if (target) el.value = target.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      result.value = el.value;
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      const want = value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
      if (el.checked !== want) el.click();
      result.checked = el.checked;
    } else if (tag === 'input' || tag === 'textarea') {
      if (nativeSetter) nativeSetter.call(el, String(value));
      else el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      result.value = el.value;
    } else if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, String(value));
      result.value = el.innerText;
    } else {
      return { ok: false, error: `Element ${tag} is not a fillable form control` };
    }
    return { ...result, ok: true };
  }, [handle, value], { frameId });

  if (filled.ok === false) return err(filled.error || 'Fill failed');
  return ok(filled);
});

registerTool('chrome_keyboard', async (args = {}) => {
  const tab = await resolveTab(args);
  const keys = args.keys;
  const delay = args.delay != null ? args.delay : 50;
  let selector = args.selector || null;
  if (args.ref) {
    const st = getTabState(tab.id);
    const h = st.refs.get(args.ref);
    if (h) selector = h.selector;
  }

  const sent = await executeInTab(tab.id, function (keys, delay, selector) {
    const KEYMAP = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      Home: { key: 'Home', code: 'Home', keyCode: 36 },
      End: { key: 'End', code: 'End', keyCode: 35 },
      PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
      Space: { key: ' ', code: 'Space', keyCode: 32 },
      ' ': { key: ' ', code: 'Space', keyCode: 32 },
    };
    function target() {
      if (selector) {
        const el = document.querySelector(selector);
        if (el) { el.focus(); return el; }
      }
      return document.activeElement;
    }
    function dispatch(el, type, key, code, keyCode, mods) {
      const ev = new KeyboardEvent(type, {
        key,
        code,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
        metaKey: !!mods.meta,
      });
      el.dispatchEvent(ev);
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function typeText(el, text) {
      el.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      if (nativeSetter && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        const current = el.value;
        for (const ch of text) {
          nativeSetter.call(el, current + ch);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          if (delay) await sleep(delay);
        }
      } else {
        for (const ch of text) {
          dispatch(el, 'keydown', ch, ch.length === 1 ? 'Key' + ch.toUpperCase() : '', ch.charCodeAt(0), {});
          dispatch(el, 'keypress', ch, '', ch.charCodeAt(0), {});
          dispatch(el, 'keyup', ch, '', ch.charCodeAt(0), {});
          if (delay) await sleep(delay);
        }
      }
    }
    return (async () => {
      const el = target();
      if (!el) return { ok: false, error: 'No focusable element' };
      const tokens = String(keys).split(' ');
      for (const tok of tokens) {
        const parts = tok.split('+');
        const mods = {};
        const keyName = parts.filter((p) => /^(ctrl|shift|alt|meta)$/i.test(p)).join('');
        if (/ctrl/i.test(keyName)) mods.ctrl = true;
        if (/shift/i.test(keyName)) mods.shift = true;
        if (/alt/i.test(keyName)) mods.alt = true;
        if (/meta/i.test(keyName)) mods.meta = true;
        const base = parts.find((p) => !/^(ctrl|shift|alt|meta)$/i.test(p));
        if (base == null) continue;
        const mapped = KEYMAP[base];
        if (mapped) {
          dispatch(el, 'keydown', mapped.key, mapped.code, mapped.keyCode, mods);
          dispatch(el, 'keyup', mapped.key, mapped.code, mapped.keyCode, mods);
        } else if (base.length === 1) {
          const code = /^[a-zA-Z]$/.test(base) ? 'Key' + base.toUpperCase() : '';
          const keyCode = base.charCodeAt(0);
          dispatch(el, 'keydown', base, code, keyCode, mods);
          dispatch(el, 'keypress', base, code, keyCode, mods);
          dispatch(el, 'keyup', base, code, keyCode, mods);
        } else if (base.length > 1) {
          await typeText(el, base);
        }
        if (delay) await sleep(delay);
      }
      return { ok: true, keys: String(keys), target: el.tagName.toLowerCase() };
    })();
  }, [keys, delay, selector], { frameId: args.frameId });

  if (sent.ok === false) return err(sent.error || 'Keyboard failed');
  return ok(sent);
});

registerTool('chrome_javascript', async (args = {}) => {
  const tab = await resolveTab(args);
  if (!args.code) throw new Error('code is required');
  const value = await evaluateInPage(tab.id, args.code, { timeoutMs: args.timeoutMs || 15000 });
  const maxBytes = args.maxOutputBytes || 51200;
  const json = safeStringify(value);
  const truncated = json.length > maxBytes ? json.slice(0, maxBytes) + `\n...[truncated ${json.length - maxBytes} bytes]` : json;
  return ok({ tabId: tab.id, result: truncated });
});
