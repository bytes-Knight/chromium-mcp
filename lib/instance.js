// lib/instance.js — multi-browser instance identity + MCP port allocation.
//
// Every browser (Chrome, Edge, Brave, Chromium, Opera, ...) that loads this
// extension gets:
//   - a stable instanceId  (persisted in chrome.storage.local, generated once)
//   - an optional user label (e.g. "chrome-work", "edge-victim")
//   - its OWN MCP port      (deterministic hash of the instanceId spread over
//                            PORT_BASE..PORT_BASE+PORT_SPAN-1, persisted once
//                            chosen so restarts keep the same port)
//
// This is what lets several browsers run the bridge side by side without
// fighting over port 12306: each instance owns a different port, and the CLI
// (`mcpctl instances` / `mcpctl --browser <name|label|id>`) discovers and
// targets them individually.
'use strict';

const PORT_BASE = 12306;
const PORT_SPAN = 30; // ports PORT_BASE .. PORT_BASE + PORT_SPAN - 1

const KEYS = {
  instanceId: 'bridgeInstanceId',
  label: 'bridgeInstanceLabel',
  mcpPort: 'bridgeMcpPort',
  pinnedPort: 'bridgePortPinned',
};

// djb2 string hash — sync and stable per instanceId (no async crypto needed).
function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function genId() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch (e) { /* fall through */ }
  // RFC4122 v4 fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function storageGet(key) {
  try { return (await chrome.storage.local.get(key))[key]; } catch (e) { return undefined; }
}
async function storageSet(obj) {
  try { await chrome.storage.local.set(obj); } catch (e) { /* ignore */ }
}

async function getInstanceId() {
  let id = await storageGet(KEYS.instanceId);
  if (!id) {
    id = genId();
    await storageSet({ [KEYS.instanceId]: id });
  }
  return id;
}

async function getLabel() { return (await storageGet(KEYS.label)) || ''; }
async function setLabel(label) {
  await storageSet({ [KEYS.label]: String(label || '').trim().slice(0, 60) });
}

async function getSavedPort() {
  const p = parseInt(await storageGet(KEYS.mcpPort), 10);
  return (Number.isInteger(p) && p >= 1024 && p <= 65535) ? p : null;
}

// A port the USER pinned (popup Connect with an edited value) must stick across
// restarts. A port we merely moved to because ours was busy must NOT: saving that
// ratchets the instance one port higher on every launch (a stale host still holds
// the old port, we move, we save it, and next launch we start from there).
async function getPinnedPort() {
  if (!(await storageGet(KEYS.pinnedPort))) return null;
  return getSavedPort();
}
async function pinPort(p) {
  if (Number.isInteger(p) && p >= 1024 && p <= 65535) {
    await savePort(p);
    await storageSet({ [KEYS.pinnedPort]: true });
  } else {
    await storageSet({ [KEYS.pinnedPort]: false });
  }
}
async function savePort(p) {
  if (Number.isInteger(p) && p >= 1024 && p <= 65535) await storageSet({ [KEYS.mcpPort]: p });
}

// Deterministic per-instance default port: stable across restarts and spread
// over the span, so two browsers collide only ~1/PORT_SPAN of the time. On a
// rare collision the loser simply moves to the next free slot and persists it.
async function defaultPort() {
  const id = await getInstanceId();
  return PORT_BASE + (hashString(id) % PORT_SPAN);
}

function nextPort(p) {
  const cur = Number.isInteger(p) ? p : PORT_BASE - 1;
  return cur + 1 > PORT_BASE + PORT_SPAN - 1 ? PORT_BASE : cur + 1;
}

// Best-effort browser fingerprinting from the service worker.
//   chrome   — plain Chrome / Chromium
//   edge     — Microsoft Edge (Edg/ UA token or UA client hints brand)
//   brave    — Brave (same UA as Chrome; detected via navigator.brave.isBrave())
//   opera    — Opera / Opera GX (OPR/ UA token)
async function getBrowserInfo() {
  const ua = navigator.userAgent || '';
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) ? navigator.userAgentData.brands : null;
  let name = 'chrome';
  let version = '';
  const m = ua.match(/(?:Chrome|Edg|OPR|Brave)\/([\d.]+)/);
  if (m) version = m[1];
  if (/Edg\//i.test(ua)) name = 'edge';
  else if (/OPR\//i.test(ua)) name = 'opera';
  else if (/Brave/i.test(ua)) name = 'brave';
  else if (brands && brands.some((b) => /Microsoft Edge/i.test(b.brand))) name = 'edge';
  else if (brands && brands.some((b) => /Opera/i.test(b.brand))) name = 'opera';
  else {
    try {
      if (navigator.brave && typeof navigator.brave.isBrave === 'function' && await navigator.brave.isBrave()) name = 'brave';
    } catch (e) { /* ignore */ }
  }
  if (!version) {
    const v = ua.match(/Chrome\/([\d.]+)/);
    if (v) version = v[1];
  }
  let platform = 'unknown';
  try { platform = (await chrome.runtime.getPlatformInfo()).os; } catch (e) { /* ignore */ }
  return { name, version, platform, ua: ua.slice(0, 200) };
}

globalThis.BRIDGE_INSTANCE = {
  PORT_BASE,
  PORT_SPAN,
  KEYS,
  getInstanceId,
  getLabel,
  setLabel,
  getSavedPort,
  savePort,
  getPinnedPort,
  pinPort,
  defaultPort,
  nextPort,
  getBrowserInfo,
};