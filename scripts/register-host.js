#!/usr/bin/env node
// scripts/register-host.js
// Registers this clean-room extension with the mcp-chrome-bridge native host
// (com.chromemcp.nativehost) for Chrome, Chromium, and Brave variants.
//
// The host manifest's allowed_origins only listed the official extension ID, so
// our extension could never connect. This script MERGES our ID into
// allowed_origins (keeping any existing IDs) and writes the per-browser
// manifest + Windows registry entries.
//
// Usage:
//   node register-host.js                          # dry run (shows what changes)
//   node register-host.js --apply                  # write everything
//   node register-host.js --apply --browser brave-beta   # only Brave-Beta
//   node register-host.js --revert                 # remove our ID again
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// Deterministic IDs (derived from the RSA "key" pinned in manifest.json).
const OUR_ID = 'agfodficabgggjoapjaphagdcpnoeggc';
const OFFICIAL_ID = 'hbdgbgagpkpjffpklnamcljpakneikee';
const HOST_NAME = 'com.chromemcp.nativehost';
const IS_WIN = process.platform === 'win32';

const isApply = process.argv.includes('--apply');
const isRevert = process.argv.includes('--revert');
const browserArg = (() => {
  const i = process.argv.indexOf('--browser');
  if (i === -1) return null;
  return process.argv[i + 1] || null;
})();

function env(name, fallback) {
  return process.env[name] || fallback;
}

// Resolve the host binary path — reuse the existing Chrome manifest's "path" so
// we always point at the exact run_host script npm installed.
function resolveHostPath() {
  const ap = env('APPDATA', path.join(os.homedir(), 'AppData', 'Roaming'));
  const chromeManifest = path.join(ap, 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
  if (fs.existsSync(chromeManifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(chromeManifest, 'utf8'));
      if (m.path && fs.existsSync(m.path)) return m.path;
    } catch (e) { /* fall through */ }
  }
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const candidate = path.join(npmRoot, 'mcp-chrome-bridge', 'dist', IS_WIN ? 'run_host.bat' : 'run_host.sh');
    if (fs.existsSync(candidate)) return candidate;
  } catch (e) { /* fall through */ }
  throw new Error('Could not locate mcp-chrome-bridge run_host script. Install it first: npm install -g mcp-chrome-bridge');
}

function browserConfigs() {
  const ap = env('APPDATA', path.join(os.homedir(), 'AppData', 'Roaming'));
  const la = env('LOCALAPPDATA', path.join(os.homedir(), 'AppData', 'Local'));
  const home = os.homedir();

  if (IS_WIN) {
    return [
      {
        id: 'chrome',
        display: 'Google Chrome',
        reg: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
        manifestDir: path.join(ap, 'Google', 'Chrome', 'NativeMessagingHosts'),
      },
      {
        id: 'chromium',
        display: 'Chromium',
        reg: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
        manifestDir: path.join(ap, 'Chromium', 'NativeMessagingHosts'),
      },
      {
        id: 'brave',
        display: 'Brave',
        reg: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`,
        manifestDir: path.join(la, 'BraveSoftware', 'Brave-Browser', 'User Data', 'NativeMessagingHosts'),
      },
      {
        id: 'brave-beta',
        display: 'Brave-Beta',
        reg: `HKCU\\Software\\BraveSoftware\\Brave-Browser-Beta\\NativeMessagingHosts\\${HOST_NAME}`,
        manifestDir: path.join(la, 'BraveSoftware', 'Brave-Browser-Beta', 'User Data', 'NativeMessagingHosts'),
      },
      {
        id: 'brave-nightly',
        display: 'Brave-Nightly',
        reg: `HKCU\\Software\\BraveSoftware\\Brave-Browser-Nightly\\NativeMessagingHosts\\${HOST_NAME}`,
        manifestDir: path.join(la, 'BraveSoftware', 'Brave-Browser-Nightly', 'User Data', 'NativeMessagingHosts'),
      },
    ];
  }
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [
      { id: 'chrome', display: 'Google Chrome', reg: null, manifestDir: path.join(base, 'Google', 'Chrome', 'NativeMessagingHosts') },
      { id: 'chromium', display: 'Chromium', reg: null, manifestDir: path.join(base, 'Chromium', 'NativeMessagingHosts') },
      { id: 'brave', display: 'Brave', reg: null, manifestDir: path.join(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
      { id: 'brave-beta', display: 'Brave-Beta', reg: null, manifestDir: path.join(base, 'BraveSoftware', 'Brave-Browser-Beta', 'NativeMessagingHosts') },
      { id: 'brave-nightly', display: 'Brave-Nightly', reg: null, manifestDir: path.join(base, 'BraveSoftware', 'Brave-Browser-Nightly', 'NativeMessagingHosts') },
    ];
  }
  const base = path.join(home, '.config');
  return [
    { id: 'chrome', display: 'Google Chrome', reg: null, manifestDir: path.join(base, 'google-chrome', 'NativeMessagingHosts') },
    { id: 'chromium', display: 'Chromium', reg: null, manifestDir: path.join(base, 'chromium', 'NativeMessagingHosts') },
    { id: 'brave', display: 'Brave', reg: null, manifestDir: path.join(base, 'brave-browser', 'NativeMessagingHosts') },
    { id: 'brave-beta', display: 'Brave-Beta', reg: null, manifestDir: path.join(base, 'brave-browser-beta', 'NativeMessagingHosts') },
    { id: 'brave-nightly', display: 'Brave-Nightly', reg: null, manifestDir: path.join(base, 'brave-browser-nightly', 'NativeMessagingHosts') },
  ];
}

function ourOrigin() {
  return `chrome-extension://${OUR_ID}/`;
}

function readManifest(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function main() {
  const hostPath = resolveHostPath();
  const browsers = browserConfigs();
  const selected = browserArg
    ? browsers.filter((b) => b.id === browserArg || b.id.toLowerCase() === browserArg.toLowerCase())
    : browsers;
  if (!selected.length) {
    console.error(`✖ Unknown browser "${browserArg}". Choose from: ${browsers.map((b) => b.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`Host binary: ${hostPath}`);
  console.log(`Our extension ID: ${OUR_ID}`);
  console.log(isApply ? 'MODE: apply' : isRevert ? 'MODE: revert' : 'MODE: dry run');

  let changed = 0;
  for (const b of selected) {
    const file = path.join(b.manifestDir, `${HOST_NAME}.json`);
    const existing = readManifest(file);
    const origins = new Set((existing && Array.isArray(existing.allowed_origins) ? existing.allowed_origins : []));
    const hadOur = origins.has(ourOrigin());

    if (isRevert) {
      if (!hadOur) {
        console.log(`\n[${b.display}] our ID not present — nothing to do.`);
        continue;
      }
      origins.delete(ourOrigin());
      if (!isApply) {
        console.log(`\n[${b.display}] would remove ${ourOrigin()} from ${file}`);
        continue;
      }
      if (origins.size === 0) {
        // Only our ID was there; remove the manifest + registry key
        try { fs.unlinkSync(file); console.log(`\n[${b.display}] removed manifest ${file}`); } catch (e) { /* ignore */ }
        if (IS_WIN && b.reg) {
          try { execSync(`reg delete "${b.reg}" /f`, { stdio: 'pipe' }); console.log(`[${b.display}] removed registry key ${b.reg}`); } catch (e) { /* ignore */ }
        }
      } else {
        writeManifest(b, file, existing, [...origins], hostPath);
        console.log(`\n[${b.display}] removed our ID; kept: ${[...origins].join(', ')}`);
      }
      changed++;
      continue;
    }

    if (hadOur) {
      console.log(`\n[${b.display}] ✓ our ID already allowed at ${file}`);
      continue;
    }
    const next = [...origins, ourOrigin()];
    if (!isApply) {
      console.log(`\n[${b.display}] would write ${file}`);
      console.log(`    allowed_origins: ${next.join(', ')}`);
      changed++;
      continue;
    }
    writeManifest(b, file, existing, next, hostPath);
    console.log(`\n[${b.display}] ✓ registered ${file}`);
    console.log(`    allowed_origins: ${next.join(', ')}`);
    changed++;
  }

  if (!isApply && changed) {
    console.log('\nDry run only — re-run with --apply to write.');
  } else if (isApply) {
    console.log('\nDone. RESTART your browser (fully quit and reopen) so it picks up the');
    console.log('native-messaging registration, then reload the extension and click Connect.');
  } else {
    console.log('\nEverything already registered.');
  }
}

function writeManifest(b, file, existing, origins, hostPath) {
  const manifest = existing || {};
  manifest.name = HOST_NAME;
  manifest.description = manifest.description || 'Node.js Host for Browser Bridge Extension';
  manifest.path = hostPath;
  manifest.type = 'stdio';
  manifest.allowed_origins = origins;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  if (IS_WIN && b.reg) {
    execSync(`reg add "${b.reg}" /ve /t REG_SZ /d "${file}" /f`, { stdio: 'pipe' });
  }
}

try {
  main();
} catch (e) {
  console.error('✖ ' + e.message);
  process.exit(1);
}
