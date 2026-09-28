#!/usr/bin/env node
// scripts/host-standalone.js — start the mcp-chrome-bridge native host by hand,
// WITHOUT a browser, on a chosen MCP port. The native host normally speaks
// length-prefixed JSON over the extension's stdin/stdout; this plays the
// extension's side of that pipe and then holds it open.
//
// Why: mcpctl targets ports across a range (each browser instance owns one), so
// when a browser isn't running you still want a real MCP endpoint to test CLI
// discovery, port selection and error paths against.
//
// Usage: node scripts/host-standalone.js [port]     (default 12306)
//        Ctrl-C to stop (the host dies with the closed pipe).
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const port = parseInt(process.argv[2], 10) || 12306;

// Locate the installed host the way the native-messaging manifest points at it.
function findHostJs() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'mcp-chrome-bridge', 'dist', 'index.js'),
    path.join(process.env.ProgramFiles || '', 'nodejs', 'node_modules', 'mcp-chrome-bridge', 'dist', 'index.js'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('mcp-chrome-bridge dist/index.js not found — npm i -g mcp-chrome-bridge');
}

function frame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

const host = spawn(process.execPath, [findHostJs()], { stdio: ['pipe', 'pipe', 'pipe'] });
host.stderr.on('data', (d) => process.stderr.write('[host] ' + d.toString()));
host.stdout.on('data', (d) => process.stderr.write('[host] ' + d.toString()));
host.on('exit', (code) => {
  process.stderr.write(`[host] exited (${code})\n`);
  process.exit(code || 0);
});

setTimeout(() => {
  host.stdin.write(frame({ type: 'start', payload: { port } }));
  process.stderr.write(`[host] asked for MCP server on http://127.0.0.1:${port}/mcp\n`);
}, 800);

process.on('SIGINT', () => { try { host.kill(); } catch (e) { /* ignore */ } process.exit(0); });
