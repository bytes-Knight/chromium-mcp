// tools/instance.js — identity of THIS bridge instance, plus its label.
//
// The CLI calls these through any live port to learn which browser it is
// talking to (browser name/version, label, instanceId, own MCP port) and to
// name that browser so later calls can target it with
// `mcpctl --browser <label> …`. This is the discovery primitive behind
// `mcpctl browsers` / `mcpctl --browser …`.
'use strict';

async function instanceInfo() {
  const [instanceId, label, browser] = await Promise.all([
    BRIDGE_INSTANCE.getInstanceId(),
    BRIDGE_INSTANCE.getLabel(),
    BRIDGE_INSTANCE.getBrowserInfo(),
  ]);
  const livePort = (globalThis.bridge && globalThis.bridge.mcpPort) || null;
  const port = livePort || (await BRIDGE_INSTANCE.getSavedPort());
  return {
    instanceId,
    label,
    browser,
    extensionId: chrome.runtime.id,
    mcpPort: port,
    endpoint: port ? `http://127.0.0.1:${port}/mcp` : null,
    connected: !!(globalThis.bridge && globalThis.bridge.connected),
    serverRunning: !!(globalThis.bridge && globalThis.bridge.serverRunning),
  };
}

registerTool('bridge_get_instance_info', async () => ok(await instanceInfo()));

// Set this browser's label (e.g. "work", "edge-victim"). Persisted in
// chrome.storage.local, so it survives restarts and service-worker eviction.
// Also offered in the popup for the cases where the CLI can't reach the browser.
registerTool('bridge_set_instance_label', async (args = {}) => {
  const label = String(args.label == null ? '' : args.label).trim().slice(0, 60);
  await BRIDGE_INSTANCE.setLabel(label);
  return ok({ ok: true, label, instance: await instanceInfo() });
});
