# Chrome MCP Bridge — clean-room extension

A from-scratch Chrome extension that replaces the bundled mcp-chrome-bridge
extension. It connects to the **same native host** (`com.chromemcp.nativehost`)
shipped by [`mcp-chrome-bridge`](https://www.npmjs.com/package/mcp-chrome-bridge),
so any MCP client pointed at `http://127.0.0.1:12306/mcp` (or your configured
port) gets full browser control with zero changes to the host or the MCP server.

Built against the protocol reverse-engineered from `mcp-chrome-bridge@1.0.31`
(see [Protocol](#protocol) below).

Companion CLI: **`app/mcpctl`** — a zero-dependency standalone CLI packaged as a
single Windows `.exe` via Node SEA (see [Standalone CLI](#standalone-cli)).

## Architecture

```
+--------------------------------- YOUR MCP CLIENT ---------------------------------+
|   mcpctl.exe (SEA, app/)  |  Claude Desktop  |  Cherry Studio  |  other MCP tools  |
+----------------------------------------+-------------------------------------------+
                                         |
              streamable HTTP  ->  http://127.0.0.1:12306/mcp
                                         |
+----------------------------------------v-------------------------------------------+
|                          NATIVE HOST (Node + Fastify)                              |
|            mcp-chrome-bridge@1.0.31  |  singleton MCP server (1 session)          |
|            forwards tool calls to the extension over native messaging             |
+----------------------------------------+-------------------------------------------+
                                         |
            native messaging (stdio)  ->  com.chromemcp.nativehost
                                         |
+----------------------------------------v-------------------------------------------+
|                          EXTENSION (MV3 -- this repo)                              |
|   background.js       service worker: native port mgmt + tool dispatcher           |
|   lib/protocol.js     wire protocol constants, tool registry, result helpers       |
|   lib/cdp.js          promisified chrome.debugger (CDP eval, capture)              |
|   lib/tabs.js         tab resolution + executeScript helpers                       |
|   tools/*.js          27 tools: browser | content | interaction | network |        |
|                       media | data | injection | misc                              |
|   content/            MAIN-world console capture (document_start)                  |
|   popup/              status + connect/disconnect UI                               |
|   alarms:             'bridge-reconnect' (retry every 0.5 min)                    |
|                       'bridge-keepalive'  (ping host every 30 s)                  |
+-----------+--------------------------------------------+--------------------------+
            |                                            |
    chrome.* APIs                              chrome.debugger (CDP)
            |                                            |
+-----------v------------------+          +--------------v---------------------------+
|   TABS / WINDOWS /           |          |  PAGE -- DOM, network capture,          |
|   history / bookmarks /      |          |  console, screenshots, JS eval          |
|   downloads / dialogs        |          +-----------------------------------------+
+------------------------------+
```

## Layout

```
manifest.json          MV3 manifest with pinned identity (key → stable ID)
background.js          Service worker: native-messaging client + tool dispatcher
lib/
  protocol.js          Wire-protocol constants, tool registry, result helpers
  cdp.js               chrome.debugger promisified helpers (CDP eval, capture)
  tabs.js              Tab resolution + multi-tab id resolution helpers
  gif-encoder.js       Dependency-free GIF89a encoder (median cut + LZW)
  published-tools.js   Descriptors exposing new tools to MCP clients (flow.*)
tools/
  browser.js           Tab toolkit: open/duplicate/reload/discard/pin/mute/move,
                       groups, search, details, extended close + navigation
  windows.js           New/close/manage/arrange windows + tab zoom
  content.js           chrome_get_web_content, chrome_get_interactive_elements
  interaction.js       chrome_click_element/fill_or_select/keyboard/javascript
  network.js           chrome_network_request + chrome_network_capture
  screenshot.js        chrome_screenshot (viewport, full-page, element via CDP)
  console.js           chrome_console (buffer from content script)
  data.js              chrome_history, chrome_bookmark_*
  data-ext.js          chrome_cookies, chrome_downloads, cross-tab content search
  perf.js              Real CDP performance tracing (start/stop/analyze)
  gif.js               Animated GIF recorder (fixed-FPS + action-driven)
  flows.js             record_replay_flow_run dispatcher for published tools
  inject.js            chrome_inject_script, chrome_send_command_to_inject_script
  misc.js              chrome_read_page, chrome_computer, dialogs, uploads,
                       element selection
content/
  console-capture.js   document_start content script that buffers console
  console-capture-main.js  same, running in the MAIN world
popup/                 Status + connect/disconnect UI
app/
  mcpctl.js            Standalone CLI (zero deps) — full command list in app/README.md
  build.js             Builds app/dist/mcpctl.exe via Node SEA + postject
scripts/
  make-icons.js        Generates the PNG icons (pure Node, no deps)
  register-host.js     Adds this extension's ID to the native host allowed_origins
  mcp.js / mcp-cli.js  Legacy in-repo CLI (superseded by app/mcpctl.js)
  mcp-batch.js         Batch runner for the legacy CLI
  build-exe.js         Builds dist/mcp.exe from scripts/mcp.js via Node SEA
  host-roundtrip-test.js / live-feature-test.js / unit-sim-console.js
                       Test harnesses (native host round-trip, live tools, sim console)
  test-gif-encoder.js  Unit tests for the GIF encoder (structure + LZW round-trip)
  probe-cdp.js         Diagnostic: exercises trace + GIF recorder directly and
                       dumps raw MCP responses (also self-heals a wedged host)
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
- `rr_list_published_flows` is answered with the descriptors in
  `lib/published-tools.js` — this is how MCP clients discover the tab/window
  toolkit (each item shows up as a `flow.<slug>` dynamic tool). Calls to those
  tools are proxied back as `record_replay_flow_run` and dispatched to the real
  tool by `tools/flows.js`.
- Liveness: the worker pings the host (`ping_from_extension`) via a keepalive
  alarm every 30 s, and reconnects with **unlimited** retries via a
  `bridge-reconnect` alarm (service-worker-safe — a busy service worker could
  otherwise be idle-killed, which drops the native port and kills the host).

## Tools

**Tabs** — `get_windows_and_tabs`, `chrome_open_tabs` (one or many URLs, active /
background / pinned / window / index), `chrome_duplicate_tabs`,
`chrome_reload_tabs` (optionally bypassing the cache), `chrome_discard_tabs`
(suspend), `chrome_pin_tabs` / `chrome_unpin_tabs`, `chrome_mute_tabs` /
`chrome_unmute_tabs`, `chrome_move_tabs` (reorder or move between windows),
`chrome_group_tabs` / `chrome_ungroup_tabs` / `chrome_tab_groups`,
`chrome_search_tabs` (by title/URL/host), `chrome_tab_details`,
`chrome_close_tabs` (ids, URL, domain, whole windows, `all`, `allExcept`),
`chrome_switch_tab`, `chrome_go_back_or_forward`, `chrome_navigate` (plus
`newTab` to open in a new tab).

**Windows** — `chrome_new_window` (urls, incognito, size, state),
`chrome_close_windows`, `chrome_manage_window` (minimize/maximize/fullscreen/
focus/resize/move), `chrome_arrange_windows` (tile in a grid, vertical,
horizontal, or cascade on the primary display), `chrome_zoom` (get/set/reset a
tab's zoom factor).

**Content & interaction** — `chrome_get_web_content`,
`chrome_get_interactive_elements`, `chrome_read_page` (ref-based element tree),
`chrome_click_element`, `chrome_fill_or_select`, `chrome_keyboard`,
`chrome_javascript`, `chrome_computer` (screenshot / click / type / key /
scroll / scroll_to / wait / resize_page / hover / fill / fill_form subset),
`chrome_search_tabs_content` (search the visible text of open tabs).

**Network** — `chrome_network_request` (page-context fetch with cookies),
`chrome_network_capture` (start/stop; webRequest entries, optional response
bodies via the debugger API).

**Media & performance** — `chrome_screenshot` (viewport via
`captureVisibleTab`; full-page and element captures via CDP),
`chrome_gif_recorder` (record a tab as an animated GIF: fixed-FPS or
action-driven auto-capture, then stop/export; `stop` returns metadata by
default — pass `includeBase64:true` to get the GIF data inline, which is
trimmed automatically if it would exceed the native host's 16MB per-message
cap), `performance_start_trace` / `performance_stop_trace` /
`performance_analyze_insight` (real CDP tracing with trace JSON export and
summaries).

**Data** — `chrome_history`, `chrome_bookmark_search`, `chrome_bookmark_add`,
`chrome_bookmark_delete`, `chrome_cookies` (get/getAll/set/delete/deleteAll),
`chrome_downloads` (list/cancel/pause/resume/erase/open/show/removeFile).

**Injection & misc** — `chrome_inject_script`,
`chrome_send_command_to_inject_script`, `chrome_console` (snapshot/buffer),
`chrome_handle_dialog`, `chrome_handle_download`, `chrome_upload_file` (CDP
file input), `chrome_request_element_selection` (click-to-pick overlay),
`record_replay_flow_run` (flow.* dispatcher).

## Standalone CLI (`app/mcpctl`)

The recommended client. Zero-dependency Node script, packaged as a single
Windows executable via Node SEA — no runtime installs.

```bash
# dev usage (any OS with Node)
node app/mcpctl.js status

# build the standalone exe (Windows; needs Node v24 + `npm i -g postject`)
node app/build.js
app/dist/mcpctl.exe status
```

Covers the bridge end-to-end with automatic host recovery: it detects a wedged
or dead host (kills it, waits for the extension to respawn it) and transparently
retries mid-call failures caused by service-worker idle-kills. It also manages
MCP sessions properly (init + DELETE on exit) so you never hit the bridge's
single-session limit.

```bash
mcpctl status                bridge health + host PID
mcpctl eval "40+2"           run JS in the active tab
mcpctl tabs | active         windows/tabs, active tab info
mcpctl switch <tabId>        switch to tab
mcpctl shot --out t.png      screenshot the active tab
mcpctl read [--depth N]      read page structure / interactive elements
mcpctl click "Button text"   click an element
mcpctl fill "Search" "value" fill an input
mcpctl keys "Ctrl+l"         keyboard shortcuts
mcpctl nav https://...       navigate the active tab
mcpctl net start --bodies    capture network activity
mcpctl console --errors      poll console messages
mcpctl tools                 list the bridge's MCP tools
mcpctl call <tool> <json>    call any bridge tool directly
mcpctl batch file.json       run a JSON-array / JSONL batch in one session
mcpctl repl                  interactive REPL (!tool {json} for raw calls)
```

Global flags: `--json`, `--tab <id>`, `--port <n>`, `--host <h>`,
`--timeout <sec>`; env vars `MCP_PORT` / `MCP_HOST`. Full command reference:
[`app/README.md`](app/README.md) or `mcpctl help`.

> Note: the bridge host keeps a single MCP session — run commands serially;
> concurrent invocations can collide and trigger a host restart.

## Legacy CLI (`mcp` / `scripts/mcp.js`)

The original single-command CLI (`mcp` launcher: `scripts/mcp.js`, `mcp.cmd`,
bash `mcp`, or `npm link`). Superseded by `app/mcpctl` but still functional;
uses the same host-recovery and session-cleanup logic. It can also be compiled
to a standalone `dist/mcp.exe` with `node scripts/build-exe.js`.

```bash
mcp status                # bridge health + host PID
mcp restart               # kill stuck host, wait for respawn
mcp tabs                  # windows + tabs
mcp active                # active tab
mcp switch <tabId>

# ---- full tab management ----
mcp open 'https://a.com' 'https://b.com'   # one or many new tabs
mcp open 'https://…' --bg --pin --window 3  # background/pinned/window
mcp close 12 13          # close tabs by id
mcp close url:https://x  # close by exact URL
mcp close domain:github.com
mcp close others         # close every tab except the active one
mcp close all            # close every tab in every window
mcp close window 4       # close whole window(s)
mcp dup 12               # duplicate tab(s)
mcp reload --all --cache # reload everything, bypass cache
mcp discard 12           # suspend a tab
mcp pin 12 | mcp unpin 12
mcp mute 12 | mcp unmute 12
mcp move 12 13 --window 4 --index 0
mcp group 12 13 --name Work --color blue
mcp ungroup 12 | mcp groups
mcp search 'github'      # find tabs by title/url/host
mcp content-search 'token expired'  # search text inside open tabs

# ---- windows ----
mcp window new 'https://…' --incognito --w 1200 --h 800
mcp window close 4 --current --all
mcp window state 4 fullscreen
mcp window resize 4 --w 1280 --h 720
mcp window focus 4
mcp window arrange --layout grid
mcp zoom 1.5 | mcp zoom reset

# ---- cookies & downloads ----
mcp cookies list 'https://example.com'
mcp cookies set 'https://example.com' theme dark --httpOnly
mcp cookies delete 'https://example.com' theme
mcp downloads list --query report
mcp downloads cancel 12

# ---- recording & tracing ----
mcp gif start --fps 5 | mcp gif status | mcp gif stop
mcp gif start --auto     # capture a frame after every tool action
mcp gif stop --out clip.gif   # save the recording to a file
mcp gif stop --base64    # also print the GIF data inline
mcp trace start --reload --auto --duration 8000
mcp trace stop --name page-load | mcp trace analyze

# ---- page interaction ----
mcp read --interactive    # interactive elements with ref_ ids
mcp eval 'document.title' # run JS expression in the page
mcp run 'return 1+1'      # run a JS block (async body, must return)
mcp click '#button'       # or ref_12
mcp fill 'input' 'value'
mcp keys 'Enter'
mcp nav 'https://…'       # url | back | forward | reload (--new-tab)
mcp shot --full --out page.png

mcp tools                 # list bridge tools (incl. flow.* published tools)
mcp call <tool> '{"k":1}' # raw tool call
mcp storage               # localStorage/sessionStorage/cookies/IndexedDB

mcp repl                  # interactive session (single persistent MCP session)
mcp help
```

Flags: `--json`, `--tab <id>`, `--depth N`, `--ref ref_X`, `--out file.png`.

## Development

- Regenerate icons: `node scripts/make-icons.js`
- Re-run host registration dry-run: `node scripts/register-host.js`
- Unit tests (no browser needed):
  - `node scripts/test-gif-encoder.js` — GIF encoder structure + bit-exact LZW
    round-trip across all code-size transitions and dictionary resets
  - `node scripts/unit-sim-console.js` — console-capture relay chain
- Live end-to-end tests (need the bridge running + extension connected):
  - `node scripts/live-feature-test.js` — baseline tools (content, JS, console,
    network, fill, click)
  - `node scripts/live-tabs-test.js` — new tab/window toolkit: open, search,
    details, pin/unpin, mute/unmute, duplicate, groups, move, zoom, reload,
    content-search, cookies, downloads, window manage/arrange, trace, GIF.
    It only touches tabs/windows it creates and cleans up after itself.
  - `node scripts/probe-cdp.js` — focused diagnostic for the trace + GIF
    CDP paths; dumps raw responses and always closes its MCP session
- Build the standalone CLI executables:
  - `node app/build.js` — produces `app/dist/mcpctl.exe` (standalone CLI)
  - `node scripts/build-exe.js --run` — produces `dist/mcp.exe` from the legacy
    `scripts/mcp.js` CLI (same SEA technique; `dist/` is git-ignored)
- There is no build step for the extension — plain JS (MV3 service worker with
  `importScripts`). Reload it from `chrome://extensions` after edits.
