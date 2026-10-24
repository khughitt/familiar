# Consistent desktop attention for agent requests

Status: draft for user review; approach accepted in conversation, this written
specification and the implementation plan still require review before building.

Task: fam-9c8dd1. Coordination: ops-e40874. Related: ops-0dc04d (focus mode),
hq-b339a9 (earlier attention-source investigation).

## Intent and scope

When an agent needs the user, familiar's popup, the originating workspace's pill,
and a desktop toast should agree about the event and its source. A request must
remain discoverable after its arrival animation ends. Visiting and dismissing an
alert must never answer a question, grant approval, or cancel agent work.

The user accepted a shared attention model, a custom Noctalia workspace widget,
familiar hue as identity, and event-specific shape/motion. They also accepted
visiting the source to stop motion while unanswered requests retain a static
marker, and requested a widget gesture to withdraw alerts. The interpretation of
that gesture as **dismiss attention**, rather than cancel the underlying request,
is the designer's call for review.

This version covers local root agent sessions on Niri and Noctalia 5.3. It adds no
generic notification daemon, Noctalia fork, new repository, remote identity feed,
phone routing, focus schedule, or new art-generation work. Relay remains the
lifecycle and question authority; familiar supplies presentation and identity.
Keep the attention reducer independent of sprites and compositor APIs so it can
later move to a broader notification project without moving pet rendering.

## Current behavior and evidence

Verified against the code and installed desktop during the investigation:

- `integrations/niri-desktop/logic.js` announces only transitions into `done` and
  `error`; its QML shell reads `intent.json` and displays on the focused output.
- `src/render/term/emit.js` emits a bell on changes into `needs-input`,
  `needs-approval`, and `error`. Kitty's bell attention is a separate path from
  familiar's material signals and native harness OSC notifications. The earlier
  hq-b339a9 investigation traced those paths; it is historical evidence, not a new
  live reproduction of every reported mismatch.
- `src/protocol/intent.js` assigns state urgency/motion while preserving identity
  color. Its 8-second done and 30-second error expiry govern art presentation;
  they do not establish whether a request was answered.
- `src/observe/run.js` serializes relay projection with a presentation lock and
  publishes sessions and intent. `src/bus/projection.js` has event sequence and
  registry generation/basis information; its sequence can change without a new
  user request, so sequence alone cannot identify an attention episode.
- `integrations/niri/window.js` and `bin/familiar-niri` already join sessions to
  windows/workspaces and refresh when windows move. Unmapped sessions are omitted.
- The installed shell is Noctalia 5.3.0; the configured bar uses its built-in
  `workspaces` widget. Old QML plugin files are not the configured widget.

Noctalia's existing `workspace-alert-add-window` IPC can mark the source workspace,
but alerts are generic, lack per-source identity/type, and clear on activation.
It cannot supply the lifecycle described here. A custom Luau widget can render
clickable pills, borders, colors and tooltips. Bar animation uses update intervals,
not frame callbacks. Target the installed API through level 34; do not use newer
unreleased drag/drop or layer APIs.

Upstream references:

- [Noctalia 5.3 workspace alert IPC](https://github.com/noctalia-dev/noctalia/blob/v5.3.0/src/app/application_ipc.cpp)
- [Noctalia 5.3 alert lifecycle](https://github.com/noctalia-dev/noctalia/blob/v5.3.0/src/compositors/workspace_alert_service.cpp)
- [Plugin bar UI and limitations](https://docs.noctalia.dev/noctalia/plugins/development/declarative-ui/#barwidgetrender---declarative-bar-widget-ui)
- [Runtime notifications, processes and state](https://docs.noctalia.dev/noctalia/plugins/development/runtime-api/)

## Attention lifecycle

Maintain attention episodes separately from visual intent. Each episode has a
stable identity scoped to a relay registry/session incarnation, a session identity,
an event kind, creation/order information, pending/resolved status, and independent
seen/dismissed status. Identity color is optional presentation enrichment; missing
art must not prevent attention from being recorded or a pill/toast from appearing.

An episode starts when an authoritative root session enters `needs-input`,
`needs-approval`, or `error`. Duplicate observer delivery, reconciliation, progress
updates in the same waiting state, theme changes, and window moves retain its ID.
Leaving the actionable state for working/idle/done or ending the session resolves
the current episode.
A subsequent entry, or a different actionable kind, creates a new ID. A repeated
identical waiting state is the same episode until the source supplies a distinct
request identity or a state exit/re-entry. Do not invent distinct questions from
polling timestamps. Preserve relay's background-agent filtering: a worker ending
or the root waiting for its workers must not become a new user-facing completion.

For this version, no generic independent worker alerts are introduced. Attribute
root requests to the root session's terminal. If existing relay data cannot prove
the required root lifecycle for a harness, report that harness limitation and
resolve it in the plan before promising coverage; do not infer requests from prose.

`done` remains a low-priority finite familiar moment without a persistent demand
pill or a new desktop toast. Record it as a finite completion event on the same
delivery path, with a popup reservation and no pending request; retire the old
popup's independent transition detector when this path is enabled. Working/idle
do not interrupt. Error attention clears
when seen, dismissed, or superseded by later root state; input/approval attention
persists statically after being seen, until resolved or dismissed. Art expiry alone
does not resolve any attention episode.

Distinguish three operations:

1. **Seen:** activating the workspace containing the originating window marks
   its current episodes seen and ends their ongoing attention motion. Input and
   approval markers remain static. This is not request resolution. An event
   arriving on an already active workspace is immediately seen: it may show its
   finite arrival cue and popup/toast once, but does not start sustained pulsing.
2. **Dismissed:** right-clicking a pill dismisses the current episodes represented
   by that pill. Hide their attention markers and remove their queued transient
   announcements. A currently playing familiar attention moment for those IDs ends.
   An already delivered toast may finish its normal timeout; no global notification
   clearing is permitted. Keep the underlying requests pending and the status-line
   pet accurate. Persist dismissal across restarts for that episode only.
3. **Resolved:** relay/session lifecycle says the request ended or work resumed.
   Remove its pending marker and cancel queued attention for that episode.

Dismissal acts on the explicit IDs visible to the widget at the click, never
"everything currently on workspace N" at a later execution time. If another event
arrives concurrently it survives. Repeated dismissal is harmless; a stale click
must not dismiss a successor request. Reconcile always checks live episode IDs.

The dismiss action does not mute the session, workspace, event kind, or future
requests. Its tooltip must say "Right-click to dismiss current alerts" and explain
that requests remain pending. Middle-click retains Noctalia's settings shortcut.
The pill retains its usual workspace-switching left click. Dismissal never changes
relay question state, agent process state, permissions, or the source's native
compositor urgency.

## Desktop attribution and aggregation

Keep compositor knowledge in `integrations/`. Reuse the existing process ancestry
join; track stable window/workspace IDs and the output connector, using workspace
names/indices only as labels. Refresh after moves, renumbering, focus changes,
session changes, and compositor reconnects. Moving a source transfers its pending
marker, seen/dismissed state and identity; it does not create another arrival.
Moving an unseen source onto an active workspace marks it seen.

Without a reliable window mapping, show a generic project/session toast and retain
the pending episode for later mapping, but mark no guessed workspace. No automatic
focus change is allowed when an event arrives. On mapping failure or compositor
disconnect, remove stale workspace attribution and show that status in the widget
tooltip; do not present a last-known workspace as current.

Aggregate independently tracked episodes per workspace. Priority is error, then
approval, then input; equal kinds choose the newest episode, then stable ID. The
winner supplies the accent and event glyph; a count and tooltip expose all pending
undismissed episodes so one request cannot erase another. Recompute after seeing,
dismissing, resolving or moving any source. Native application urgency remains a
separate, theme-colored indicator and is never assigned familiar identity.

## Widget and motion

Implement a Noctalia v5 plugin under familiar's integrations, using Noctalia's own
palette for the base widget and familiar's existing resolved base color for the
attention accent. Use a neutral theme accent if identity enrichment is unavailable,
and identify the missing enrichment in diagnostics. Severity must remain legible
without color. Preserve active/occupied/empty workspace distinctions and normal
workspace navigation, monitor scoping, labels, orientation and tooltips. Do not
clone unrelated built-in widget options or add drag/drop in this version.

These treatments are proposed defaults, not user-approved pixel designs:

| Event | Arrival | Pending appearance |
| --- | --- | --- |
| Needs input | Small eased highlight expansion | Identity outline and input glyph; slow pulse until seen, then static |
| Needs approval | Brief stronger outline expansion | Identity double-outline treatment and approval glyph; slow pulse until seen, then static |
| Error | Short, firmer highlight pulse | Identity outline and error glyph; clears on seen/dismissed/later root state |
| Done | Existing finite familiar completion moment | No persistent demand marker |

Preserve hue across event kinds. Arrival motion should take roughly 200–350 ms,
with a low-amplitude sustained pulse around four seconds. No layout movement or
workspace relabeling is used for attention. Keep the animation inside the bar's
clip. Stop frequent updates when static; obey familiar's full/reduced/off policy
and any available stricter desktop motion setting. Reduced/off use static state
distinctions; off disables familiar popup animation without hiding pending pills
or suppressing the textual toast. Exact glyphs, dimensions, curves and update
cadence belong to the builder, verified with headless mockups before live rollout.

The familiar popup adds finite input and approval moments using existing state
art, preserving existing done/error moments and motion policies. It appears on
the user's focused output; the pill identifies the actual source workspace.

## Shared state and delivery boundaries

There is one portable attention reducer and durable snapshot, owned initially by
familiar. It consumes normalized lifecycle data and explicit seen/dismiss actions,
independently of sprite loading. Integrate it into observer reconciliation rather
than reconstructing episodes from a coalesced file watch. Persist enough session
incarnation, current episode and disposition information to avoid restoring a
dismissed request or resurrecting one after process/session ID reuse.

All writers use one locking/atomic-write discipline, including desktop attribution,
delivery receipts and user actions; reuse the existing lock/atomic-file helpers.
Readers receive a versioned, revisioned complete snapshot. They must converge after
a missed wake-up or reconnect. The builder chooses the smallest storage schema and
local read/watch/action interface satisfying these invariants; no network server
or new general event framework is required. New CLI vocabulary must follow the
shared CLI contract.

Extend the existing Niri integration as the single desktop attention coordinator,
with a singleton guard so duplicate launches do not duplicate toasts. It handles
workspace/focus enrichment and transient delivery decisions. The widget and popup
consume the same episode/disposition data; neither maintains an independent request
lifecycle. Consumers restore static pending state after restart and must not replay
historic arrival effects. Consumers retain stable IDs through coalesced updates.

Deliver one popup opportunity and one toast per actionable episode, independent
of workspace marker persistence. Queue transient effects per surface; combine a
burst into one summary if needed, retaining every contributing episode ID and all
pending widget markers. A higher-priority error may interrupt a lower-priority
popup, but the queued request must not disappear from pending state. An episode
resolved or dismissed before delivery is not announced later.

Persist per-surface delivery reservations before invoking an external surface so
restart cannot repeatedly announce a request. Delivery across processes is not
atomic: a crash after reservation may lose a transient effect, but the durable
pending marker must survive. Report failed/uncertain delivery and do not claim
exactly-once visual display. Restart favors avoiding repeated interruptions over
replaying uncertain sends. Serialize launch and dismissal decisions; an external
send already in flight at dismissal may complete, but no later one may start.

Use the existing desktop notification service with explicit familiar app identity
and generic event text, project/session label and workspace label when known.
Do not copy prompts, commands, transcripts or approval contents into notification
history. No toast action that answers/approves is added. Choose one notification
transport supported by the installed shell; do not send both internal and D-Bus
notifications for the same episode. Native harness toasts for covered agent events
must be disabled or filtered as part of the separately approved rollout, while
unrelated application notifications remain intact. Document the policy changes
before activating them; duplicate native toasts mean rollout acceptance fails.

Honor Noctalia Do Not Disturb for toast and familiar popup interruptions, retaining
pending static markers. Do not bypass DND by making ordinary agent errors critical.
No interruption backlog is replayed when DND ends; current pending markers remain.
Host-wide focus mode remains separate ops work; reserve no speculative settings
or scheduling mechanisms here.

Malformed state/action data fails explicitly with a bounded diagnostic. A broken
surface cannot block lifecycle capture or delivery to healthy surfaces. On loss of
the snapshot/coordinator, the widget shows a disconnected indication and stops
claiming stale workspace attribution; recovery reconstructs current markers without
replaying historic transients. A theme failure cannot destroy pending attention.

## Ownership, rollout and validation

Familiar owns the model, adapters, popup changes and plugin source. Ops coordinates
the work. Dotfiles owns bar/startup wiring; hq owns native harness notification
settings. File owner-specific rollout tasks during planning when their exact diffs
are known. Reuse relay's existing request/session lifecycle; any demonstrated relay
capability gap becomes a separately scoped owning task, not a silent fallback.

Prepare everything in task worktrees. Before implementation run the documented
full-suite baseline, then the focused and fast checks the project defines. The
plan must provide tests for:

- all actionable kinds, done/idle/working exclusions, duplicate delivery, repeated
  waiting state, exit/re-entry, worker completion suppression and session reuse;
- seen versus dismissed versus resolved, restart persistence, stale dismissal
  races, DND, motion policies and art/identity failure;
- multiple sessions sharing windows/workspaces, priority/counts, window moves,
  workspace renumbering, multiple outputs, missing mappings and disconnect/recovery;
- burst coalescing, per-surface reservations, send failures and process restarts,
  validating the documented crash limitation without losing pending requests;
- plugin navigation/gesture behavior, static distinctions and bounded animation
  updates against Noctalia 5.3, with no secret-bearing inherited fixture environment.

Use a nested/headless desktop for UI checks and a one-event-per-kind pilot before
longer acceptance. Live installation, opening desktop windows, or emitting real
notifications requires approval at that moment. The rollout runbook must name
previous bar/startup/native-notification settings and exact restoration steps.
Use one host and profile end to end for a shared installation path; a differently
configured harness gets its own event-mapping check. Run `tasks check` and report
every warning before completion. Update current reference docs when behavior lands.

The written spec is reviewed before the implementation plan; the plan is reviewed
before code changes. Pixel-level treatment can be revised after headless previews
without changing the request lifecycle. This draft authorizes no live host changes.
