#!/usr/bin/env node
// build.js — compile mcpctl.js into a standalone mcpctl.exe using Node SEA.
// Runtime: zero dependencies. Build-time: npm i -g postject.
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
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAIN = path.join(ROOT, 'mcpctl.js');
const BLOB = path.join(ROOT, 'sea-prep.blob');
const SEA_CFG = path.join(ROOT, 'sea-config.json');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'mcpctl.exe');

if (!fs.existsSync(MAIN)) {
  console.error('mcpctl.js not found at ' + MAIN);
  process.exit(1);
}
fs.mkdirSync(DIST, { recursive: true });

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
const POSTJECT_CLI = path.join(require('child_process').execSync('npm root -g', { encoding: 'utf8' }).trim(), 'postject', 'dist', 'cli.js');
console.log('injecting via postject (' + POSTJECT_CLI + ')');
execFileSync(process.execPath, [POSTJECT_CLI, OUT, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE], { stdio: 'inherit' });

const finalSize = fs.statSync(OUT).size;
const check = fs.readFileSync(OUT);
const found = check.indexOf(FUSE);
const after = check[found + FUSE.length] === 0x3a && String.fromCharCode(check[found + FUSE.length + 1]);
console.log('built ' + OUT + ' (' + finalSize + ' bytes)');
console.log('  verify: fuse@' + found + ' flippedTo=' + after + ' end=%8=' + (check.length % 8));
console.log('run: ' + OUT + ' help');
