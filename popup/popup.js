// popup/popup.js — status display, connect/disconnect, endpoint copy.
'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function setPill(id, state, text) {
  const el = $(id);
  el.className = 'pill ' + state;
  el.textContent = text;
}

function log(msg, isErr) {
  const div = document.createElement('div');
  div.className = 'entry' + (isErr ? ' err' : '');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toLocaleTimeString();
  div.appendChild(t);
  div.appendChild(document.createTextNode(msg));
  logEl.appendChild(div);
  while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: 'bridge-status' }).catch(() => null);
  const status = resp || {};
  setPill('pill-native', status.connected ? 'ok' : 'bad', status.connected ? 'connected' : 'offline');
  setPill('pill-server', status.serverRunning ? 'ok' : (status.connected ? 'busy' : 'bad'), status.serverRunning ? 'running' : (status.connected ? 'starting…' : 'stopped'));
  if (status.mcpPort) {
    $('port').value = status.mcpPort;
    $('endpoint').textContent = `http://127.0.0.1:${status.mcpPort}/mcp`;
  }
  if (status.hostName) $('ext-id').textContent = `host: ${status.hostName}`;
  return status;
}

$('connect-btn').addEventListener('click', async () => {
  const port = parseInt($('port').value, 10) || 12306;
  const resp = await chrome.runtime.sendMessage({ type: 'bridge-connect', port }).catch(() => null);
  if (resp) {
    log(`connect → native=${resp.connected ? 'yes' : 'no'} server=${resp.serverRunning ? 'running' : 'waiting'}`);
  } else {
    log('connect failed: host not reachable (is mcp-chrome-bridge installed?)', true);
  }
  refresh();
});

$('disconnect-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'bridge-disconnect' }).catch(() => null);
  log('disconnected');
  refresh();
});

$('copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('endpoint').textContent);
    log('endpoint copied');
  } catch (e) {
    log('copy failed', true);
  }
});

$('clear-log').addEventListener('click', () => { logEl.innerHTML = ''; });

refresh().then((s) => {
  if (!s || !s.connected) log('Click Connect to start the MCP server');
}).catch(() => log('Popup could not reach the background worker', true));
