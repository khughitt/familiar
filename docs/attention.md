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
  It is healthy only while under 10 s old, from this boot and this desktop session, and
  from the coordinator that classified the saved state.
- **Attention**: debounced passes that take the presentation lock only when attribution
  changed or an episode awaits classification, with all IPC outside the lock. Focus
  changes take the lock only to mark unseen episodes on the newly focused workspace.

DND is polled with the heartbeat. `familiar-niri sync` runs one pass of the same work
and leaves attention alone while `watch` runs.

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
- An unknown Do Not Disturb status is shown ("toasts and popups held back"), since it
  suppresses everything not yet shown.
- A dismissed withheld-completion diagnostic loses its glyph but stays in the tooltip,
  marked dismissed: the completion gate it describes is still closed.
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
