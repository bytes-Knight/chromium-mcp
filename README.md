# Chrome MCP Bridge — clean-room extension

A from-scratch Chrome extension that replaces the bundled mcp-chrome-bridge
extension. It connects to the **same native host** (`com.chromemcp.nativehost`)
shipped by [`mcp-chrome-bridge`](https://www.npmjs.com/package/mcp-chrome-bridge),
so any MCP client pointed at `http://127.0.0.1:12306/mcp` (or your configured
port) gets full browser control with zero changes to the host or the MCP server.

Built against the protocol reverse-engineered from `mcp-chrome-bridge@1.0.31`
(see [Protocol](#protocol) below).

## Layout

```
manifest.json          MV3 manifest with pinned identity (key → stable ID)
background.js          Service worker: native-messaging client + tool dispatcher
lib/
  protocol.js          Wire-protocol constants, tool registry, result helpers
  cdp.js               chrome.debugger promisified helpers (CDP eval, capture)
  tabs.js              Tab resolution + executeScript injection helpers
tools/
  browser.js           get_windows_and_tabs, chrome_navigate/switch_tab/close_tabs
  content.js           chrome_get_web_content, chrome_get_interactive_elements
  interaction.js       chrome_click_element/fill_or_select/keyboard/javascript
  network.js           chrome_network_request + chrome_network_capture
  screenshot.js        chrome_screenshot (viewport, full-page, element via CDP)
  console.js           chrome_console (buffer from content script)
  data.js              chrome_history, chrome_bookmark_* 
  inject.js            chrome_inject_script, chrome_send_command_to_inject_script
  misc.js              chrome_read_page, chrome_computer (subset), dialogs,
                       downloads, uploads, element selection
content/console-capture.js   document_start content script that buffers console
popup/                 Status + connect/disconnect UI
scripts/
  make-icons.js        Generates the PNG icons (pure Node, no deps)
  register-host.js     Adds this extension's ID to the native host allowed_origins
```

## Install

1. **Install the native host** (once): `npm install -g mcp-chrome-bridge` then
   `mcp-chrome-bridge register`. (If it's already installed, skip this.)
2. **Grant this extension access to the host** — the registered host manifest
   only allows the official extension ID, so ours must be added:

   ```bash
   node scripts/register-host.js --apply
   ```

   Then **fully restart Chrome** (the native-messaging manifest is read at
   browser start).
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**
   and select this folder (`chrome-mcp-extension/`).
4. Click the extension icon → **Connect**. The MCP server starts on
   `http://127.0.0.1:12306/mcp` (configurable in the popup).

The extension's ID is **stable** because `manifest.json` pins a `key` (an RSA
public key). The ID derived from it is `agfodficabgggjoapjaphagdcpnoeggc`, which
is what `register-host.js` whitelists. Re-loading or moving the folder never
changes it.

## Using it

Point any MCP client (Claude Desktop, Cherry Studio, `bridge-raw.js`, etc.) at:

```
http://127.0.0.1:12306/mcp
```

Example one-shot check with the repo's raw client:

```bash
node bridge-raw.js chrome_get_windows_and_tabs '{}'
node bridge-raw.js chrome_navigate '{"url":"https://example.com"}'
```

## Protocol

The extension speaks the native-messaging protocol used by the official
extension (reverse-engineered from the installed `mcp-chrome-bridge` package):

- Host name: `com.chromemcp.nativehost` (stdio native messaging, 4-byte
  little-endian length framing handled by Chrome).
- On connect the extension sends `{type:"start", payload:{port:12306}}`; the
  host boots the Fastify MCP server and replies `server_started`.
- The MCP server forwards tool calls to the extension as
  `{type:"call_tool", payload:{name, args}, requestId}`.
- The extension replies with
  `{responseToRequestId, payload:{status:"success", data}}` where `data` is an
  MCP result (`{content:[{type:"text",text}]}`), or
  `{responseToRequestId, payload:{status:"error", error:"…"}}`.
- `rr_list_published_flows` is answered with an empty item list (this build has
  no recorded-flow tools).
- Liveness: the worker pings the host (`ping_from_extension`) via a keepalive
  alarm, and auto-reconnects up to 5 times if the host restarts.

## Tools

Browser: `get_windows_and_tabs`, `chrome_navigate`, `chrome_switch_tab`,
`chrome_close_tabs`, `chrome_go_back_or_forward`.

Content: `chrome_get_web_content`, `chrome_get_interactive_elements`,
`chrome_read_page` (ref-based element tree for click/fill targeting).

Interaction: `chrome_click_element`, `chrome_fill_or_select`, `chrome_keyboard`,
`chrome_javascript` (async JS in the page via CDP with executeScript fallback),
`chrome_computer` (screenshot / click / type / key / scroll / scroll_to / wait /
resize_page / hover / fill / fill_form subset).

Network: `chrome_network_request` (page-context fetch with cookies),
`chrome_network_capture` (start/stop; webRequest entries, optional response
bodies via the debugger API).

Media: `chrome_screenshot` (viewport via `captureVisibleTab`; full-page and
element captures via CDP; optional save-to-downloads or base64).

Data: `chrome_history`, `chrome_bookmark_search`, `chrome_bookmark_add`,
`chrome_bookmark_delete`.

Injection: `chrome_inject_script`, `chrome_send_command_to_inject_script`.

Misc: `chrome_console` (snapshot/buffer), `chrome_handle_dialog`,
`chrome_handle_download`, `chrome_upload_file` (CDP file input),
`chrome_request_element_selection` (click-to-pick overlay).

Not implemented in this build (return clean errors): `chrome_gif_recorder`,
`performance_start_trace`, `performance_stop_trace`,
`performance_analyze_insight`.

## CLI (`mcp`)

A single-command CLI wraps all bridge calls with automatic host recovery
(kills a wedged host and waits for the extension to respawn it) and proper
session cleanup, so you never hit the bridge's single-session limit.

```bash
# Windows / bash both work
mcp status                # bridge health + host PID
mcp restart               # kill stuck host, wait for respawn
mcp tabs                  # windows + tabs
mcp active                # active tab
mcp switch <tabId>

mcp read --interactive    # interactive elements with ref_ ids
mcp eval 'document.title' # run JS expression in the page
mcp run 'return 1+1'      # run a JS block (async body, must return)
mcp click '#button'       # or ref_12
mcp fill 'input' 'value'
mcp keys 'Enter'
mcp nav 'https://…'       # url | back | forward | reload
mcp shot --full --out page.png

mcp tools                 # list bridge tools
mcp call <tool> '{"k":1}' # raw tool call
mcp storage               # localStorage/sessionStorage/cookies/IndexedDB
mcp sn-state              # Standard Notes key/lock state summary
mcp unlock '<passcode>'   # unlock the SN passcode lock screen
mcp lock                  # re-lock SN

mcp repl                  # interactive session (single persistent MCP session)
mcp help
```

Flags: `--json` for machine-readable output, `--tab <id>` to target a specific
tab, `--depth N` / `--ref ref_X` to narrow `read`, `--out file.png` to save a
screenshot. Launchers: `scripts/mcp.js` (node), `mcp.cmd` (Windows), `mcp`
(bash), or `npm link` for a global `mcp` command.

## Development

- Regenerate icons: `node scripts/make-icons.js`
- Re-run host registration dry-run: `node scripts/register-host.js`
- There is no build step — the extension is plain JS (MV3 service worker with
  `importScripts`). Reload it from `chrome://extensions` after edits.
