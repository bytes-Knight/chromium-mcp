// tools/flows.js — record_replay_flow_run dispatcher.
//
// The host's MCP server turns the items returned by rr_list_published_flows
// into dynamic `flow.<slug>` tools (see lib/published-tools.js). Calls to those
// tools are proxied back to this extension as record_replay_flow_run with
// { flowId, args }. We map flowId back to the real registered tool and dispatch,
// stripping the flow-run option keys the host always appends to the schema.
'use strict';

registerTool('record_replay_flow_run', async (args = {}) => {
  const flowId = args.flowId;
  const published = (globalThis.PUBLISHED_TOOLS || []).find((p) => p.id === flowId);
  if (!published) throw new Error(`Unknown published tool/flow id: ${flowId}`);
  const fn = getTool(published.tool);
  if (!fn) throw new Error(`Published tool "${published.tool}" is not registered`);

  const clean = { ...(args.args || {}) };
  // Options the host always injects into flow tool schemas.
  delete clean.tabTarget;
  delete clean.refresh;
  delete clean.captureNetwork;
  delete clean.returnLogs;
  delete clean.timeoutMs;

  return await fn(clean);
});
