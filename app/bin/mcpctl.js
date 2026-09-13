#!/usr/bin/env node
// mcpctl.js (entrypoint) — launches the mcpctl CLI on node.
//
// This exists so mcpctl is NOT distributed as a packed single-file binary. The
// previous packaging was a Node SEA build: a 91 MB copy of node.exe with the
// Authenticode signature stripped and the app blob injected as a PE resource.
// That is the exact shape AV heuristics block, quarantine, or scan on launch,
// and it had to be rebuilt after every source edit.
//
// Here the CLI is plain source, run by the (already-present, signed) system
// node: ~1 KB on PATH instead of ~92 MB, no rebuild step, nothing packed.
//
// It deliberately `require`s the implementation instead of spawning it, so the
// whole CLI stays one process: argv, stdio, exit codes, signals, and the REPL's
// TTY all behave exactly as before. `require` resolves against this file, so
// the entrypoint works from any working directory.
'use strict';

const fs = require('fs');
const path = require('path');

const impl = path.join(__dirname, '..', 'mcpctl.js');
if (!fs.existsSync(impl)) {
  console.error('mcpctl: implementation not found at ' + impl);
  process.exit(2);
}

require(impl);
