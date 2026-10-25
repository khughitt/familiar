# Desktop attention

When an agent needs you, familiar's popup, the bar's workspace pill and a desktop toast
agree about what happened and where. This page describes how that works today. Design
decision record: `docs/specs/2026-10-24-desktop-attention-design.md`; activation and
rollback: `docs/runbooks/desktop-attention-rollout.md`.

## Pieces

| Piece | Where | Role |
| --- | --- | --- |
| Reducer | `src/attention/model.js` | Episodes from relay's raw registry rows; dispositions; delivery reservations. Portable, no I/O. |
| Store | `src/attention/store.js` | `attention.json` under the presentation lock; `attention-health.json` without it; the health rule. |
| Observer capture | `src/observe/run.js` | Every relay observer envelope is captured before anything visual can fail (a teardown drops its visual first). |
| CLI | `familiar attention status / dismiss / popup`, `familiar niri focus ID` | The only control surface. |
| Coordinator | `familiar-niri watch` (`integrations/niri/coordinator.js`) | Attribution, workspace feed, heartbeat, toasts. One per desktop session. |
| Popup | `integrations/niri-desktop/` (Quickshell) | Plays one finite moment per reserved episode. |
| Bar plugin | `integrations/noctalia-plugin/` (Noctalia 5.3, API 34) | Workspace pills, Alerts panel, health notice. |

All files live in familiar's state directory (`FAMILIAR_STATE_DIR`, default
`~/.local/state/familiar`): `attention.json`, `attention-health.json`,
`attention-coordinator.lock` and `niri-workspaces.json`.

## Episodes

An episode is one stretch of attention from one source: a relay agent row (a root
session, or an identified Codex worker) in one process incarnation and registry
generation. Kinds are `needs-input`, `needs-approval`, `error` and `completion`.

- A source entering `needs-input`, `needs-approval` or `error` opens an episode; any
  other state of that same source closes it. Another source's activity never does, so a
  Codex worker cannot erase its root's approval.
- Claude sub-agents share one relay session: another sub-agent's tool start can close an
  approval whose prompt is still open. This is an accepted limitation and the pill's
  tooltip says so.
- A root's turn ending (`done`) opens a completion episode, unless a worker of that root
  is still working or waiting. Then nothing is announced and a static diagnostic,
  "Completion withheld — worker status unconfirmed", names the blocking workers. Its
  dismissal belongs to that set of workers; it never unlocks the completion, and a
  withheld completion is never replayed when the worker finishes.
- Completed-turn history outlives the marker: passive idle (OpenCode's
  `done → idle → idle`) and a late Claude idle prompt keep the same episode, its
  dispositions and its delivery decisions, so neither can announce the turn twice.
  Genuine new activity from that root ends the association.
- Approvals read "Approval requested — response unconfirmed" with the observation's
  age: relay cannot see an approval being granted, and nothing is expired on a timer.
- Duplicates, reconciles, delayed envelopes and old registry generations cannot reopen
  an episode; a new process or registry generation is a new source.
- The first observation after familiar starts watching restores current requests as
  static markers, with no popup or toast, and records no completion.

## Seen, dismissed, closed

- **Seen**: the episode's workspace becomes Niri's globally focused workspace (visible on
  another monitor is not seen). Motion stops; requests stay as static markers, errors and
  completions clear. An event on the focused workspace is seen at once but still gets its
  one finite arrival.
- **Dismissed**: `familiar attention dismiss ID...` (the pill's right click, or the
  Alerts panel). It hides exactly those episodes and diagnostics and cancels their
  queued popup and toast. It never answers a request, grants an approval, stops an agent
  or touches native urgency, and a later request alerts again.
- **Closed**: the source changed state or ended. Queued delivery is cancelled.

## Delivery

Each episode has a popup and a toast delivery status: `pending` until the coordinator
classifies it, then `eligible` or `suppressed`, then `reserved` (with a token) while a
surface plays it, and finally `delivered`, `failed`, `suppressed`, `interrupted` or
`uncertain`. Terminal outcomes never return to pending.

- A reservation is written before any external send. A crash may lose a transient
  effect; the pending marker survives, and the next coordinator marks the reservation
  `uncertain` instead of sending again. Nothing is ever replayed.
- Toasts go through `noctalia msg notification-show` as `familiar`, with generic text,
  project labels and the workspace label: one summary per workspace per pass.
  Completions are `low` urgency and only toast when they finished on an unfocused,
  known workspace; requests and errors are `normal`, and a request with no known
  workspace may still toast.
- Do Not Disturb `on` or unknown suppresses everything not yet started, durably; when
  it is known `off` again only new events are announced.
- The popup attaches by suppressing what it already shows, then claims one eligible
  episode at a time (errors first, then approval, input, completion). An error may
  preempt a lower-priority moment; a visit after the claim, a dismissal or a closure
  cancels it. Motion `off` draws nothing.

## Coordinator, feed and health

`familiar-niri watch` holds `attention-coordinator.lock` for its life (a second copy
refuses to start). It keeps three paths apart so none can stall another:

- **Workspace feed** (`niri-workspaces.json`): Niri's event stream reduced to stable
  workspace IDs and published immediately, refreshed every second, with no lock. A delta
  before Niri's full snapshot fails the stream for restart rather than guessing.
- **Heartbeat** (`attention-health.json`): every 2 s, with the boot ID and `NIRI_SOCKET`.
  A starting coordinator first records itself in the saved state with the desktop
  `unknown`, so nothing is claimed or classified on its predecessor's readings.
  It is healthy only while under 10 s old, from this boot and this desktop session, and
  from the coordinator that classified the saved state. The record is schema 2 and has
  exactly these keys: `schema`, `instanceId`, `epoch`, `owner`, `writtenAt`, `stopped`
  and `crashedAt`. Schema 1 is invalid for every reader. See "Crash history" below.
- **Attention**: debounced passes that take the presentation lock only when attribution
  changed or an episode awaits classification, with all IPC outside the lock. Focus
  changes take the lock only to mark unseen episodes on the newly focused workspace.

DND is polled with the heartbeat. `familiar-niri sync` runs one pass of the same work
and leaves attention alone while `watch` runs.

### Crash history

A live heartbeat shows the current instance is alive, not that the coordinator stays
up: each start writes a fresh heartbeat, and a coordinator that dies and restarts
every few minutes reads healthy. Each recovery suppresses what was queued and marks
what was reserved uncertain, so the alerts arriving at each crash can lose their toast
(their pill markers stay). The heartbeat therefore carries a bounded crash history,
which only the singleton coordinator maintains.

- `stopped` is `false` while an instance runs. `crashedAt` lists the ends of
  predecessors, in the same boot and desktop session, that did not stop cleanly; each
  end is that predecessor's last `writtenAt`. It holds at most 8 non-decreasing
  integer milliseconds, each within 10 minutes before the record's `writtenAt` and no
  later than it. An empty list is valid, and a record that breaks any of this is
  invalid for every reader (`validHealth`).
- A starting coordinator reads the existing record under the singleton lock, before
  recovery. A record of another boot or desktop session, or a missing one, starts an
  empty history silently (an unknown live boot ID or desktop session never matches).
  An unreadable, invalid or schema-1 record starts an empty history and logs one line;
  it never aborts startup. A valid record of this boot and session contributes its
  `crashedAt`, plus its `writtenAt` when it is not `stopped`.
- Every heartbeat restates the history against the clock reading that becomes
  `writtenAt`: entries later than it or more than 10 minutes older are dropped, the
  rest sorted, the newest 8 kept. Recovery logs how many queued episodes it suppressed
  and how many reserved ones it made uncertain.
- A stop is clean when the coordinator ends on SIGTERM or SIGINT and exits 0. The
  handlers are registered before recovery, so a stop that arrives during recovery
  exits 0 without starting the watcher, event stream, intervals, heartbeat or final
  record. On a clean stop the coordinator clears the heartbeat interval, waits for the
  in-flight write, drains, and writes one final record: the last heartbeat that landed
  with `stopped: true`, its `writtenAt` and `crashedAt` unchanged (so it is not
  refreshed into looking healthy). An instance that stops before its first heartbeat
  writes none, and its predecessor's record stands. A crash, SIGKILL, OOM kill, abort,
  a stop that hangs in the drain until systemd kills it, or a failed final write
  leaves `stopped` false and counts as a crash. `stopped` does not change the health
  status.
- Stopping a unit signals the `niri msg event-stream` child too, so the stream can end
  before the coordinator sees its own signal. When the lines end, the coordinator waits
  up to 1 s for the child's `close` (a child still alive then is killed and the end is
  a failure, exit 1). If the child died by a SIGTERM or SIGINT the coordinator did not
  send, it waits up to 1 s for its own SIGTERM or SIGINT: one that arrives is a clean
  stop (exit 0); none arriving (only the child was signalled), or any other end of the
  stream, exits 1 and supervision restarts it.
- `familiar-niri sync` neither reads nor writes the health record.

Readers derive `crashes`: the number of `crashedAt` entries with `0 <= now - t <= 10
minutes` at the reader's clock, for a valid record of the live boot and desktop
session (both known); otherwise null. The coordinator is **unstable** while the health
status is `healthy` and `crashes` is 2 or more. That reports any crash loop with a
period under about five minutes, whatever the unit's restart and start-limit
properties; rarer crashes are not reported. A coordinator that hangs without crashing
is not detected.

Unstable is a warning beside health, not a health status, and changes no gate: the
popup gate, the widget's trusted attribution and the coordinator's toast claims keep
requiring and doing what they did, so alerts keep working between crashes. The popup
logic validates schema 2 but does not compute `crashes`.
`familiar attention status` reports `health.crashes` beside `health.status`.

## The bar plugin

The plugin's service reads the feed every 50 ms and attention and health every 250 ms,
and shares what it read through `noctalia.state`. Each bar's widget draws pills for its
own output:

- Left click runs `familiar niri focus ID` with the pill's stable ID (never an index);
  right click dismisses exactly the alerts that pill showed when it was drawn; middle
  click stays Noctalia's settings gesture. The ⚑ button opens the Alerts panel, which
  dismisses per workspace even if right click is bound elsewhere.
- Familiar markers (identity outline, kind glyph, count, tooltip) are drawn only while
  the heartbeat is healthy and navigation comes from the feed. Native urgency is a
  separate theme-coloured dot.
- If the feed is untrusted, the service queries `niri msg -j workspaces` itself, at most
  every 250 ms and never overlapping: navigation continues, marked "Workspace feed
  reconnecting". If Niri fails too, the last rows stay as disabled stale labels,
  "Workspace navigation unavailable".
- A missing heartbeat, or one left from another boot or desktop session, gets a 10 s
  grace at startup; a missing or mismatched one (a coordinator restarting) must persist
  3 s before it counts. Otherwise an unhealthy coordinator shows "Agent alerts
  disconnected — toasts unavailable" and sends one notice through Noctalia (only on an
  exact DND `off`, at most one a minute, never as a backlog).
- An unstable coordinator (see "Crash history") shows a persistent node, "Agent alerts
  unstable — the coordinator crashed N times in 10 minutes; alerts arriving at each
  crash may be lost" (N is "8 or more" at the cap). It sits below a fault or a
  disconnection (either hides it) and beside the unknown-DND indication. An unstable
  episode runs from the first healthy reading with `crashes` of 2 or more to the first
  healthy reading with fewer; the non-healthy readings between (each restart passes
  through a mismatched record) neither end nor restart it, so the node stays through a
  brief restart and clears when `crashes` falls below 2. Each episode, including one
  found when the plugin starts, sends one notice, "Agent alerts unstable — the
  coordinator keeps crashing", by the disconnected notice's path (exact DND `off`, no
  replay) and its one-a-minute bound shared with it; a notice the bound or DND refuses
  is dropped, not delayed. The service publishes `crashes` and `unstable` in its shared
  health state.
- An unknown Do Not Disturb status is shown ("toasts and popups are not shown, and are
  not replayed later"), since it drops everything not yet shown.
- A dismissed withheld-completion diagnostic loses its glyph but stays in the tooltip
  (or, for an agent with no known workspace, in the unmapped status and the Alerts
  panel), marked dismissed: the completion gate it describes is still closed.
- Motion: a finite arrival (about 300 ms at 16 ms updates), then a slow pulse (200 ms
  updates) for an unseen request; otherwise static at 2 s updates. Reduced or off
  policy, DND, or an untrusted coordinator mean static distinctions only.

The plugin's Luau contract tests need the pinned Luau runtime: `node tools/fetch-luau.mjs`.

## Limits

- Mocked host contracts and the end-to-end fixture prove the pipeline's rules, not
  Wayland layout, native gestures, notification display or native latency; those belong
  to the gated pilot in the runbook.
- Claude sub-agent attribution is aggregate (above).
- A legitimately running Codex worker withholds its root's completion and shows the
  diagnostic; that completion is not announced later.
- Workspace IDs above 2^53 − 1 are refused rather than rounded.
