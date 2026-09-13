#!/usr/bin/env node
// test-launcher.js — packaging contract test for the mcpctl CLI.
//
// Two mutually exclusive packagings install into app/dist:
//   exe mode       app/dist/mcpctl.exe              (node app/build.js)            [default]
//   launcher mode  app/dist/mcpctl + mcpctl.cmd     (node app/build-launcher.js)
//
// Mixed files would run a different binary per shell — cmd.exe resolves .exe
// before .cmd (PATHEXT) while Git Bash resolves the extensionless name first — so
// this suite first asserts exactly one packaging is installed, then asserts that
// mode. The invariants that matter in both modes: the command runs from any
// working directory, exit codes 0-4 survive, and the entrypoint stays tiny and
// single-process.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const APP = path.join(__dirname, '..', 'app');
const DIST = path.join(APP, 'dist');
const EXE = path.join(DIST, 'mcpctl.exe');
const SH = path.join(DIST, 'mcpctl');
const CMD = path.join(DIST, 'mcpctl.cmd');
const ENTRY = path.join(APP, 'bin', 'mcpctl.js');
const IMPL = path.join(APP, 'mcpctl.js');
const ROOT = path.join(__dirname, '..');
const TMP = os.tmpdir();
const QUOTED = 'a b"c';

function hasBash() {
  try { return spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0; } catch (e) { return false; }
}
const BASH = hasBash();

// ------------------------------------------------------------- shared files --
section('artefacts');
ok('app/mcpctl.js (implementation) exists', fs.existsSync(IMPL));
ok('app/bin/mcpctl.js (launcher entrypoint) exists', fs.existsSync(ENTRY));
if (fs.existsSync(ENTRY)) {
  const bytes = fs.statSync(ENTRY).size;
  ok('entrypoint is small (< 2 KB)', bytes < 2048, bytes + ' B');
  const src = fs.readFileSync(ENTRY, 'utf8');
  ok('entrypoint loads the real implementation', /require\(impl\)/.test(src) && /'\.\.', 'mcpctl\.js'/.test(src));
  ok('entrypoint does not spawn a second process', !/\bspawn(Sync)?\(/.test(src));
}

// ----------------------------------------------- which packaging is installed --
section('installed packaging');
const hasExe = fs.existsSync(EXE), hasShim = fs.existsSync(SH), hasCmd = fs.existsSync(CMD);
const modes = (hasExe ? 1 : 0) + (hasShim || hasCmd ? 1 : 0);
ok('exactly one packaging is installed in app/dist', modes === 1,
  'exe=' + hasExe + ' shim=' + hasShim + ' cmd=' + hasCmd);
ok('no leftover app/dist/sea/ directory', !fs.existsSync(path.join(DIST, 'sea')));
const stray = fs.existsSync(DIST) ? fs.readdirSync(DIST).filter((f) => /\.exe$/i.test(f) && f !== 'mcpctl.exe') : [];
ok('no stray .exe files in app/dist', stray.length === 0, stray.join(', '));
console.log('  -> mode: ' + (hasExe ? 'standalone exe  (npm run build)' : 'node launcher  (npm run build:launcher)'));

if (hasExe) {
  // ------------------------------------------------------------------ exe mode --
  section('exe mode');
  const size = fs.statSync(EXE).size;
  const fd = fs.openSync(EXE, 'r');
  const magic = Buffer.alloc(2);
  fs.readSync(fd, magic, 0, 2, 0);
  fs.closeSync(fd);
  ok('exe is a real PE binary (MZ header)', magic.toString('ascii') === 'MZ', JSON.stringify(magic.toString('ascii')));
  ok('exe embeds node (size > 20 MB)', size > 20 * 1024 * 1024, (size / 1048576).toFixed(1) + ' MB');
  ok('launcher shims are absent, so only one binary answers to `mcpctl`', !hasShim && !hasCmd);

  let r = spawnSync(EXE, ['help'], { encoding: 'utf8', cwd: TMP });
  ok('exe help -> exit 0 from an unrelated cwd', r.status === 0, 'exit=' + r.status + ' err=' + (r.stderr || '').trim().slice(0, 60));
  ok('exe help banner is mcpctl', /^mcpctl\b/.test((r.stdout || '').trim()), JSON.stringify((r.stdout || '').split('\n')[0]));
  ok('exe help lists the multi-browser commands', /browsers/.test(r.stdout || ''));

  r = spawnSync(EXE, ['definitely-not-a-command'], { encoding: 'utf8', cwd: TMP });
  ok('exe propagates exit 2 (usage)', r.status === 2, 'exit=' + r.status);

  r = spawnSync(EXE, ['help', QUOTED], { encoding: 'utf8', cwd: TMP });
  ok('exe tolerates an argument containing a space and a quote', r.status === 0, 'exit=' + r.status);

  const rel = spawnSync(EXE, ['help'], { encoding: 'utf8', cwd: ROOT });
  ok('exe works from the repo root too', rel.status === 0 && /mcpctl/.test(rel.stdout || ''));

  if (process.platform === 'win32') {
    const viaCmd = spawnSync('cmd.exe', ['/d', '/c', EXE, 'help'], { encoding: 'utf8', cwd: TMP });
    ok('cmd.exe runs the exe from an unrelated cwd', viaCmd.status === 0 && /^mcpctl\b/.test((viaCmd.stdout || '').trim()), 'exit=' + viaCmd.status);
  }
} else {
  // ------------------------------------------------------------- launcher mode --
  section('launcher mode');
  if (fs.existsSync(SH)) {
    const src = fs.readFileSync(SH, 'utf8');
    ok('posix launcher is a node shebang script', src.startsWith('#!/usr/bin/env node'));
    ok('posix launcher loads the entrypoint relative to itself',
      /require\(require\('path'\)\.join\(__dirname, '\.\.', 'bin', 'mcpctl\.js'\)\)/.test(src));
    ok('posix launcher does not shell out (no bash wrapper hop)', !/bash|BASH_SOURCE/.test(src));
  } else { fail++; console.log('  FAIL app/dist/mcpctl (posix launcher) missing'); }

  if (fs.existsSync(CMD)) {
    const src = fs.readFileSync(CMD, 'utf8');
    ok('cmd shim runs node on the entrypoint', /node "%~dp0/i.test(src));
    ok('cmd shim forwards args (%*)', src.includes('%*'));
    ok('cmd shim propagates the exit code', /exit \/b %errorlevel%/i.test(src));
  } else { fail++; console.log('  FAIL app/dist/mcpctl.cmd (cmd shim) missing'); }

  const viaNode = spawnSync(process.execPath, [ENTRY, 'help'], { encoding: 'utf8', cwd: TMP });
  ok('node app/bin/mcpctl.js help -> exit 0 from an unrelated cwd', viaNode.status === 0, 'exit=' + viaNode.status);
  ok('help output banner is mcpctl', /^mcpctl\b/.test((viaNode.stdout || '').trim()));
  ok('help mentions the multi-browser commands', /browsers/.test(viaNode.stdout || ''));
  const badNode = spawnSync(process.execPath, [ENTRY, 'definitely-not-a-command'], { encoding: 'utf8', cwd: TMP });
  ok('entrypoint propagates exit 2 (usage)', badNode.status === 2, 'exit=' + badNode.status);

  if (!BASH) {
    skip += 4;
    console.log('  skip posix launcher behaviour checks (no bash on PATH)');
  } else {
    // Windows cannot exec an extensionless file itself, so the POSIX launcher is
    // exercised through a shell — the same exec path Git Bash/WSL use, shebang and all.
    const runShim = (args, cwd) => spawnSync('bash', ['-c', 'exec "$0" "${@:1}"', SH].concat(args), { encoding: 'utf8', cwd: cwd || TMP });
    const sh = runShim(['help']);
    ok('posix launcher help -> exit 0 from an unrelated cwd', sh.status === 0, 'exit=' + sh.status + ' err=' + (sh.stderr || '').trim().slice(0, 60));
    ok('posix launcher help banner is mcpctl', /^mcpctl\b/.test((sh.stdout || '').trim()));
    const bad = runShim(['definitely-not-a-command']);
    ok('posix launcher propagates exit 2 (usage)', bad.status === 2, 'exit=' + bad.status);
    const quoted = runShim(['help', QUOTED]);
    ok('posix launcher forwards a quoted argument through "$@"', quoted.status === 0, 'exit=' + quoted.status + ' err=' + (quoted.stderr || '').trim().slice(0, 60));
  }

  if (process.platform === 'win32') {
    const viaCmd = spawnSync('cmd.exe', ['/d', '/c', CMD, 'help'], { encoding: 'utf8', cwd: TMP });
    if (viaCmd.status === 0) {
      ok('cmd shim help -> exit 0 from an unrelated cwd', /^mcpctl\b/.test((viaCmd.stdout || '').trim()), JSON.stringify((viaCmd.stdout || '').split('\n')[0]));
      const bad = spawnSync('cmd.exe', ['/d', '/c', CMD, 'definitely-not-a-command'], { encoding: 'utf8', cwd: TMP });
      ok('cmd shim propagates exit 2 (usage)', bad.status === 2, 'exit=' + bad.status);
    } else {
      skip += 2;
      console.log('  skip cmd shim checks (cmd.exe unusable: exit ' + viaCmd.status + ')');
    }
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
process.exit(fail ? 1 : 0);
