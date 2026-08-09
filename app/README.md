# mcpctl — standalone Chrome MCP bridge CLI

Zero-dependency command-line client for the Chrome MCP bridge
(`http://127.0.0.1:12306/mcp`), packaged as a single Windows executable via
Node Single Executable Application (SEA).

## Build

Requirements: Node.js (v24 LTS), `postject` (`npm i -g postject`).

```
node app\build.js
```

Produces `app\dist\mcpctl.exe` (a copy of `node.exe` with the Authenticode
signature stripped and the SEA blob injected as a PE resource by postject).

Run without arguments or `--help` on the built exe for the full command list.

## Usage

```
mcpctl status                 bridge health + host PID
mcpctl eval "40+2"            run JS in the active tab
mcpctl tabs | active          list windows/tabs, active tab info
mcpctl switch <tabId>         switch to tab
mcpctl shot --out t.png       screenshot the active tab
mcpctl read [--depth N]       read page structure / interactive elements
mcpctl click "Button text"    click an element
mcpctl fill "Search" "value"  fill an input
mcpctl keys "Ctrl+l"          send keyboard shortcuts
mcpctl nav https://...        navigate the active tab
mcpctl net start --bodies     capture network activity
mcpctl console --errors       poll console messages
mcpctl tools                  list the bridge's MCP tools
mcpctl call <tool> <json>     call any bridge tool directly
mcpctl batch file.json        run a JSON-array / JSONL batch of tool calls
mcpctl repl                   interactive REPL (!tool {json} for raw calls)
```

Global flags: `--json` (raw output), `--tab <id>`, `--port <n>`, `--host <h>`,
`--timeout <sec>`. Env vars: `MCP_PORT`, `MCP_HOST`. Type `mcpctl help` for
per-command flags.

## Notes / limitations

- The bridge host keeps a single MCP session; run mcpctl commands serially.
  Concurrent invocations can collide and trigger a host restart.
- If the browser idle-kills the service worker mid-call the host exits and the
  in-flight request dies ("terminated"). mcpctl detects this, waits for the
  extension to respawn the host (alarm-based, unlimited), and retries
  automatically.
- The extension's `background.js` keeps the native port alive with a keepalive
  ping and reconnects via `chrome.alarms` (service-worker-safe).
