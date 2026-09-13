// lib/published-tools.js — descriptors for the tools this extension adds beyond
// the host's static schema list.
//
// The mcp-chrome-bridge host's MCP server discovers extension-defined tools via
// the `rr_list_published_flows` handshake and exposes each item as a dynamic
// `flow.<slug>` tool whose schema is built from `variables`. Calls to those
// dynamic tools are forwarded back as `record_replay_flow_run` (see
// tools/flows.js), which dispatches to the real registered tool. This lets any
// MCP client — Claude Desktop, Cherry Studio, Freebuff, … — discover and call
// the full tab/window toolkit with zero changes to the host.

globalThis.PUBLISHED_TOOLS = [
  {
    id: 'open_tabs', slug: 'open_tabs', tool: 'chrome_open_tabs',
    description: 'Open one or more new tabs (optionally in the background, pinned, or in a specific window).',
    variables: [
      { key: 'urls', label: 'URLs to open', type: 'array' },
      { key: 'url', label: 'Single URL to open', type: 'string' },
      { key: 'active', label: 'Activate the first new tab (default true)', type: 'boolean', default: true },
      { key: 'pinned', label: 'Open the tabs pinned', type: 'boolean', default: false },
      { key: 'windowId', label: 'Window to open the tabs in', type: 'number' },
      { key: 'index', label: 'Index for the first new tab', type: 'number' },
    ],
  },
  {
    id: 'close_tabs', slug: 'close_tabs', tool: 'chrome_close_tabs',
    description: 'Close tabs by ids, URL, domain, all, or "all except". Can also close entire windows (windowIds).',
    variables: [
      { key: 'tabIds', label: 'Tab IDs to close', type: 'array' },
      { key: 'url', label: 'Close tabs with this exact URL', type: 'string' },
      { key: 'domain', label: 'Close all tabs on this domain', type: 'string' },
      { key: 'all', label: 'Close every tab in every window', type: 'boolean', default: false },
      { key: 'allExcept', label: 'Keep these tab IDs and close everything else', type: 'array' },
      { key: 'windowIds', label: 'Close whole windows by id', type: 'array' },
      { key: 'windowId', label: 'Close all tabs in this window', type: 'number' },
    ],
  },
  {
    id: 'duplicate_tabs', slug: 'duplicate_tabs', tool: 'chrome_duplicate_tabs',
    description: 'Duplicate one or more tabs (new tabs are created as copies).',
    variables: [
      { key: 'tabIds', label: 'Tab IDs to duplicate', type: 'array' },
      { key: 'tabId', label: 'Single tab ID to duplicate', type: 'number' },
    ],
  },
  {
    id: 'reload_tabs', slug: 'reload_tabs', tool: 'chrome_reload_tabs',
    description: 'Reload one or more tabs, optionally bypassing the cache.',
    variables: [
      { key: 'tabIds', label: 'Tab IDs to reload', type: 'array' },
      { key: 'all', label: 'Reload every tab', type: 'boolean', default: false },
      { key: 'bypassCache', label: 'Bypass the HTTP cache', type: 'boolean', default: false },
    ],
  },
  {
    id: 'discard_tabs', slug: 'discard_tabs', tool: 'chrome_discard_tabs',
    description: 'Discard (suspend) one or more tabs to free memory.',
    variables: [
      { key: 'tabIds', label: 'Tab IDs to discard', type: 'array' },
      { key: 'all', label: 'Discard every tab', type: 'boolean', default: false },
    ],
  },
  {
    id: 'pin_tabs', slug: 'pin_tabs', tool: 'chrome_pin_tabs',
    description: 'Pin one or more tabs.',
    variables: [{ key: 'tabIds', label: 'Tab IDs to pin', type: 'array' }],
  },
  {
    id: 'unpin_tabs', slug: 'unpin_tabs', tool: 'chrome_unpin_tabs',
    description: 'Unpin one or more tabs.',
    variables: [{ key: 'tabIds', label: 'Tab IDs to unpin', type: 'array' }],
  },
  {
    id: 'mute_tabs', slug: 'mute_tabs', tool: 'chrome_mute_tabs',
    description: 'Mute audio in one or more tabs.',
    variables: [{ key: 'tabIds', label: 'Tab IDs to mute', type: 'array' }],
  },
  {
    id: 'unmute_tabs', slug: 'unmute_tabs', tool: 'chrome_unmute_tabs',
    description: 'Unmute audio in one or more tabs.',
    variables: [{ key: 'tabIds', label: 'Tab IDs to unmute', type: 'array' }],
  },
  {
    id: 'move_tabs', slug: 'move_tabs', tool: 'chrome_move_tabs',
    description: 'Move one or more tabs to a position or to another window.',
    variables: [
      { key: 'tabIds', label: 'Tab IDs to move', type: 'array' },
      { key: 'windowId', label: 'Destination window (omitting it reorders within the current window)', type: 'number' },
      { key: 'index', label: 'Target index (-1 = end)', type: 'number' },
    ],
  },
  {
    id: 'group_tabs', slug: 'group_tabs', tool: 'chrome_group_tabs',
    description: 'Put one or more tabs into a tab group with an optional title and color.',
    variables: [
      { key: 'tabIds', label: 'Tab IDs to group', type: 'array' },
      { key: 'title', label: 'Group title', type: 'string' },
      { key: 'color', label: 'Group color', type: 'enum', rules: { enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] } },
      { key: 'windowId', label: 'Create the group in this window', type: 'number' },
    ],
  },
  {
    id: 'ungroup_tabs', slug: 'ungroup_tabs', tool: 'chrome_ungroup_tabs',
    description: 'Remove tabs from their group(s).',
    variables: [
      { key: 'tabIds', label: 'Tab IDs to ungroup', type: 'array' },
      { key: 'groupId', label: 'Ungroup every tab in this group id', type: 'number' },
    ],
  },
  {
    id: 'tab_groups', slug: 'tab_groups', tool: 'chrome_tab_groups',
    description: 'List all tab groups and the tabs in each.',
    variables: [],
  },
  {
    id: 'search_tabs', slug: 'search_tabs', tool: 'chrome_search_tabs',
    description: 'Find open tabs by title, URL, or hostname.',
    variables: [
      { key: 'query', label: 'Text to match in title/URL/host', type: 'string' },
      { key: 'windowId', label: 'Only search this window', type: 'number' },
    ],
  },
  {
    id: 'tab_details', slug: 'tab_details', tool: 'chrome_tab_details',
    description: 'Full details (state, mute, discard, group, cookie store, …) for one or more tabs.',
    variables: [{ key: 'tabIds', label: 'Tab IDs', type: 'array' }],
  },
  {
    id: 'new_window', slug: 'new_window', tool: 'chrome_new_window',
    description: 'Open a new browser window (optionally incognito) with one or more URLs.',
    variables: [
      { key: 'urls', label: 'URLs to open', type: 'array' },
      { key: 'incognito', label: 'Open an incognito window', type: 'boolean', default: false },
      { key: 'width', label: 'Window width', type: 'number' },
      { key: 'height', label: 'Window height', type: 'number' },
      { key: 'state', label: 'Initial window state', type: 'enum', rules: { enum: ['normal', 'minimized', 'maximized', 'fullscreen'] } },
    ],
  },
  {
    id: 'close_windows', slug: 'close_windows', tool: 'chrome_close_windows',
    description: 'Close one or more windows (by ids, the focused one, or all except given ids).',
    variables: [
      { key: 'windowIds', label: 'Window IDs to close', type: 'array' },
      { key: 'current', label: 'Close the last-focused window', type: 'boolean', default: false },
      { key: 'allExcept', label: 'Keep these window ids and close the rest', type: 'array' },
    ],
  },
  {
    id: 'manage_window', slug: 'manage_window', tool: 'chrome_manage_window',
    description: 'Minimize, maximize, fullscreen, focus, resize, or move a window.',
    variables: [
      { key: 'windowId', label: 'Window ID (default: last-focused)', type: 'number' },
      { key: 'state', label: 'Window state', type: 'enum', rules: { enum: ['normal', 'minimized', 'maximized', 'fullscreen'] } },
      { key: 'focused', label: 'Focus the window', type: 'boolean' },
      { key: 'width', label: 'Width', type: 'number' },
      { key: 'height', label: 'Height', type: 'number' },
      { key: 'left', label: 'Left offset', type: 'number' },
      { key: 'top', label: 'Top offset', type: 'number' },
    ],
  },
  {
    id: 'arrange_windows', slug: 'arrange_windows', tool: 'chrome_arrange_windows',
    description: 'Tile all (or given) windows in a grid, vertical, horizontal, or cascade layout.',
    variables: [
      { key: 'layout', label: 'Layout', type: 'enum', rules: { enum: ['grid', 'vertical', 'horizontal', 'cascade'] }, default: 'grid' },
      { key: 'windowIds', label: 'Windows to arrange (default: all)', type: 'array' },
    ],
  },
  {
    id: 'zoom', slug: 'zoom', tool: 'chrome_zoom',
    description: 'Get, set, or reset the zoom factor of a tab (0.25–5).',
    variables: [
      { key: 'tabId', label: 'Tab ID (default: active)', type: 'number' },
      { key: 'factor', label: 'Zoom factor to set', type: 'number' },
      { key: 'reset', label: 'Reset zoom to 100%', type: 'boolean', default: false },
    ],
  },
  {
    id: 'cookies', slug: 'cookies', tool: 'chrome_cookies',
    description: 'Read, write, or delete browser cookies (get | getAll | set | delete | deleteAll).',
    variables: [
      { key: 'action', label: 'Action', type: 'enum', rules: { enum: ['get', 'getAll', 'set', 'delete', 'deleteAll'] } },
      { key: 'url', label: 'Cookie URL', type: 'string' },
      { key: 'name', label: 'Cookie name', type: 'string' },
      { key: 'value', label: 'Cookie value (for set)', type: 'string' },
      { key: 'domain', label: 'Domain filter (getAll/deleteAll)', type: 'string' },
      { key: 'path', label: 'Cookie path', type: 'string' },
      { key: 'secure', label: 'Secure flag', type: 'boolean' },
      { key: 'httpOnly', label: 'HttpOnly flag', type: 'boolean' },
      { key: 'expirationDate', label: 'Expiration (epoch seconds)', type: 'number' },
    ],
  },
  {
    id: 'downloads', slug: 'downloads', tool: 'chrome_downloads',
    description: 'List, cancel, pause, resume, erase, open, or show browser downloads.',
    variables: [
      { key: 'action', label: 'Action', type: 'enum', rules: { enum: ['list', 'cancel', 'pause', 'resume', 'erase', 'open', 'show', 'removeFile'] }, default: 'list' },
      { key: 'query', label: 'Search text for list', type: 'string' },
      { key: 'id', label: 'Download id', type: 'number' },
      { key: 'ids', label: 'Download ids (cancel/pause/resume/erase)', type: 'array' },
      { key: 'limit', label: 'Max results for list', type: 'number' },
    ],
  },
  {
    id: 'search_tabs_content', slug: 'search_tabs_content', tool: 'chrome_search_tabs_content',
    description: 'Search the visible text of open tabs for a query and return matching tabs with snippets.',
    variables: [
      { key: 'query', label: 'Text to find in open tabs', type: 'string' },
      { key: 'maxResults', label: 'Max matches (default 20)', type: 'number' },
      { key: 'maxTabs', label: 'Max tabs to scan (default 50)', type: 'number' },
    ],
  },
  {
    id: 'trace_start', slug: 'trace_start', tool: 'performance_start_trace',
    description: 'Start a CDP performance trace on a tab (optionally reloading, with auto-stop).',
    variables: [
      { key: 'tabId', label: 'Tab to trace (default: active)', type: 'number' },
      { key: 'reload', label: 'Reload the page when tracing starts', type: 'boolean', default: false },
      { key: 'autoStop', label: 'Stop automatically after durationMs', type: 'boolean', default: false },
      { key: 'durationMs', label: 'Auto-stop duration', type: 'number', default: 5000 },
      { key: 'name', label: 'Trace name for the output file', type: 'string' },
    ],
  },
  {
    id: 'trace_stop', slug: 'trace_stop', tool: 'performance_stop_trace',
    description: 'Stop the active trace and return a summary (and optionally save the JSON trace).',
    variables: [
      { key: 'saveToDownloads', label: 'Save trace JSON to Downloads (default true)', type: 'boolean', default: true },
      { key: 'filenamePrefix', label: 'Output filename prefix', type: 'string' },
      { key: 'includeBase64', label: 'Also return the trace JSON as base64', type: 'boolean', default: false },
    ],
  },
  {
    id: 'trace_analyze', slug: 'trace_analyze', tool: 'performance_analyze_insight',
    description: 'Analyze the in-memory trace (event counts, categories, slow tasks).',
    variables: [],
  },
  {
    id: 'gif', slug: 'gif', tool: 'chrome_gif_recorder',
    description: 'Record an animated GIF of a tab (start/auto_start/capture/status/stop/clear/export).',
    variables: [
      { key: 'action', label: 'Action', type: 'enum', rules: { enum: ['start', 'auto_start', 'capture', 'status', 'stop', 'clear', 'export'] } },
      { key: 'tabId', label: 'Tab to record (default: active)', type: 'number' },
      { key: 'fps', label: 'Frames per second for start (default 5)', type: 'number' },
      { key: 'maxFrames', label: 'Frame cap (default 300)', type: 'number' },
      { key: 'save', label: 'Save GIF to Downloads on stop (default true)', type: 'boolean', default: true },
      { key: 'name', label: 'Output filename', type: 'string' },
    ],
  },
];
