#!/usr/bin/env node
// build.js — compile mcpctl.js into the standalone single-file mcpctl.exe (Node SEA)
// and install it into app/dist, the directory on PATH.
//
// This is the default packaging: one self-contained .exe that runs on a machine
// with no node installed. The other packaging is a ~1 KB node launcher
// (app/bin/mcpctl.js + app/dist shims) installed by: node app/build-launcher.js
//
// The two are mutually exclusive on purpose. cmd.exe resolves .exe before .cmd
// (PATHEXT) while Git Bash resolves the extensionless name first, so installing
// both into app/dist would run different binaries depending on the shell, with
// nothing telling you which. Whichever mode is installed, the other one's files
// are removed (launcher mode also removes the exe).
//
// Trade-off, recorded so this stays a deliberate choice: the output is a ~92 MB
// copy of node.exe with the Authenticode signature stripped (Windows refuses to
// load a broken signature once the blob is appended) and the app blob injected as
// a PE resource. That shape is what AV heuristics may scan, block, or quarantine
// on launch, and the binary must be rebuilt after every source edit — unlike the
// launcher, which re-reads mcpctl.js live. The build is deterministic: the same
// node + the same source yields a byte-identical exe (sha256 is printed below).
//
// Runtime: zero dependencies. Build-time: npm i -g postject
//   1. generate sea-config.json + blob via --experimental-sea-config
//   2. copy the running node.exe
//   3. strip the Authenticode certificate table from the PE headers
//      (the signature would be invalidated by appending, and Windows refuses
//      to load binaries with a broken Authenticode signature)
//   4. inject the blob as a PE resource named NODE_SEA_BLOB via postject
//      (appending at EOF is NOT enough on Windows; the loader uses
//      FindResource/LoadResource, and the sentinel fuse is flipped to :1)
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAIN = path.join(ROOT, 'mcpctl.js');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'mcpctl.exe');
const BLOB = path.join(ROOT, 'sea-prep.blob'); // gitignored
const SEA_CFG = path.join(ROOT, 'sea-config.json'); // gitignored
const SH = path.join(DIST, 'mcpctl'); // launcher-mode shims, removed below
const CMD = path.join(DIST, 'mcpctl.cmd');
const OLD_SEA_DIR = path.join(DIST, 'sea'); // layout used by the earlier optional build

function die(msg) { console.error('build: ' + msg); process.exit(1); }

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
    if (va > 0 && va <= b.length) b = b.slice(0, va); // drop the certificate data
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

// 4. inject blob as PE resource via postject (flips sentinel fuse 0 -> 1)
// (postject installed via: npm i -g postject; pass the fuse WITHOUT the :0
//  suffix — postject locates it in node's sea.cc loader code and flips the
//  trailing 0 to 1 to mark the injection)
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
// Locate postject without shelling out when we can: spawning `npm` on Windows
// needs shell:true (npm is a .cmd), which trips Node's DEP0190 warning.
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

// 5. this mode owns app/dist: remove the other mode's launcher shims, so exactly
//    one binary can ever answer to `mcpctl`.
const removed = [];
for (const f of [SH, CMD]) if (fs.existsSync(f)) { fs.rmSync(f); removed.push(path.basename(f)); }
if (fs.existsSync(OLD_SEA_DIR)) { fs.rmSync(OLD_SEA_DIR, { recursive: true }); removed.push('sea/'); }
if (removed.length) console.log('  removed launcher-mode files: ' + removed.join(', '));

// 6. self-test: run the built exe itself (not node) and check it answers.
let help = '';
try {
  help = execFileSync(OUT, ['help'], { encoding: 'utf8' });
} catch (e) {
  die('self-test failed: ' + OUT + ' help -> ' + String((e && e.message) || e).split('\n')[0]);
}
const banner = (help.split('\n')[0] || '').trim();
if (!/^mcpctl\b/.test(banner)) die('self-test failed: unexpected help banner: ' + JSON.stringify(banner));

const bytes = fs.statSync(OUT).size;
const sha = crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex');
const fuseAt = fs.readFileSync(OUT).indexOf(FUSE);

console.log('built standalone mcpctl.exe:');
console.log('  ' + path.relative(ROOT, OUT) + '  ' + bytes + ' bytes (' + (bytes / 1048576).toFixed(1) + ' MB)');
console.log('  sha256     ' + sha);
console.log('  fuse       @' + fuseAt + ' (injected)');
console.log('  node       ' + process.version + ' (' + process.execPath + ')');
console.log('  self-test  ran the exe itself: "' + banner + '"');
console.log('  portable   copy this one file anywhere; it needs no node and no install');
console.log('run: mcpctl help   (or: ' + OUT + ' help)');
