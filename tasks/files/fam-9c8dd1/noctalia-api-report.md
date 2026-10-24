# Noctalia v5.3.0 Luau plugin API (plugin API level 34) — research report

Researcher: claude-code/claude-opus-5-5 (read-only subagent, 2026-10-24). Sources: pinned
`src/scripting/luau_host.cpp` (sha256 a1a8d633…737e) and other `noctalia-dev/noctalia@v5.3.0`
files fetched read-only. Saved verbatim in substance by the controller; abbreviations:
LH luau_host.cpp, SR script_runtime.cpp, PB plugin_bindings.cpp, PSH plugin_service_host.cpp,
PW src/shell/bar/widgets/plugin_widget.cpp, PP src/shell/panel/plugin_panel.cpp,
R src/ui/ui_tree_reconciler.cpp, PM plugin_manifest.cpp, PR plugin_registry.cpp,
GD src/shell/bar/widget_gesture_defaults.cpp, PROC src/core/process/process.cpp.

## 1. Manifest
- Required: `id` (exactly one `/`, segments `[A-Za-z0-9_.-]` starting alphanumeric; PM:752-758),
  `name` (PM:759-762), `version` strict MAJOR.MINOR.PATCH (PM:699-720,763-765), `plugin_api`
  positive integer with 3 <= v <= 34 else skipped (plugin_api.h:7,37,41-43; PR:87-93).
- Optional: author, license, deprecated, icon, description, tags, dependencies (display only),
  [[setting]]. Unknown keys ignored; wrong-typed known keys fall back to defaults.
- Gated keys: widget `actions` >= 14, `hover_highlight` 34; panel keys dismiss_on_outside_click 8,
  keyboard_focus 10, persistent 11, capture_keys 13, layer 30. Service `onEnable` needs >= 17.
- Entries: `[[widget]]`, `[[panel]]`, `[[service]]` (and shortcut/desktop_widget/launcher_provider)
  each with `id` and `entry` (path relative to plugin dir, not validated at load; PM:55-62,404-408;
  PR:137,153). Entry ids unique across kinds (PM:810-815). Full ids `khughitt/familiar:alerts`.
- Enable via `[plugins] enabled = ["khughitt/familiar"]` (PR:84-86); place the widget with
  `[widget.<name>] type = "khughitt/familiar:workspaces"` (widget_factory.cpp:388-389).
- TOML trap: scalars after `[widget.actions]` land in that subtable (PM:619-622).

## 2. Loading and lifecycle
- One VM per runtime: one per bar-widget instance (per bar, per output), singleton panel and
  service (SR:735; widget_factory.cpp:414-429; application_plugins.cpp:98-137; PSH:134-144).
  No shared Lua memory; `noctalia.state` is the only channel.
- Load: `ui` prelude, entry chunk with 100 ms CPU budget, then `update()` once (SR:805-824).
- Callbacks are globals looked up by name; return values ignored; 25 ms CPU per call
  (LH:3156-3176,2889-2906; SR:40-42). Unhealthy after 3 consecutive timeouts / 5 in 60 s /
  5 errors in 60 s. Heap 128 MiB; event queue 64.
- Globals: `noctalia` (+ state, json, sound, string), barWidget, panel, shortcut, launcher,
  desktopWidget (PB:871-885), `require` (LH:1880-1881), `ui`.
- `require`: path must start `./` or `../` and end `.luau` (LH:2966-2971); canonicalized and
  cached per VM; cycles detected; must return one non-nil value (LH:3119-3124); private
  environment reading through to globals (LH:3066-3085). Entry chunk resolves relative to the
  plugin directory (LH:2918-2937). Callbacks must be defined in the entry file.
- Bar widget callbacks: update(), onClick(), onRightClick(), onMiddleClick() (no args; PW:157-175),
  onHover(bool), onScroll(axis, steps, startsGesture), onIpc, onExit. No onConfigChanged.
- Panel: VM created on first open, persists (PP:198-203); onOpen(context,""), onClose(); update()
  once at load then every 1000 ms only while open after panel.setWantsSecondTicks(true).
- Service: started at launch; update() at load and every interval (default 1000 ms); onEnable,
  onOutputsChanged, onConfigChanged, onIpc, onExit. No start/stop.
- `setUpdateInterval(ms)`: max(16, int(ms)), no upper limit (LH:927-933,2715-2719); widget default
  250 ms; first tick after interval plus phase offset up to min(interval/2, 500 ms); updates within
  interval-5 ms of the last, or while one is queued/running, are dropped (SR:367-379); every call
  restarts the widget timer (PW:571-592).
- Redraw only when the script calls render(tree) and the tree differs (PW:715-740; PP:369-373).
- `noctalia.state`: set converts to JSON, stores synchronously, notifies every watcher of the key
  (including the setter's runtime) on every set even if unchanged (plugin_state_store.cpp:12-30);
  get returns latest or nil; watch never fires initially and each call adds a watcher; delivery is
  queued onto the watching runtime; values never cleared. Async callbacks (state watch, runAsync,
  readFileAsync) run with a default snapshot: barWidget.isVertical() false, outputName() nil —
  cache both in update().

## 3. Bar widget UI
- `barWidget.render(tree)` (PB:566-586); node `{type, props, children}`; constructors column, row,
  box, label, glyph, image, separator, spacer, progress, button, graph, input, markdown, select,
  slider, toggle, scroll, dragSource, dropZone (ui_prelude.h:18-36); input/select/scroll stripped
  from bar trees.
- row/column: gap, padding, paddingH, paddingV, align, justify, fill, radius, border, borderWidth,
  minWidth, minHeight, width, height, onClick, onHover, tooltip (R:1221-1287). box: fill, radius,
  border, borderWidth, softness, width, height, onClick, onHover, tooltip; no children. label: text,
  fontSize, fontWeight, fontFamily, baseline, color, maxWidth, maxLines, textAlign; no click or
  tooltip. button: text, glyph, fontSize, glyphSize, variant (default/primary/secondary/
  destructive/outline/ghost), contentAlign, controlSize, enabled, selected, tooltip, onClick,
  onRightClick, onHover, width, height (R:1476-1582). Common: visible, opacity (0..1), flexGrow, key.
  No scale/transform/animation props.
- Colours: role tokens (primary, on_surface, surface_variant, outline, hover, error, …) with
  optional "/alpha", or hex #rgb/#rgba/#rrggbb/#rrggbbaa. Wrong prop types ignored; unknown props
  logged. Dropped props often keep their previous value (R:438-442): set explicitly to reset.
- Tree callbacks receive two strings (onClick: "", ""; SR:1145-1153); function props stored per
  render and swapped atomically; clicks referring to superseded renders are dropped (LH:3161-3169).
- barWidget.isVertical(), barWidget.outputName() (PB:208-222); focusedOutputName only in bar
  widgets. barWidget.setTooltip(...) for the whole widget; per-node tooltip props.
- Click routing: innermost enabled InputArea accepting the button; no bubbling. Wrappers accept
  only left (with onClick); button accepts left, and right only with onRightClick
  (button.cpp:308-326); no node accepts middle. Disabled button falls through to widget onClick.
  Default `middle = settings-open-widget` (GD:14-18) unless actions set middle = "none". Right click
  not bound by default; a user binding wins. Modifier chords unsupported.

## 4. Panel
- `noctalia.togglePanel("khughitt/familiar:alerts")` (LH:715-723); onOpen gets "" context; one
  non-persistent panel at a time; `panel.render(...)` allows every node kind; `panel.close()`;
  context menus only inside a node onRightClick; default size 480x400.

## 5. Process and file APIs
- `runAsync(cmd | argv, cb?, timeoutMs?)` (LH:266-302): string → /bin/sh -c; table → argv of
  non-empty NUL-free strings. Without cb: detached, returns slot availability, third arg ignored.
  With cb: timeout default 5000 ms, clamped [50, 60000], enforced: SIGTERM to group and pid,
  ~10x10 ms poll, SIGKILL (PROC:336-356,433-436,455-472). 8 in flight per VM, 32 global; over the
  limit returns false and cb never runs. stdout/stderr capped 1 MiB with truncation flags; trailing
  \r\n trimmed (PROC:77-81,504-505). Exit 127 exec failure, 128+signal, -1 fork/pipe failure. cb
  gets one table {exitCode, stdout, stderr, timedOut, stdoutTruncated, stderrTruncated}
  (LH:2613-2621); dropped after a VM reload.
- `runStream(cmd, onLine)`: shell string, 4 per VM, no timeout or exit callback.
- `readFile(p)` sync; `readFileAsync(p, cb)` returns false at 4 outstanding per VM or a full global
  queue (64); 2 workers; cb(data, nil) or cb(nil, "cannot open file" | "cannot read file" |
  "file too large" (>4 MiB)) (LH:2055-2092,2643-2650). `fileExists(p)`. Paths: leading ~ via $HOME,
  absolute as is, else relative to the plugin dir (LH:935-948). `expandPath` only expands ~.
- `getenv(name)` (Noctalia's own environment); `nowMs()` wall clock ms as double.
- `notify(title, body?)`: queued side effect; app name "Noctalia", Normal urgency; DND respected by
  default policy; duplicates within a window ignored.
- `getColor(role)` → "#RRGGBB" or nil. `json.decode(s)` → value or nil, err: null → nil (keys
  vanish, array holes), numbers doubles, [] and {} both empty tables. `json.encode(v, pretty?)`:
  #t>0 → array 1..#t; else object of string keys; functions → null; depth > 32 → null.
- `log(msg)` at info level, without the plugin id.

## 6. Luau runtime
- Vendored Luau 0.724 (from commit cc3d6dda2d message); tests' CLI is 0.743.
- luaL_openlibs: base, coroutine, table, os, string, math, debug, utf8, bit32, buffer, vector;
  integer lib off. Base has getfenv, setfenv, print; no loadstring, loadfile, dofile. os has clock,
  date, difftime, time. No io, no package; require is the host's.
- luaL_sandbox: library tables and globals read-only; user code on a sandbox thread with writable
  globals reading through. Numbers are doubles. CPU budget via interrupt hook.

## 7. Rejections and mock fidelity
- Render root not a table or without type → ignored; typeless children dropped; depth <= 32, <= 256
  children per node. Callback return values never read. getConfig on undeclared key → nil + warning.
  Imperative setText while a render tree is active has no effect. A failing callback still applies
  partial effects.
- A faithful mock: one VM per entry with `ui`; globals as callbacks; returns ignored; tree callbacks
  get two strings; async results on a later turn with a default snapshot; state watchers notified on
  every set incl. the setter; state values JSON round-tripped; runAsync trims trailing newline and
  honours its timeout; middle click host-owned unless the manifest frees it.

## Gaps not settled by source
- PanelManager behaviour for an unknown panel id; whether an internal notification is saved to
  history under DND; whether a label truncates at maxWidth; where the bar dead-zone default applies.
