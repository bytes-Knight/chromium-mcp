#!/usr/bin/env node
// scripts/build-exe.js — build a Windows .exe from scripts/mcp.js using Node's
// Single Executable Application (SEA) support. The CLI only uses Node built-ins,
// so the whole thing fits in one self-contained binary — no node install needed
// on the target machine.
//
//   node scripts/build-exe.js          # build dist/mcp.exe for this platform
//   node scripts/build-exe.js --run    # ...and smoke-test it (help + status)
//
// Requirements: Node >= 20.12 (SEA), and network access on first run so npx can
// fetch `postject` (the official blob-injection tool).
'use strict';

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const blob = path.join(dist, 'sea-prep.blob');
const exe = path.join(dist, 'mcp.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const nodeExe = process.execPath;

function run(cmd, opts = {}) {
  console.log('$ ' + cmd);
  return execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

// Zero out + truncate the PE certificate table so postject doesn't leave the
// Authenticode signature broken (Windows refuses to load binaries with a
// corrupted signature; the exe is unsigned anyway). Mirrors app/build.js.
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
    console.log('  signature removed (cert table @0x' + va.toString(16) + ', ' + sz + ' bytes)');
  } else {
    console.log('  no Authenticode signature present');
  }
}

function step(name) {
  console.log(`\n== ${name} ==`);
}

try {
  step('1/5 — generate SEA blob (sea-config.json -> dist/sea-prep.blob)');
  fs.mkdirSync(dist, { recursive: true });
  run(`node --experimental-sea-config sea-config.json`);

  step('2/5 — copy node.exe -> dist/mcp.exe');
  if (!fs.existsSync(nodeExe)) throw new Error('cannot locate node.exe: ' + nodeExe);
  fs.copyFileSync(nodeExe, exe);
  console.log('copied ' + nodeExe + ' -> ' + exe);

  step('3/5 — strip Authenticode signature');
  unsign(exe);

  step('4/5 — inject blob with postject');
  run(`npx --yes postject ${JSON.stringify(exe)} NODE_SEA_BLOB ${JSON.stringify(blob)} --sentinel-fuse ${FUSE}`);

  step('5/5 — verify');
  const size = fs.statSync(exe).size;
  console.log(`dist/mcp.exe built (${(size / 1024 / 1024).toFixed(1)} MB)`);
  if (process.argv.includes('--run')) {
    const out = spawnSync(exe, ['help'], { encoding: 'utf8', timeout: 20000 });
    if (out.error) throw out.error;
    if (out.status !== 0) throw new Error('exe smoke test failed (exit ' + out.status + '): ' + out.stderr);
    console.log('\n--- exe help (first 12 lines) ---');
    console.log(out.stdout.split('\n').slice(0, 12).join('\n'));
    console.log('--- exe status ---');
    const st = spawnSync(exe, ['status', '--json'], { encoding: 'utf8', timeout: 20000 });
    console.log(st.stdout.trim() || st.stderr.trim());
  } else {
    console.log('smoke test skipped — run `node scripts/build-exe.js --run` to test it');
  }
  console.log('\nDone. dist/mcp.exe is ready to distribute (dist/ is git-ignored).');
} catch (e) {
  console.error('\nbuild failed: ' + (e && e.message || e));
  process.exit(1);
}
