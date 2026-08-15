// tools/gif.js — animated GIF recorder.
// Fixed-FPS mode (action="start") captures frames on a timer; auto mode
// (action="auto_start") captures after each successful bridge tool call
// (hooked from background.js). Frames are captured via CDP Page.captureScreenshot,
// decoded to RGBA with createImageBitmap + OffscreenCanvas, and encoded with the
// dependency-free lib/gif-encoder.js.
'use strict';

let gifSession = null; // { tabId, frames, timer, fps, autoCapture, startedAt, chain }
let lastGif = null;    // last built GIF bytes (for export)

registerTool('chrome_gif_recorder', async (args = {}) => {
  const action = args.action || 'status';
  const tab = await resolveTab(args);

  switch (action) {
    case 'start':
    case 'auto_start': {
      if (gifSession) return err('A recording is already in progress; call action=stop first');
      const fps = Math.min(Math.max(Number(args.fps) || 5, 0.5), 30);
      const maxFrames = Math.min(Number(args.maxFrames) || 300, 600);
      gifSession = {
        tabId: tab.id,
        frames: [],
        fps,
        autoCapture: action === 'auto_start',
        startedAt: Date.now(),
        lastCaptureAt: 0,
        maxFrames,
        chain: Promise.resolve(),
      };
      // Always seed with an initial frame so the GIF is never empty.
      await enqueueFrame(gifSession);
      if (!gifSession.frames.length) {
        gifSession = null;
        throw new Error('Initial frame capture failed — the tab may be hidden or its window unfocused');
      }
      if (!gifSession.autoCapture) {
        gifSession.timer = setInterval(() => enqueueFrame(gifSession).catch(() => {}), Math.round(1000 / fps));
      }
      return ok({
        action,
        tabId: tab.id,
        fps,
        autoCapture: gifSession.autoCapture,
        started: true,
      });
    }
    case 'capture': {
      if (!gifSession) return err('No recording in progress; call action=start or auto_start first');
      const frame = await enqueueFrame(gifSession);
      return ok({ action: 'capture', frames: gifSession.frames.length, captured: !!frame });
    }
    case 'status': {
      if (!gifSession) return ok({ action: 'status', recording: false });
      return ok({
        action: 'status',
        recording: true,
        tabId: gifSession.tabId,
        frames: gifSession.frames.length,
        fps: gifSession.fps,
        autoCapture: gifSession.autoCapture,
        elapsedMs: Date.now() - gifSession.startedAt,
      });
    }
    case 'stop': {
      if (!gifSession) return err('No recording in progress');
      const session = gifSession;
      gifSession = null;
      if (session.timer) clearInterval(session.timer);
      await session.chain;
      // MUST wrap in ok(): the host relays the handler return value straight
      // into the MCP result, and a bare object makes the SDK set content:[] and
      // hoist the fields to the top level, so clients see an empty result.
      return ok(await finishGif(session, args));
    }
    case 'clear': {
      if (gifSession) {
        if (gifSession.timer) clearInterval(gifSession.timer);
        gifSession = null;
      }
      lastGif = null;
      return ok({ action: 'clear', cleared: true });
    }
    case 'export': {
      if (!lastGif) return err('No recorded GIF available; record one first');
      const res = await saveGif(lastGif, args);
      return ok({ action: 'export', ...res });
    }
    default:
      throw new Error('action must be start | auto_start | capture | status | stop | clear | export');
  }
});

// Exposed to background.js: capture one frame after a successful tool call when
// an auto-capture recording is active.
async function gifAutoCaptureHook() {
  if (!gifSession || !gifSession.autoCapture) return;
  try { await enqueueFrame(gifSession); } catch (e) { /* keep recording */ }
}
globalThis.gifAutoCaptureHook = gifAutoCaptureHook;

function enqueueFrame(session) {
  const cap = () => captureFrame(session.tabId).then((frame) => {
    if (!session.frames.length) {
      session.frames.push({ ...frame, delayMs: Math.round(1000 / session.fps) });
      session.lastCaptureAt = Date.now();
      return frame;
    }
    // Constrain delay to [40ms, 2000ms] so timers don't explode the duration.
    const delayMs = Math.max(40, Math.min(2000, Date.now() - session.lastCaptureAt));
    session.lastCaptureAt = Date.now();
    if (session.frames.length < session.maxFrames) {
      session.frames.push({ ...frame, delayMs });
    }
    return frame;
  });
  session.chain = session.chain.then(cap).catch((e) => {
    console.warn('[gif] frame capture failed:', String(e && e.message || e));
    /* skip the failed frame but keep recording */
  });
  return session.chain;
}

async function captureFrame(tabId) {
  // 1) CDP screenshot of the exact tab. Wrapped in a timeout because
  //    Page.captureScreenshot on a hidden/background tab never completes.
  try {
    await cdpAttach(tabId);
    const shot = await withTimeout(
      cdpSend(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true }),
      8000,
      'screenshot timed out'
    );
    if (shot && shot.data) {
      return await pngDataUrlToRgba('data:image/png;base64,' + shot.data);
    }
  } catch (e) {
    console.warn('[gif] CDP capture failed, falling back to captureVisibleTab:', String(e.message || e));
  } finally {
    try { await cdpDetach(tabId); } catch (e) { /* ignore */ }
  }

  // 2) Fallback: activate the tab in its window and grab the visible surface.
  //    Works even when DevTools (or another client) holds the debugger, since
  //    captureVisibleTab needs no debugger attachment.
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    const dataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (url) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(new Error(lastError.message));
        else resolve(url);
      });
    });
    if (dataUrl) return await pngDataUrlToRgba(dataUrl);
  } catch (e) {
    console.warn('[gif] captureVisibleTab fallback failed:', String(e.message || e));
  }

  throw new Error('Could not capture frame for tab ' + tabId + ' (is the window focused?)');
}

async function pngDataUrlToRgba(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width: img.width, height: img.height, rgba: img.data };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function finishGif(session, args) {
  const frames = session.frames;
  if (!frames.length) return { action: 'stop', frames: 0, error: 'No frames captured' };
  const bytes = gifEncode(frames);
  lastGif = bytes;
  const saved = args.save === false ? null : await saveGif(bytes, args);
  const result = {
    action: 'stop',
    tabId: session.tabId,
    frames: frames.length,
    durationMs: Math.round(frames.reduce((acc, f) => acc + (f.delayMs || 100), 0)),
    size: bytes.length,
    width: frames[0].width,
    height: frames[0].height,
    saved,
  };
  // The full GIF data is only included when explicitly requested. Embedding the
  // base64 by default can blow past the native host's 16MB per-message cap for
  // large recordings, which silently drops the response.
  if (args.includeBase64 === true) {
    const base64 = arrayToBase64(bytes);
    result.base64 = base64;
    result.markdown = `![recording](data:image/gif;base64,${base64})`;
  } else {
    result.note = 'Pass includeBase64:true to receive the GIF data inline (it can be large).';
  }
  return result;
}

async function saveGif(bytes, args) {
  try {
    const name = (args.name ? args.name : `recording-${Date.now()}`) + '.gif';
    const blob = new Blob([bytes], { type: 'image/gif' });
    const url = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({ url, filename: name, saveAs: false });
    return { downloadId: id, filename: name, bytes: bytes.length };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

function arrayToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(bin);
}
