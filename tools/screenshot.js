// tools/screenshot.js — screenshot capture (viewport via captureVisibleTab,
// full-page/element via CDP).
'use strict';

registerTool('chrome_screenshot', async (args = {}) => {
  const tab = await resolveTab(args);
  const { selector, fullPage, storeBase64, savePng, name } = args;
  const savePngFlag = savePng !== false;
  const storeBase64Flag = storeBase64 === true || fullPage === true || selector;

  let dataUrl = null;

  if (selector || fullPage) {
    dataUrl = await screenshotViaCdp(tab, selector || null, fullPage);
    if (!dataUrl) {
      // CDP unavailable (DevTools open) — fall back to viewport capture
      dataUrl = await captureVisible(tab, args);
    }
  } else {
    dataUrl = await captureVisible(tab, args);
  }

  if (!dataUrl) return err('Screenshot failed');

  const filename = (name ? name : `screenshot-${Date.now()}`) + '.png';
  let saved = null;
  if (savePngFlag) {
    try {
      const id = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
      saved = { downloadId: id, filename };
    } catch (e) {
      saved = { error: String(e.message || e) };
    }
  }

  const base64 = storeBase64Flag ? dataUrl.split(',')[1] : null;
  return ok({
    tabId: tab.id,
    format: 'png',
    saved,
    base64,
    markdown: base64 ? `![screenshot](data:image/png;base64,${base64})` : null,
  });
});

async function captureVisible(tab, args) {
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (url) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message));
        else resolve(url);
      });
    });
    return dataUrl;
  } catch (e) {
    return null;
  }
}

async function screenshotViaCdp(tab, selector, fullPage) {
  try {
    await cdpAttach(tab.id);
    await cdpSend(tab.id, 'Page.enable', {});
    let clip = null;
    if (selector) {
      const rect = await cdpSend(tab.id, 'Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`,
        returnByValue: true,
      });
      const v = rect.result && rect.result.value;
      if (!v) throw new Error(`Element not found: ${selector}`);
      clip = { x: v.x, y: v.y, width: v.width, height: v.height, scale: 1 };
    } else if (fullPage) {
      const metrics = await cdpSend(tab.id, 'Page.getLayoutMetrics', {});
      const css = metrics.cssContentSize || metrics.contentSize;
      clip = { x: 0, y: 0, width: css.width, height: css.height, scale: 1 };
    }
    const shot = await cdpSend(tab.id, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: !!clip,
      clip: clip || undefined,
      fromSurface: true,
    });
    return 'data:image/png;base64,' + shot.data;
  } catch (e) {
    return null;
  } finally {
    try { await cdpDetach(tab.id); } catch (e) { /* ignore */ }
  }
}
