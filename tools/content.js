// tools/content.js — page content extraction and interactive element enumeration.
'use strict';

registerTool('chrome_get_web_content', async (args = {}) => {
  const { url, htmlContent, textContent, selector } = args;
  let tab;
  if (url) {
    tab = await resolveTab({ tabId: args.tabId, windowId: args.windowId });
    if (tab.url !== url) tab = await navigateTab(tab, url, { background: args.background });
  } else {
    tab = await resolveTab({ tabId: args.tabId, windowId: args.windowId });
  }
  const wantHtml = !!htmlContent;
  const wantText = textContent !== false;

  const result = await executeInTab(tab.id, function (wantHtml, wantText, selector) {
    function cleanUrl(u) {
      if (!u) return u;
      try { return new URL(u).href; } catch (e) { return u; }
    }
    const meta = {
      title: document.title,
      url: cleanUrl(location.href),
      lang: document.documentElement.lang || null,
    };
    let html = null;
    let text = null;
    let selected = null;
    if (selector) {
      const el = document.querySelector(selector);
      if (el) {
        selected = {
          selector,
          tag: el.tagName.toLowerCase(),
          html: el.outerHTML.slice(0, 200000),
          text: (el.innerText || el.textContent || '').trim().slice(0, 200000),
        };
      }
    } else {
      if (wantHtml) {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script,style,link,meta,noscript,svg,canvas,iframe').forEach((n) => n.remove());
        html = clone.outerHTML.slice(0, 500000);
      }
      if (wantText) {
        const body = document.body;
        text = body ? (body.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 300000) : '';
      }
    }
    const frames = [];
    document.querySelectorAll('iframe').forEach((f) => {
      try {
        frames.push({ src: cleanUrl(f.src || null), id: f.id || null, name: f.name || null });
      } catch (e) { /* ignore */ }
    });
    return { meta, html, text, selected, iframes: frames };
  }, [wantHtml, wantText, selector || null]);

  const data = { tabId: tab.id, meta: result.meta, iframes: result.iframes };
  if (result.selected) data.selected = result.selected;
  else {
    if (wantHtml) data.html = result.html;
    if (wantText) data.text = result.text;
  }
  return ok(data);
});

registerTool('chrome_get_interactive_elements', async (args = {}) => {
  const tab = await resolveTab(args);
  const elements = await executeInTab(tab.id, function () {
    const INTERACTIVE = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"],summary,label[for],details';
    const out = [];
    const seen = new Set();
    const matches = document.querySelectorAll(INTERACTIVE);
    matches.forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return;
      const item = {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        name: el.getAttribute('name') || null,
        type: el.getAttribute('type') || null,
        href: el.href ? (() => { try { return new URL(el.href).href; } catch (e) { return el.href; } })() : null,
        text: (el.innerText || el.textContent || el.value || '').trim().slice(0, 200),
        placeholder: el.getAttribute('placeholder') || null,
        ariaLabel: el.getAttribute('aria-label') || el.getAttribute('title') || null,
        role: el.getAttribute('role') || null,
        checked: el.checked === true,
        disabled: el.disabled === true,
        value: (el.value != null ? String(el.value) : null),
      };
      out.push(item);
    });
    return out;
  });
  return ok({ tabId: tab.id, count: elements.length, elements });
});
