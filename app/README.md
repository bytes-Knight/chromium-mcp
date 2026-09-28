# mcpctl — standalone Chrome MCP bridge CLI

Zero-dependency command-line client for the Chrome MCP bridge
(`http://127.0.0.1:12306/mcp`), packaged as a single Windows executable via
Node Single Executable Application (SEA).

## Build

**Default — one self-contained `.exe`, no node needed on the target:**

```
npm run build        # or: node app\build.js
```

Requirements: Node.js (v24 LTS) and `postject` (`npm i -g postject`).
Produces `app\dist\mcpctl.exe`: a copy of `node.exe` with the Authenticode
signature stripped (Windows refuses to load a broken signature once the blob is
appended) and the SEA blob injected as a PE resource by postject. The result is a
single portable file — copy it anywhere, no runtime install. Builds are
deterministic (same node + same source ⇒ byte-identical binary) and the build
prints the sha256 so that can be verified.

**Alternative — a ~1 KB node launcher, when `node` is on PATH:**

```
npm run build:launcher   # writes app\dist\mcpctl + app\dist\mcpctl.cmd
```

Prefer this when you would rather not carry an 87 MB unsigned binary that AV may
want to scan, and when you want source edits to take effect with no rebuild. It
runs `app/bin/mcpctl.js` on the system node.

The two packagings are mutually exclusive inside `app/dist`: `cmd.exe` resolves
`.exe` before `.cmd` (PATHEXT) while Git Bash resolves the extensionless name
first, so a directory holding both would quietly run a different binary per shell.
Each build removes the other's files.

Run `mcpctl` with no arguments or `--help` for the full command list.

## Usage

```
mcpctl status [--wait N]     real bridge health (host + extension roundtrip), host PID
mcpctl browsers | instances [--range N-M]
                             list every live bridge instance (multi-browser):
                             browser/version, label, instanceId, endpoint, and
                             the exact --browser selector to use for each.
                             Needs no session/lock, so it still works when this
                             CLI's own port is down.
mcpctl label <name>          name this browser's instance (target it with
                             --browser first); then target it by that name
mcpctl --browser <selector> <cmd>
                             target one browser's bridge instance; --port wins.
                             <label> | <name>:<port> | port:<n> | id:<prefix>
                             | <name> (chrome|edge|brave|opera). A bare name
                             that matches several instances lists the
                             candidates instead of guessing.
mcpctl ping                  verify a session + tool roundtrip (reports latency)
mcpctl doctor                full environment report: host, browser, native host
                             manifest, extension-ID match, all live instances —
                             run this when something won't start
mcpctl ensure [--wait N] [--no-launch]
                             bring the bridge up: wait, launch a browser if
                             needed, restart a stale host until a real session
                             roundtrip works
mcpctl eval "40+2"            run JS in the active tab (prints the VALUE: 42)
mcpctl eval - <<'EOF'         multi-line JS from stdin — no shell quoting
...js...
EOF
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
mcpctl call <tool> <json>     call any bridge tool directly (`-` = JSON on stdin)
mcpctl batch file.json        run a JSON-array / JSONL batch of tool calls
mcpctl repl                   interactive REPL (!tool {json} for raw calls)
```

Output is quiet by default: a `chrome_javascript` result is unwrapped, so
`mcpctl eval 'JSON.stringify({a:1})'` prints the object — not a nested,
backslash-escaped envelope. Flags: `--json` (full machine-readable object),
`--raw` (tool envelope verbatim), `--quiet` (payload only, no info lines).

Global flags: `--tab <id>`, `--port <n>`, `--host <h>`, `--timeout <sec>`,
`--lock-timeout <sec>`, `--browser <selector>`, `--range N-M` (also accepted
before the command: `mcpctl --browser edge status`,
`mcpctl --range 12306-12340 browsers`). Env vars: `MCP_PORT`, `MCP_HOST`.
Type `mcpctl help` for per-command flags.

Input that would fight shell quoting (multi-line JS, nested JSON) is read from
stdin with a positional `-`, or from a file with `--in <file>`:
`eval`, `run`, `inject`, `call`, and `batch` all accept it.

Exit codes: `0` ok, `1` the command reported a failure (e.g. a tool call
failed), `2` usage error, `3` bridge down / no instance matched `--browser`,
`4` another mcpctl holds the lock.

## Multi-browser targeting

Each browser running the extension owns its own MCP port (12306–12335 range,
stable per instance — see the extension README's Multi-browser section).

```
$ mcpctl browsers
* :12306  chrome 140.0.0.0 (win)  label="chrome-work"  id=abc12345
       use:  mcpctl --browser chrome-work <command>   (or --port 12306)
  :12307  edge   131.0.0.0 (win)  unlabeled  id=def67890
       use:  mcpctl --browser edge:12307 <command>   (or --port 12307)

mcpctl --browser edge-victim tabs
mcpctl --browser chrome:12307 status
mcpctl --browser port:12307 eval 'document.title'
mcpctl --browser id:def67890 tabs
mcpctl --port 12307 nav https://example.com
```

Name instances from the CLI (`mcpctl --browser edge label edge-victim`) or from
the extension popup. The identity cache means a browser whose session is
currently held by another client is still listed and still targetable.
Locking is per-port: concurrent mcpctl invocations on *different* browsers run
in parallel safely; same-browser calls still serialize.

Exit codes: `0` ok · `1` runtime error · `2` usage · `3` bridge down /
unreachable · `4` another mcpctl instance holds the lock.

## Health model

"Healthy" means a **real extension roundtrip** (`initialize` + a dispatched tool
call), never a bare TCP check. A standalone/orphan host (e.g. `node ...\mcp-chrome-bridge\dist\index.js`
run directly, with no browser extension attached) answers HTTP and can even
complete `initialize`, but fails every tool call — `status`/`ping`/`ensure`/`doctor`
all detect this and report `state: broken` instead of a false "ok".

## Notes / behavior

- The bridge host keeps a single MCP session. mcpctl self-serializes: every
  command that touches the bridge takes a cross-process lockfile
  (`%TEMP%\mcpctl-<port>.lock`, stale locks are reclaimed automatically), so
  concurrent mcpctl invocations queue instead of colliding and force-restarting
  the host. `--lock-timeout` bounds the wait (`4` on timeout).
- When the bridge is DOWN, session commands fail fast (exit `3`, ~1 s) with
  remediation instead of stalling for 45-60 s in a respawn wait that can never
  succeed.
- If the browser idle-kills the service worker mid-call the host exits and the
  in-flight request dies ("terminated"). mcpctl detects this, restarts the host
  (bounded: it only long-waits when a browser with the extension is actually
  running), and retries automatically.
- The extension's `background.js` keeps the native port alive with a keepalive
  ping and reconnects via `chrome.alarms` (service-worker-safe).
