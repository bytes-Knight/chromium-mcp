// lib/cdp.js — chrome.debugger promisified helpers with busy-debugger fallback.
'use strict';

async function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(`CDP ${method}: ${lastError.message}`));
      else resolve(result);
    });
  });
}

async function cdpAttach(tabId) {
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) reject(new Error(`Debugger attach failed: ${lastError.message}`));
      else resolve();
    });
  });
}

async function cdpDetach(tabId) {
  try {
    await new Promise((resolve) => chrome.debugger.detach({ tabId }, () => resolve()));
  } catch (e) { /* ignore */ }
}

// Evaluate arbitrary JS in the page's MAIN world via CDP. Falls back to
// scripting.executeScript (ISOLATED world) if the debugger is busy.
async function evaluateInPage(tabId, code, { timeoutMs = 15000 } = {}) {
  const expression = `(async () => { "use strict"; ${code}\n})()`;
  try {
    await cdpAttach(tabId);
    const res = await withTimeout(
      cdpSend(tabId, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutMs,
      }),
      timeoutMs + 2000,
      'JS evaluation timed out'
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const text =
        (d.exception && d.exception.description) ||
        (d.exception && d.exception.value) ||
        d.text ||
        'exception';
      throw new Error(String(text).split('\n')[0]);
    }
    return res.result && res.result.value;
  } catch (e) {
    // Debugger busy or unsupported page — fall back to script injection.
    if (/Debugger attach failed/i.test(String(e.message))) {
      const runInWorld = (world) =>
        executeInTab(tabId, function (src) {
          return (async () => {
            'use strict';
            // eslint-disable-next-line no-new-func
            const fn = new Function('return (async () => { ' + src + '\n})();');
            return await fn();
          })();
        }, [code], { world });
      try {
        return await runInWorld('MAIN');
      } catch (e2) {
        // Page CSP may block eval in MAIN world; ISOLATED world bypasses it.
        return await runInWorld('ISOLATED');
      }
    }
    throw e;
  } finally {
    try { await cdpDetach(tabId); } catch (e) { /* ignore */ }
  }
}
