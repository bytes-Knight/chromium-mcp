// lib/protocol.js — wire protocol constants, tool registry, result helpers.
// Matches the reverse-engineered mcp-chrome-bridge host protocol.

const HOST_NAME = 'com.chromemcp.nativehost';
const DEFAULT_MCP_PORT = 12306;

// Message types used on the native-messaging channel (host <-> extension).
const MSG = {
  START: 'start',
  STARTED: 'started',
  STOP: 'stop',
  STOPPED: 'stopped',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
  PROCESS_DATA: 'process_data',
  PROCESS_DATA_RESPONSE: 'process_data_response',
  CALL_TOOL: 'call_tool',
  CALL_TOOL_RESPONSE: 'call_tool_response',
  SERVER_STARTED: 'server_started',
  SERVER_STOPPED: 'server_stopped',
  ERROR_FROM_NATIVE_HOST: 'error_from_native_host',
  PING_FROM_EXTENSION: 'ping_from_extension',
  PONG_TO_EXTENSION: 'pong_to_extension',
};

// Tool registry: name -> async (args) => MCP result.
globalThis.REGISTRY = globalThis.REGISTRY || {};
function registerTool(name, fn) {
  globalThis.REGISTRY[name] = fn;
}
function getTool(name) {
  return globalThis.REGISTRY[name];
}

// ---- MCP result helpers ----------------------------------------------------
function safeStringify(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v, null, 2);
  } catch (e) {
    try {
      return String(v);
    } catch (e2) {
      return '<unserializable value>';
    }
  }
}
function ok(data) {
  return { content: [{ type: 'text', text: safeStringify(data) }], isError: false };
}
function err(message) {
  return { content: [{ type: 'text', text: 'Error: ' + String(message || 'unknown error') }], isError: true };
}
function notImplemented(name) {
  return err(`Tool "${name}" is not implemented in this clean-room build.`);
}

// ---- Async helpers ---------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label || `Timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// ---- In-memory per-tab state ------------------------------------------------
// Tab state survives only while the service worker is alive (kept alive by the
// native port + keepalive alarm). Good enough for session-scoped capture.
globalThis.TAB_STATE = globalThis.TAB_STATE || new Map(); // tabId -> {refs, injected, consoleBuffer, capture}
function getTabState(tabId) {
  if (!globalThis.TAB_STATE.has(tabId)) globalThis.TAB_STATE.set(tabId, { refs: new Map(), injected: new Set(), consoleBuffer: [], capture: null });
  return globalThis.TAB_STATE.get(tabId);
}
