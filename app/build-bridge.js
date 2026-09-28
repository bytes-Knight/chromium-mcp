#!/usr/bin/env node
// build-bridge.js — compile bridge-host.js into the standalone bridge-host.exe
// (Node SEA), the manual host you double-click when the browser will not spawn
// the native-messaging host.
//
// Same packaging as app/build.js (and for the same reasons):
//   1. generate sea-config.json + blob via --experimental-sea-config
//   2. copy the running node.exe
//   3. strip the Authenticode certificate table from the PE headers (appending a
//      blob invalidates the signature, and Windows refuses to load a binary whose
//      signature is broken)
//   4. inject the blob as the PE resource NODE_SEA_BLOB via postject
//
// Unlike mcpctl.exe this one is small work at runtime but still ~92 MB on disk,
// because it IS node.exe — which is exactly why it needs no runtime at all.
//
// Build-time dependency: npm i -g postject
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAIN = path.join(ROOT, 'bridge-host.js');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'bridge-host.exe');
const BLOB = path.join(ROOT, 'sea-prep.bridge-host.blob'); // gitignored
const SEA_CFG = path.join(ROOT, 'sea-config.bridge-host.json'); // gitignored

function die(msg) { console.error('build-bridge: ' + msg); process.exit(1); }

if (!fs.existsSync(MAIN)) die('missing ' + MAIN);
fs.mkdirSync(DIST, { recursive: true });

// 0. the source must parse — a syntax error here becomes a broken 92 MB binary.
execFileSync(process.execPath, ['--check', MAIN], { stdio: 'inherit' });

// 1. config + blob
fs.writeFileSync(SEA_CFG, JSON.stringify({ main: MAIN, output: BLOB, disableExperimentalSEAWarning: true }, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', SEA_CFG], { stdio: 'inherit' });

// 2. copy node.exe
fs.copyFileSync(process.execPath, OUT);

// 3. strip Authenticode signature (zero + truncate the certificate table)
function unsign(file) {
  let b = fs.readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('ascii', pe, pe + 4) !== 'PE\x00\x00') throw new Error('not a PE file: ' + file);
  const magic = b.readUInt16LE(pe + 24); // 0x10b = PE32, 0x20b = PE32+
  const ddBase = magic === 0x20b ? pe + 24 + 112 : pe + 24 + 96;
  const sec = ddBase + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY = 4
  const va = b.readUInt32LE(sec);
  const sz = b.readUInt32LE(sec + 4);
  if (va !== 0 || sz !== 0) {
    if (va > 0 && va <= b.length) b = b.slice(0, va);
    b.writeUInt32LE(0, sec);
    b.writeUInt32LE(0, sec + 4);
    fs.writeFileSync(file, b);
    console.log(`  signature removed (cert table @0x${va.toString(16)}, ${sz} bytes)`);
  } else {
    console.log('  no Authenticode signature present');
  }
}

console.log('stripping signature from ' + OUT);
unsign(OUT);

// 4. inject the blob as a PE resource (flips the SEA sentinel fuse 0 -> 1)
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
function postjectCli() {
  const cands = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'postject', 'dist', 'cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'postject', 'dist', 'cli.js'),
    '/usr/local/lib/node_modules/postject/dist/cli.js',
    '/usr/lib/node_modules/postject/dist/cli.js',
  ];
  const hit = cands.find((p) => p && fs.existsSync(p));
  if (hit) return hit;
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
  return path.join(root, 'postject', 'dist', 'cli.js');
}
const POSTJECT_CLI = postjectCli();
if (!fs.existsSync(POSTJECT_CLI)) die('postject not found at ' + POSTJECT_CLI + ' — install it with: npm i -g postject');
console.log('injecting via postject (' + POSTJECT_CLI + ')');
execFileSync(process.execPath, [POSTJECT_CLI, OUT, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE], { stdio: 'inherit' });

// 5. self-test: run the built exe itself and make it prove the whole chain —
//    WS handshake -> host child spawn -> MCP server accepting TCP on the port the
//    "extension" asked for. Uses ws-port 0 so an already-running bridge is fine.
console.log('running the exe self-test (websocket -> host child -> MCP server)');
let out = '';
try {
  out = execFileSync(OUT, ['--selftest', '--ws-port', '0'], { encoding: 'utf8', timeout: 60000 });
} catch (e) {
  out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  console.error(out.trim());
  die('self-test failed: ' + String((e && e.message) || e).split('\n')[0]);
}
const pass = (out.match(/^\[[^\]]+\] PASS {2}.*$/gm) || []).map((l) => l.replace(/^\[[^\]]+\]\s*/, ''));
if (!/SELFTEST OK/.test(out)) { console.error(out.trim()); die('self-test did not report SELFTEST OK'); }
for (const line of pass) console.log('  ' + line);

const bytes = fs.statSync(OUT).size;
const sha = crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex');
console.log('built standalone bridge-host.exe:');
console.log('  ' + path.relative(ROOT, OUT) + '  ' + bytes + ' bytes (' + (bytes / 1048576).toFixed(1) + ' MB)');
console.log('  sha256     ' + sha);
console.log('  node       ' + process.version + ' (' + process.execPath + ')');
console.log('  self-test  websocket handshake, host child spawn and MCP server all verified');
console.log('run it (keep the window open) and the extension connects on its own.');
