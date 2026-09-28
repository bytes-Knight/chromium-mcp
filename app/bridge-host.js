#!/usr/bin/env node
// bridge-host.js — MANUAL bridge host.
//
// WHY THIS EXISTS
//   The normal bridge chain is:  MCP client -> host HTTP server -> native-messaging
//   pipe -> extension -> browser.  The only link we do not control is the browser
//   SPAWNING the native-messaging host.  On this machine Brave never launches the
//   registered host at all (connectNative() succeeds and the pipe dies ~1ms later,
//   no host process is ever created), which leaves the bridge permanently offline
//   no matter how the host is registered.
//
//   This file removes the browser from the spawn path.  You run it by hand:
//
//       bridge-host.exe
//
//   It listens on ws://127.0.0.1:12400, and when the extension connects it
//   spawns the very same host process the browser would have spawned
//   (mcp-chrome-bridge/dist/index.js) as a child, then relays messages between
//   the extension's WebSocket and the host's stdio in BOTH directions.
//
//   The extension speaks the identical wire protocol as over native messaging
//   (4-byte length-prefixed JSON on the host side, JSON text frames on the wire),
//   so no tool, port or MCP-client behaviour changes: the extension still asks
//   the host to start its MCP server on its own instance port, mcpctl still
//   discovers it on 12306-12340.
//
// LIFECYCLE (mirrors native messaging)
//   * host child is spawned on demand, the first time a client connects
//   * the child's stdout frames are broadcast to the connected client
//   * the child dies if the WS client goes away (unless --keep-alive)
//   * if the child exits, open clients are closed with 1011 so the extension
//     sees "pipe closed" and reconnects, exactly like a dead native pipe
//   * only ONE client at a time (native messaging is 1:1; a second connection
//     gets HTTP 503 rather than having two browsers race over one host)
//
// Runtime: node builtins only — no dependencies, so it bundles cleanly into a
// standalone .exe with node's SEA support (see build-bridge.js).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const VERSION = '1.0.0';
const DEFAULT_WS_PORT = 12400;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 handshake magic
const MAX_MSG = 16 * 1024 * 1024; // same cap the native host enforces on one message
const MAX_WS_FRAME = 64 * 1024 * 1024; // refuse absurd frames instead of buffering them
const CLOSE_HOST_GRACE_MS = 3000; // last client gone -> let the MCP server die

// ---------------------------------------------------------------- arguments --
function parseArgs(argv) {
  const o = { wsPort: DEFAULT_WS_PORT, hostScript: null, node: null, keepAlive: false, selftest: false, help: false, debug: !!process.env.MCP_BRIDGE_DEBUG };
  const num = (v, d) => (Number.isInteger(parseInt(v, 10)) ? parseInt(v, 10) : d);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ws-port') o.wsPort = num(argv[++i], o.wsPort);
    else if (a.startsWith('--ws-port=')) o.wsPort = num(a.slice(10), o.wsPort);
    else if (a === '--host') o.hostScript = argv[++i] || null;
    else if (a.startsWith('--host=')) o.hostScript = a.slice(7) || null;
    else if (a === '--node') o.node = argv[++i] || null;
    else if (a.startsWith('--node=')) o.node = a.slice(7) || null;
    else if (a === '--keep-alive') o.keepAlive = true;
    else if (a === '--debug') o.debug = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const ARGS = parseArgs(process.argv);

// -------------------------------------------------------------------- logging --
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'mcp-chrome-bridge', 'logs');
let logStream = null;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  logStream = fs.createWriteStream(path.join(LOG_DIR, 'bridge_host_' + stamp() + '.log'), { flags: 'a' });
} catch (e) { /* console logging still works */ }

function debug(...parts) {
  if (ARGS.debug) log('[debug]', ...parts);
}

function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function log(...parts) {
  const line = '[' + new Date().toISOString() + '] ' + parts.map(fmt).join(' ');
  try { process.stdout.write(line + '\n'); } catch (e) { /* ignore */ }
  if (logStream) { try { logStream.write(line + '\n'); } catch (e) { /* ignore */ } }
}

// -------------------------------------------------------------- environment ---
function isSea() {
  try { return require('node:sea').isSea(); } catch (e) { return false; }
}

// The host child must run under REAL node, because it requires its own
// node_modules (fastify, the MCP SDK, ...). Under SEA process.execPath is this
// exe, so it may only be used as a candidate when we are plain node.
function resolveNode(explicit) {
  const cands = [];
  if (explicit) cands.push(explicit);
  if (process.env.CHROME_MCP_NODE_PATH) {
    cands.push(path.join(process.env.CHROME_MCP_NODE_PATH, 'node.exe'), process.env.CHROME_MCP_NODE_PATH);
  }
  if (!isSea()) cands.push(process.execPath);
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
  if (process.env['ProgramFiles(x86)']) cands.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'));
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'));
  for (const p of cands) if (p && fs.existsSync(p)) return p;
  try {
    const out = execFileSync('where', ['node.exe'], { encoding: 'utf8', windowsHide: true });
    const hit = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
    if (hit) return hit;
  } catch (e) { /* not on PATH */ }
  return null;
}

function resolveHostScript(explicit) {
  const cands = [];
  if (explicit) cands.push(explicit);
  if (process.env.MCP_BRIDGE_HOST_SCRIPT) cands.push(process.env.MCP_BRIDGE_HOST_SCRIPT);
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'mcp-chrome-bridge', 'dist', 'index.js'));
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules', 'mcp-chrome-bridge', 'dist', 'index.js'));
  cands.push(path.join(__dirname, 'mcp-chrome-bridge', 'dist', 'index.js'));
  cands.push(path.join(__dirname, '..', 'mcp-chrome-bridge', 'dist', 'index.js'));
  for (const p of cands) if (p && fs.existsSync(p)) return p;
  return explicit || (process.env.APPDATA
    ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'mcp-chrome-bridge', 'dist', 'index.js')
    : null);
}

const NODE_EXE = resolveNode(ARGS.node);
const HOST_SCRIPT = resolveHostScript(ARGS.hostScript);

// ------------------------------------------------------------ WebSocket impl --
// Minimal RFC 6455 server side: enough for JSON text frames in both directions,
// including continuation frames and 64-bit lengths (tool results can be many MB).
class WsPeer {
  constructor(socket, label) {
    this.socket = socket;
    this.label = label;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.closed = false;
    this.onmessage = () => {};
    this.onclose = () => {};
    this.onpong = () => {};
  }

  sendText(text) {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  sendFrame(opcode, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 4294967296), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode; // FIN + opcode, server frames are never masked
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { /* peer gone */ }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true; // set first: the socket 'close' handler must not re-fire onclose
    const b = Buffer.alloc(2 + Buffer.byteLength(reason));
    b.writeUInt16BE(code, 0);
    b.write(reason, 2, 'utf8');
    this.sendFrame(0x8, b);
    try { this.socket.end(); } catch (e) { /* ignore */ }
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.parse();
  }

  parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        const hi = this.buf.readUInt32BE(off);
        const lo = this.buf.readUInt32BE(off + 4);
        len = hi * 4294967296 + lo;
        off += 8;
      }
      if (len > MAX_WS_FRAME) { this.close(1009, 'frame too large'); return; }

      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return; // wait for the rest of the frame

      let payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (mask) {
        const p = Buffer.from(payload); // copy: subarray would corrupt the source
        for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
        payload = p;
      }

      switch (opcode) {
        case 0x0: // continuation
          this.frags.push(payload);
          if (fin) {
            const full = Buffer.concat(this.frags);
            const op = this.fragOp;
            this.frags = [];
            this.fragOp = 0;
            this.deliver(op, full);
          }
          break;
        case 0x1: // text
        case 0x2: // binary (we treat it as JSON text too — be liberal)
          if (fin) this.deliver(opcode, payload);
          else { this.fragOp = opcode; this.frags = [payload]; }
          break;
        case 0x8: // close
          if (!this.closed) {
            this.closed = true;
            this.sendFrame(0x8, Buffer.alloc(0));
            try { this.socket.end(); } catch (e) { /* ignore */ }
            this.onclose();
          }
          return;
        case 0x9: // ping -> pong
          this.sendFrame(0xA, payload);
          break;
        case 0xA: // pong — proof the peer is still there
          try { this.onpong(); } catch (e) { /* ignore */ }
          break;
        default:
          break;
      }
    }
  }

  deliver(opcode, payload) {
    let text;
    try { text = payload.toString('utf8'); } catch (e) { return; }
    try { this.onmessage(text); } catch (e) { log('message handler threw:', e && e.message); }
  }
}

// --------------------------------------------------------------- host child ---
let child = null;
let childOut = Buffer.alloc(0);
let childStopTimer = null;
const clients = new Set();

function broadcast(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  for (const peer of clients) peer.sendText(text);
}

function broadcastError(message) {
  broadcast({ type: 'error_from_native_host', payload: { message: 'bridge-host: ' + message } });
}

function nativeFrame(objOrText) {
  const body = Buffer.from(typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function onChildStdout(chunk) {
  childOut = childOut.length ? Buffer.concat([childOut, chunk]) : chunk;
  for (;;) {
    if (childOut.length < 4) return;
    const len = childOut.readUInt32LE(0);
    if (len <= 0 || len > MAX_MSG) {
      log('host sent an invalid frame length (' + len + ') — restarting the host');
      stopChild('bad-frame');
      return;
    }
    if (childOut.length < 4 + len) return;
    const body = childOut.subarray(4, 4 + len).toString('utf8');
    childOut = childOut.subarray(4 + len);
    debug('host -> extension (' + len + 'B):', body.slice(0, 160));
    if (clients.size) broadcast(body); // forward verbatim: same bytes the browser would get
  }
}

function ensureChild() {
  if (child && child.exitCode === null && !child.killed) return child;
  if (childStopTimer) { clearTimeout(childStopTimer); childStopTimer = null; }
  if (!NODE_EXE) { broadcastError('node.exe not found — install Node.js or pass --node <path>'); return null; }
  if (!HOST_SCRIPT || !fs.existsSync(HOST_SCRIPT)) { broadcastError('host script not found — pass --host <path to mcp-chrome-bridge/dist/index.js>'); return null; }

  childOut = Buffer.alloc(0);
  try {
    child = spawn(NODE_EXE, [HOST_SCRIPT], {
      cwd: path.dirname(HOST_SCRIPT),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.assign({}, process.env, { CHROME_MCP_NODE_PATH: NODE_EXE }),
    });
  } catch (e) {
    log('failed to spawn host:', e && e.message);
    broadcastError('failed to spawn host: ' + (e && e.message));
    child = null;
    return null;
  }
  log('spawned host pid=' + child.pid + ' (' + NODE_EXE + ' ' + HOST_SCRIPT + ')');
  child.stdout.on('data', onChildStdout);
  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) log('host stderr: ' + s.split('\n').slice(0, 4).join(' | '));
  });
  child.on('error', (e) => log('host process error:', e && e.message));
  child.on('exit', (code, signal) => {
    log('host exited code=' + code + ' signal=' + signal);
    child = null;
    childOut = Buffer.alloc(0);
    // Native-messaging equivalent: the pipe just closed. Tell the extension so it
    // reconnects (and we respawn a fresh host on its next connection).
    for (const peer of clients) peer.close(1011, 'host-exited');
    clients.clear();
  });
  return child;
}

function stopChild(reason) {
  if (!child) return;
  const c = child;
  child = null;
  log('stopping host (' + reason + ')');
  try { c.stdin.end(); } catch (e) { /* ignore */ }
  setTimeout(() => { try { c.kill(); } catch (e) { /* ignore */ } }, 1200);
}

// ------------------------------------------------------------------ server ----
let wsPort = ARGS.wsPort;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'mcp chrome bridge — manual host',
      version: VERSION,
      wsPort,
      hostPid: child ? child.pid : null,
      clients: clients.size,
      node: NODE_EXE,
      hostScript: HOST_SCRIPT,
    }, null, 2));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  if (clients.size >= 1) {
    // One browser at a time: a second host would fight over the MCP port and
    // could answer tool calls for the wrong browser.
    log('rejected a second client (' + (socket.remoteAddress || '?') + ') — one browser at a time');
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const peer = new WsPeer(socket, socket.remoteAddress || '?');
  clients.add(peer);
  log('client connected from ' + peer.label + ' (clients=' + clients.size + ')');
  pongSeen = Date.now();
  ensureChild();

  peer.onpong = () => { pongSeen = Date.now(); };

  peer.onmessage = (text) => {
    const bytes = Buffer.byteLength(text);
    debug('extension -> host (' + bytes + 'B):', text.slice(0, 160));
    if (bytes > MAX_MSG) {
      peer.sendText(JSON.stringify({
        type: 'error_from_native_host',
        payload: { message: 'message too large for the native host (' + bytes + ' bytes > 16MB cap)' },
      }));
      return;
    }
    const host = ensureChild();
    if (!host || !host.stdin || !host.stdin.writable) {
      peer.sendText(JSON.stringify({ type: 'error_from_native_host', payload: { message: 'bridge-host: host process is not running' } }));
      return;
    }
    try {
      const framed = nativeFrame(text);
      host.stdin.write(framed);
      debug('wrote ' + framed.length + 'B to host stdin (pid ' + host.pid + ')');
    } catch (e) {
      log('failed to write to host stdin:', e && e.message);
    }
  };

  peer.onclose = () => {
    clients.delete(peer);
    log('client disconnected (clients=' + clients.size + ')');
    if (clients.size === 0 && !ARGS.keepAlive) {
      // No browser left -> the host must not linger holding its MCP port, or the
      // next connect would find a "live" port that answers for nobody.
      if (childStopTimer) clearTimeout(childStopTimer);
      childStopTimer = setTimeout(() => { childStopTimer = null; if (clients.size === 0) stopChild('last client left'); }, CLOSE_HOST_GRACE_MS);
    }
  };

  // The frames the extension sends arrive here. Without this listener the socket
  // answers the handshake and then goes deaf - the client says nothing to a bridge
  // that never reads (which is exactly how the START handshake went missing once).
  socket.on('data', (chunk) => peer.feed(chunk));
  socket.on('close', () => {
    if (peer.closed) return;
    peer.closed = true;
    peer.onclose();
  });
  socket.on('error', () => { /* handled by close */ });
  if (head && head.length) peer.feed(head);
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    log('FATAL: port ' + wsPort + ' is already in use — is another bridge-host.exe running?');
    log('       (close it, or start this one with: --ws-port <other>, then set bridgeWsUrl in the extension)');
  } else {
    log('FATAL: server error:', e && e.message);
  }
  fatalExit();
});

// A double-clicked exe closes its console the instant the process exits, taking
// the explanation with it. Hold the window briefly so the reason stays readable.
function fatalExit() {
  log('(this window closes in 15s — copy the message above if you need it)');
  setTimeout(() => process.exit(1), 15000);
}

// ---------------------------------------------------------------- heartbeat ---
// Keeps the loopback connection honest: a half-open socket (browser killed by
// task manager, machine slept) otherwise looks alive forever.
let pongSeen = Date.now();
setInterval(() => {
  if (!clients.size) return;
  if (Date.now() - pongSeen > 90000) {
    log('no pong for 90s — dropping stale clients');
    for (const peer of clients) peer.close(1011, 'heartbeat timeout');
    clients.clear();
    pongSeen = Date.now();
    return;
  }
  for (const peer of clients) peer.sendFrame(0x9, Buffer.alloc(0));
}, 30000).unref?.();

// ------------------------------------------------------------------ banner ----
function banner() {
  log('mcp chrome bridge — manual host v' + VERSION + (isSea() ? ' (standalone exe)' : ' (node script)'));
  log('  listening   ws://127.0.0.1:' + wsPort + '   (health: http://127.0.0.1:' + wsPort + '/health)');
  log('  node        ' + (NODE_EXE || '<not found>'));
  log('  host script ' + (HOST_SCRIPT || '<not found>'));
  log('  logs        ' + LOG_DIR);
  log('  keep this window open — the extension connects automatically.');
}

// ---------------------------------------------------------------- selftest ----
// End-to-end check with no browser: does a raw WS client reach the host, does the
// host start its MCP server on the requested port, does a tool round-trip work?
function selftest() {
  const mcpPort = 12611; // deliberately outside mcpctl's 12306-12340 discovery range
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok });
    log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  };

  const client = new WsPeer({ write() {}, end() {}, destroyed: false, on() {} }, 'selftest');
  let handshakeOk = false;

  const finish = (code) => {
    log(results.every((r) => r.ok) ? 'SELFTEST OK' : 'SELFTEST FAILED');
    stopChild('selftest end');
    setTimeout(() => process.exit(code), 300);
  };

  const socket = require('net').connect(wsPort, '127.0.0.1', () => {
    const key = crypto.randomBytes(16).toString('base64');
    socket.write(
      'GET / HTTP/1.1\r\nHost: 127.0.0.1:' + wsPort + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
    );
  });

  let raw = Buffer.alloc(0);
  let upgraded = false;
  socket.on('data', (chunk) => {
    raw = Buffer.concat([raw, chunk]);
    if (!upgraded) {
      const idx = raw.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = raw.subarray(0, idx).toString('utf8');
      const accept = crypto.createHash('sha1').update(key0 + WS_GUID).digest('base64');
      handshakeOk = /101 Switching Protocols/i.test(head) && head.includes(accept);
      check('websocket handshake (101 + valid Sec-WebSocket-Accept)', handshakeOk);
      upgraded = true;
      raw = raw.subarray(idx + 4);
      if (!handshakeOk) return finish(1);
      // Now speak as the extension does, but as a masking client.
      sendFromClient(JSON.stringify({ type: 'start', payload: { port: mcpPort } }));
      ioProbe();
    } else {
      client.feed(chunk);
    }
  });
  let key0 = null;
  socket.on('connect', () => {});
  // capture the key we generated for the accept comparison
  const origWrite = socket.write.bind(socket);
  socket.write = (d, ...rest) => {
    const s = typeof d === 'string' ? d : d.toString('utf8');
    const m = s.match(/Sec-WebSocket-Key: (\S+)/i);
    if (m) key0 = m[1];
    return origWrite(d, ...rest);
  };

  function sendFromClient(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | payload.length; }
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeUInt32BE(Math.floor(payload.length / 4294967296), 2); header.writeUInt32BE(payload.length >>> 0, 6); }
    header[0] = 0x81;
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    socket.write(Buffer.concat([header, mask, body]));
  }

  let serverStarted = false;
  client.onmessage = (text) => {
    let msg = null;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg && msg.type === 'server_started') {
      serverStarted = true;
      check('host answered server_started for the requested MCP port', true);
    } else if (msg && msg.type === 'error_from_native_host') {
      check('host error: ' + (msg.payload && msg.payload.message), false);
    }
  };

  function ioProbe() {
    // The MCP HTTP server should accept connections on mcpPort shortly after start.
    let tries = 0;
    const attempt = () => {
      const probe = require('net').connect(mcpPort, '127.0.0.1');
      probe.on('connect', () => {
        check('MCP server accepts TCP on ' + mcpPort, true);
        probe.destroy();
        sendFromClient(JSON.stringify({ type: 'stop' }));
        setTimeout(() => {
          check('host answered server_started', serverStarted);
          finish(results.every((r) => r.ok) ? 0 : 1);
        }, 500);
      });
      probe.on('error', () => {
        probe.destroy();
        if (++tries > 40) { check('MCP server accepts TCP on ' + mcpPort, false); finish(1); return; }
        setTimeout(attempt, 100);
      });
    };
    setTimeout(attempt, 400);
  }

  setTimeout(() => { check('selftest finished in time', false); finish(1); }, 20000);
}

// ------------------------------------------------------------------- startup --
if (ARGS.help) {
  process.stdout.write([
    'bridge-host v' + VERSION + ' — manual host for the Chrome MCP Bridge extension',
    '',
    'usage: bridge-host.exe [--ws-port 12400] [--host <dist/index.js>] [--node <node.exe>]',
    '                      [--keep-alive] [--selftest]',
    '',
    '  --ws-port     loopback WebSocket port the extension connects to (default 12400)',
    '  --host        path to mcp-chrome-bridge/dist/index.js (auto-detected by default)',
    '  --node        node.exe used for the host child (auto-detected by default)',
    '  --keep-alive  keep the host child running after the browser disconnects',
    '  --selftest    verify the whole chain without a browser, then exit',
    '',
    'Run it, leave the window open, and the extension connects on its own.',
  ].join('\n') + '\n');
  process.exit(0);
}

banner();
if (!NODE_EXE) log('WARNING: node.exe not found — pass --node <path> (or set CHROME_MCP_NODE_PATH)');
if (!HOST_SCRIPT || !fs.existsSync(HOST_SCRIPT)) log('WARNING: host script not found — pass --host <path to mcp-chrome-bridge/dist/index.js>');

server.listen(wsPort, '127.0.0.1', () => {
  // ws-port 0 = let the OS pick (used by the selftest so a running bridge is no obstacle)
  try {
    const addr = server.address();
    if (addr && addr.port) wsPort = addr.port;
  } catch (e) { /* keep the requested port */ }
  log('ready — waiting for the extension to connect on ws://127.0.0.1:' + wsPort);
  if (ARGS.selftest) selftest();
});

function shutdown() {
  log('shutting down');
  stopChild('shutdown');
  try { server.close(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 400);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
