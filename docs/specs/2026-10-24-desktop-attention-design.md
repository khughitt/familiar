# Consistent desktop attention for agent requests

Status: draft for user review; approach accepted in conversation, this written
specification and the implementation plan still require review before building.
Revision: replaces the lifecycle assumptions in `eccdaa3` following spec round 2.
Round-5 revision: qualifies source identity and unconfirmed workers, and separates
completion history from marker visibility. The replacement commit is recorded on
the task after freezing it; earlier reviewed commits remain unchanged.

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

This version covers local agent sessions, including reported worker requests
attributed to their root terminal, on Niri and Noctalia 5.3. It adds no
generic notification daemon, Noctalia fork, new repository, remote identity feed,
phone routing, focus schedule, or new art-generation work. Relay remains the
lifecycle and question authority; familiar supplies presentation and identity.
Keep the attention reducer independent of sprites and compositor APIs so it can
later move to a broader notification project without moving pet rendering.

## Current behavior and evidence

Verified against familiar code and the installed desktop. Relay evidence below is
from the worktree's pinned v0.1.1 dependency, commit
`4ceec5d2ad22b136b37ee360e7a4ed00949f28d9`, not an assumed current upstream API:

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
- That projection currently overwrites a root's state with a newer worker state.
  It is unsuitable as attention truth: worker activity can erase root approval,
  and worker completion can look like root completion. The new attention path
  must consume raw registry rows before that fold. The fold is familiar behavior,
  not something relay's Claude-specific background filter prevents.
- `integrations/niri/window.js` and `bin/familiar-niri` already join sessions to
  windows/workspaces and refresh when windows move. Unmapped sessions are omitted.
- The installed shell is Noctalia 5.3.0; the configured bar uses its built-in
  `workspaces` widget. Old QML plugin files are not the configured widget.

The available lifecycle coverage is narrower than the visual state vocabulary:

| Harness | Input request | Approval request | Error | Completion evidence |
| --- | --- | --- | --- | --- |
| Claude Code | `Notification:idle_prompt` only | `Notification:permission_prompt` | `StopFailure` | Root `Stop` normally reduces to `done`; in-flight background agents reduce it to `working` |
| Codex | No mapped event | `PermissionRequest`, including identified workers | No mapped event | Root `Stop` reduces to `done`; `SubagentStop` is a separate worker's `done` |
| OpenCode | No mapped event | Aggregate `permission.pending` | `session.error` | `session.idle` has kind `idle`, but `reduceState` converts prior working/input/approval to `done`; prior error stays error |

Sources: `node_modules/relay/src/adapters/{claude-code,codex,opencode}.js`,
`src/bus/transaction.js` inside that dependency, and
`integrations/opencode/{binding,window}.js` inside it. OpenCode represents an
aggregate process/window here, not independently identified worker rows.
Its plugin consumes `permission.replied` and publishes the recomputed aggregate
level: the last reply can become busy/working or idle/done. Claude and Codex have
no mapped approval-result event. No harness-independent request ID or exact
approval-resolution feed can be assumed from these observer records.

Only Codex implements `workerIdOf` in the pinned adapters. Claude events carrying
the same native session ID normalize into the same relay source: a sub-agent's
`PreToolUse` cannot be distinguished from the root's tool start. The separate-source
guarantees below therefore apply to identified Codex workers, not separate Claude
sub-agents within one normalized session. Planning must check whether parallel
Claude sub-agents keep emitting tool events while another awaits permission;
that runtime scheduling behavior is not established by the adapter code alone.

Codex worker rows use the root process handle, and no elapsed-time expiry can
prove a worker ended. The registry explicitly removes associated workers at root
teardown; a missing `SubagentStop` can leave a worker working while its root stays
alive. Whether an interrupt reliably emits that hook has not been verified.

Claude's idle notification is delayed relative to turn end; its threshold is
harness behavior and was not verified in this repository. Do not build in an
assumed one-minute timer. Codex and OpenCode must not be presented as having
native `needs-input` events. Use completion notices below to cover an unfocused
turn ending, without claiming that completion proves a question is pending.

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
- [Noctalia v5 configuration layers](https://docs.noctalia.dev/noctalia/configuration/)

## Attention lifecycle

Maintain attention episodes separately from visual intent. Key their source by
raw relay agent ID and incarnation; keep its root ID separately for attribution.
Each episode has stable identity, event kind, source observation/order information,
open/closed attention status, and independent seen/dismissed status. "Open" means
the attention has not been disposed of; it is not proof that a native permission
dialog is still open. Missing art must not prevent recording an episode or showing
a pill/toast.

Read roots and workers separately from relay's raw snapshot. A source entering
`needs-input`, `needs-approval`, or `error` starts its own episode. Activity from
that same source supersedes its episode; another identified relay source's
activity cannot. A root
request and a worker request may coexist. An identified worker's approval/input/
error uses the root's terminal, workspace and familiar hue, with a worker label in
the tooltip, and its own episode ID. Do not invent worker event kinds a harness
does not report. A missing/invalid root association leaves it unmapped and diagnosed.
Any different state of the same source closes its previous episode before a new
actionable episode is considered; this includes a worker's transition into `done`.
Completion episodes have explicit exceptions: the same-turn completion-to-input
upgrade below, and passive idle observations, which retain the completion.

**Accepted Claude attribution limitation:** distinct Claude sub-agents sharing
one normalized session are one aggregate source in v1. If another sub-agent's
tool-start changes that source from approval to working, the generic closure
rule can hide the approval while its native dialog remains open. Do not claim
per-sub-agent request retention for Claude or label that transition proof of an
answer. The widget's Claude session tooltip must disclose aggregate attribution
and this possible early closure. Choose this bounded limitation over guessed
worker IDs or unverified root-only event heuristics. Planning must record the
parallel-permission check's result and add the aliasing regression case; if the
scenario reproduces, its early closure is an explicitly accepted v1 limitation,
not a passing claim that the marker survives. A failed reproduction does not
establish separate source identity. The same ambiguity affects which Claude tool
activity is classified as new session work; the lifecycle is an observed-session
view, not an inventory of every native sub-agent request.

A worker ending closes only its own attention and never creates a user-facing
completion. Ending/reaping the root closes its attention and associated workers.
An ordinary root state change closes only root-owned attention. A root `done` is
eligible for completion presentation only when no raw worker row for that root
remains working or requesting attention; preserve Claude's own background-count
reduction too. A completion suppressed for workers is not announced later merely
because a worker finishes: it needs a subsequent genuine root completion. Retire
the popup's folded-intent transition detector when the shared path is enabled.

**Unconfirmed worker rule:** do not expire or reap worker rows using age or the
shared root process handle, and do not silently ignore a worker to unlock a
completion. Whenever worker state blocks a genuine root completion, publish a
static diagnostic on the root's pill: "Completion withheld — worker status
unconfirmed", listing the blocking worker IDs, states and last-observation ages
in the tooltip. Show it even on the focused workspace, even when there is no
request episode. It is neither a completion marker nor a claim the worker is
dead, and emits no popup/toast. If the root cannot be mapped, show a global widget
diagnostic without inventing a source workspace.

The diagnostic is dismissible separately from request episodes. Its identity is
the root incarnation plus the set of blocking worker incarnations; dismissal
survives further withheld completions for that unchanged set. Keep suppression
status available in the tooltip after dismissal. Dismissing this diagnostic does
not modify relay, assert worker completion, or override the completion gate. An
authoritative worker transition/teardown can remove its blocking condition; root
teardown clears it. Once all blockers clear, close the diagnostic, but do not
replay a previously withheld completion. A later eligible root completion gets
normal presentation. A stranded worker approval remains an aged, explicitly
unconfirmed request observation until source progress, dismissal or root teardown;
the same no-timeout rule applies to it. Restore diagnostics and their dismissal
state across coordinator restart without replaying notices.

Duplicate delivery, reconciliation, repeated observations of the same waiting
state, theme changes, and window moves retain episode IDs. A subsequent exit and
re-entry creates a new episode. These state-level records do not distinguish
several native questions arriving while the same source remains `needs-approval`;
show one aggregate source marker, not a fabricated count of permission dialogs.
Any future request-ID support is a contract change, not a requirement of this plan.

### Unfocused turn completion

Design ruling: a genuine root completion on an unfocused source workspace leaves
a **static "Turn finished" marker**, plus one low-priority popup/toast opportunity.
It makes the common handoff discoverable without mislabeling it as `needs-input`.
A completion on the focused workspace retains the finite familiar moment, with
no new completion marker or toast. It still records the completed turn and its
seen/delivery decisions. Working and ordinary idle do not interrupt.
For OpenCode, recognize the reduced root transition into `done` even though the
native event kind is `idle`; init/idle-to-idle and error-to-idle are not completion.
Evaluate focus when the desktop coordinator first classifies the episode, using
its latest validated compositor snapshot. Relay does not publish event-time focus;
do not claim this reconstructs what the user was looking at when a hook fired.

The completion marker clears on source focus, dismissal, new activity from its
root, or root end. Genuine new activity is that root's mapped prompt/before-tool/
activity or a transition back to working, not an idle observation, a worker update
or reconcile. OpenCode can publish `working → done → idle → idle` because repeated
`session.idle` reduces done to idle. Such passive idle keeps the completion episode
ID, disposition and delivery decisions across reconciliation and restart; it
neither closes it nor creates another arrival/reservation. A new actionable root
request supersedes the completion, except for the same-turn input upgrade below.
Art expiry does not clear an unseen completion. If origin/focus
is unknown, retain the completion without guessing a pill or sending a completion
toast. On first reliable mapping, an otherwise still-current completion may become
a static marker on an unfocused workspace, without replaying transient effects.

**Marker visibility is not turn history.** A focused, seen, dismissed or otherwise
hidden completion remains the root incarnation's recorded completed turn until
its next genuine activity or teardown/incarnation change. Focus, art expiry,
passive idle, marker removal and reconciliation must not delete that metadata.
Persist the turn/episode ID, seen/dismissed dispositions and per-surface delivery
or suppression decisions independently of its visible marker, including across
restart. A later actionable request may replace the visible completion treatment
without erasing this deduplication history. Never erase the recorded turn merely
because there was no marker to show when it finished.

A late Claude idle-input notification for the same completed root turn upgrades
that turn's episode to input attention, preserving its ID, seen/dismissed state
and delivery decisions (including any suppression). The upgrade starts no new
popup/toast opportunity. Later root
activity ends that turn association. A late input notice without a recorded
completion starts an ordinary input episode. Do not infer association across an
intervening root activity or session incarnation.
Thus watching a Claude turn finish, then receiving its delayed idle-input notice
with no intervening genuine activity, uses the recorded seen completion and cannot
start another popup/toast. The ordinary input static-marker policy may apply after
the upgrade; a dismissed episode must stay dismissed. The Claude aggregate-source
ambiguity above still limits how genuine session activity can be identified.

### Approval uncertainty

Choose truthful last-observed status over provisionally resolving an approval on
focus. Claude/Codex may retain `needs-approval` until their next mapped tool-start,
prompt, turn-end or session-end event. A ten-minute tool can therefore leave that
observation for ten minutes; in silence there is **no finite bound** on the lag.
OpenCode's last `permission.replied` normally causes a queued aggregate update
without waiting for the tool to finish, but observer delivery is still asynchronous.

Apply the label **"Approval requested — response unconfirmed" to approval episodes
from all three harnesses**, including OpenCode and identified worker requests,
with observation age in the tooltip. OpenCode reply evidence normally closes the
observation sooner; it does not change the wording of a still-displayed episode.
Never assert "approval pending" or a current dialog count.
Focus stops motion and leaves this explicitly historical static marker until a
same-source state change or dismissal. It does not mark a request answered, send
another notice or expire it on a guessed timeout. This accepts a stale observation
while exposing its uncertainty; user dismissal is the immediate way to remove it.

Input attention also remains statically after being seen until superseded or
dismissed. Error attention clears when seen/dismissed or after a same-source state
change. Art expiry never proves that a native request was answered.

Distinguish three operations:

1. **Seen:** the source workspace becomes Niri's globally **focused** workspace
   (`is_focused`), not merely `is_active`/visible on another monitor. Mark its
   episodes seen and stop motion; input/approval markers remain static with the
   qualifications above, and completion/error markers clear. An event on the
   already focused workspace is immediately seen: input/approval/error may show
   their finite arrival cue and popup/toast once, but never sustained pulsing.
2. **Dismissed:** the pill's dismiss action (right-click preferred, subject to the
   planning check below) dismisses the current episodes represented
   by that pill. Hide their attention markers and remove their queued transient
   announcements. A currently playing familiar attention moment for those IDs ends.
   An already delivered toast may finish its normal timeout; no global notification
   clearing is permitted. Leave native request state unchanged; do not rewrite
   the status-line pet. Persist dismissal across restarts for that episode only.
3. **Closed by source:** a same-source state change or session teardown supersedes
   the observed request. Remove its marker and cancel queued attention. This is
   observable lifecycle progress, not proof of an approval outcome.

Dismissal acts on the explicit IDs visible to the widget at the click, never
"everything currently on workspace N" at a later execution time. If another event
arrives concurrently it survives. Repeated dismissal is harmless; a stale click
must not dismiss a successor request. Reconcile always checks live episode IDs.

The dismiss action does not mute the session, workspace, event kind, or future
requests. Its tooltip names the selected gesture and explains that native requests
are unaffected (for right-click: "Right-click to dismiss current alerts").
Planning must first verify Noctalia 5.3's
widget and inline-pill right-click bindings/dispatch with pinned source and a
headless event check. Do not assume a compiled widget's gesture is free. Prefer an
unmodified right click only if it preserves existing behavior; otherwise use a
modifier plus right click if supported, or an explicit dismiss action in the
plugin's own panel. Any new shortcut follows the shared key vocabulary. Record the
selected route and tooltip in the plan. Middle-click
retains settings and left-click retains workspace switching. Dismissal never changes
relay question state, agent process state, permissions, or the source's native
compositor urgency.

## Desktop attribution and aggregation

Keep compositor knowledge in `integrations/`. Reuse the existing process ancestry
join; track stable window/workspace IDs and the output connector, using workspace
names/indices only as labels. Refresh after moves, renumbering, focus changes,
session changes, and compositor reconnects. Moving a source transfers its pending
marker, seen/dismissed state and identity; it does not create another arrival.
Moving an unseen source onto the globally focused workspace marks it seen. A
workspace visible on another monitor remains unseen until it receives focus.

Without a reliable window mapping, an input/approval/error may show a generic
project/session toast while retaining its episode for later mapping; completion
instead follows the unknown-origin rule above. Mark no guessed workspace. No automatic
focus change is allowed when an event arrives. On mapping failure or compositor
disconnect, remove stale workspace attribution and show that status in the widget
tooltip; do not present a last-known workspace as current.

Aggregate independently tracked episodes per workspace. Priority is error, then
approval, then input, then completion; equal kinds choose the newest episode,
then stable ID. The winner supplies the accent and event glyph; a count and tooltip expose all pending
undismissed source episodes so one request cannot erase another. The count is of
episodes, not native dialogs or unanswered questions. Recompute after seeing,
dismissing, resolving or moving any source. Native application urgency remains a
separate, theme-colored indicator and is never assigned familiar identity.
Unconfirmed-worker suppression uses a separate small status glyph so it remains
visible alongside a higher-priority request; it is not included in request counts.
If the preferred dismiss gesture is direct, it dismisses the explicit episode and
diagnostic IDs represented at that click; neither can accidentally dismiss a new
diagnostic for a changed blocker set. The tooltip distinguishes dismissing a
diagnostic from changing the underlying completion gate.

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
| Approval requested, response unconfirmed | Brief stronger outline expansion | Identity double-outline and approval glyph; slow pulse until seen, then historical static marker with observation age |
| Error | Short, firmer highlight pulse | Identity outline and error glyph; clears on seen/dismissed/later same-source state |
| Turn finished on unfocused workspace | Finite familiar completion moment and low-priority toast | Static identity completion glyph until focused/dismissed/new root activity |
| Turn finished on focused workspace | Existing finite familiar completion moment | No marker or toast |

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
than reconstructing episodes from a coalesced file watch or folded `intent.json`.
Preserve separate source/root IDs and source states through reconciliation, even
where the existing pet presentation still uses a worker fold. None of the new
popup, pill or toast decisions may consult that folded state as lifecycle truth.
Persist enough session incarnation, current episode and disposition information to avoid restoring a
dismissed request or resurrecting one after process/session ID reuse.

All episode/control snapshot writers use one locking/atomic-write discipline, including desktop attribution,
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

Deliver one popup opportunity and one toast per input/approval/error episode, and
the completion opportunities defined above, independent of marker persistence.
Seen stops ongoing motion but does not itself cancel a new finite arrival cue;
dismissal and same-source closure cancel any not-yet-started delivery.
Queue transient effects per surface; combine a burst into one summary if needed,
retaining every contributing episode ID and all
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

Familiar has no existing toast sender. Add a Noctalia integration transport using
the native Noctalia 5.3 IPC command `noctalia msg notification-show <json-payload>`
as an argument vector, with `app_name`, `summary`, `body` and normal/low `urgency`.
That command and its JSON fields were verified in the pinned 5.3 source. No new
notification daemon or parallel `notify-send` path is needed. Use explicit familiar
app identity and generic event text, project/session label and workspace label
when known.
Do not copy prompts, commands, transcripts or approval contents into notification
history. No toast action that answers/approves is added. Native harness toasts for
covered agent events must be disabled or filtered as part of the separately approved rollout, while
unrelated application notifications remain intact. Document the policy changes
before activating them; duplicate native toasts mean rollout acceptance fails.

Extend the existing `bin/familiar-noctalia` integration for native Noctalia IPC,
including the live `noctalia msg notification-dnd-status` query, whose `on`/`off`
result is validated. Its present `scheme-sync` reads `settings.json` for a scheme
key only; that does not establish a live DND contract. Noctalia v5 has TOML
configuration/overrides, so do not infer current DND from that older JSON input.
An unavailable/invalid DND response is unknown, never silently "off": retain
static indicators and diagnose the integration. On DND unknown or on, drop queued
and not-yet-started popup/toast opportunities and persist their suppressed delivery
decisions for the affected episode IDs; do not hold them for later delivery. Stop
ongoing familiar attention motion; an external send already in flight may finish
and a delivered toast may expire normally. When DND becomes known/off, announce
only new eligible events, never the dropped queue. The same no-replay rule applies
to queued health notices. Test unknown→off as well as on→off through this adapter.

Honor Noctalia Do Not Disturb for toast and familiar popup interruptions, using
static pill markers instead of attention animation while DND is on. Do not bypass
DND by making ordinary agent errors critical.
No interruption backlog is replayed when DND ends; current pending markers remain.
Host-wide focus mode remains separate ops work; reserve no speculative settings
or scheduling mechanisms here.

Malformed state/action data fails explicitly with a bounded diagnostic. A broken
surface cannot block lifecycle capture or delivery to healthy surfaces. On loss of
the snapshot/coordinator, the widget shows a disconnected indication and stops
claiming stale workspace attribution; recovery reconstructs current markers without
replaying historic transients. A theme failure cannot destroy pending attention.

### Detecting coordinator failure

Turning native harness toasts off makes coordinator health part of rollout
acceptance. Run the existing Niri coordinator under a transient user service with
restart-on-failure, replacing its old unsupervised startup rather than launching
a second copy. Starting that host service still requires the rollout approval;
this spec starts nothing. The runbook must provide status, logs and stop commands.

Publish the heartbeat in its **own `attention-health.json` file**, using the
existing state-directory configuration, separate from the episode/control
snapshot. The singleton coordinator is its only writer; replace the file atomically
without taking the presentation/episode lock or incrementing the attention
revision. Heartbeat refreshes must not trigger lifecycle projection or event
delivery. It is an explicit exception to the episode/control writer discipline.

Publish a coordinator-instance heartbeat every two seconds, including the
instance identity and boot/session identity so a leftover snapshot cannot look
healthy after reboot. The widget independently checks it every two seconds; a
missing/stale (>10 seconds), malformed or mismatched heartbeat causes a persistent
"Agent alerts disconnected — toasts unavailable" indication, replacing trusted
workspace attention attribution. Do not rely on agent state updates as a heartbeat:
an idle but healthy coordinator must stay distinguishable from a dead one.

On the healthy-to-disconnected transition the still-running Noctalia plugin sends
one independently generated health notification via Noctalia's runtime notification
API, subject to live DND; do not route it through the failed coordinator. This is
a service-health notice, not a duplicate agent-event transport. On startup, an
absent heartbeat gets the same ten-second grace before one notice. On recovery,
clear the disconnected state; no notification backlog is replayed. Bound repeated
failure notices to one per minute across flaps. Even under DND, or if the health
toast cannot be delivered, the persistent bar indication remains. No widget can
report through Noctalia while Noctalia itself is down; the service status/logs and
restart supervision are the remaining diagnostics, not a promised toast fallback.

## Ownership, rollout and validation

Familiar owns the model, adapters, popup changes and plugin source. Ops coordinates
the work. Dotfiles owns bar/startup wiring; hq owns native harness notification
settings. File owner-specific rollout tasks during planning when their exact diffs
are known. Reuse relay's existing request/session lifecycle; any demonstrated relay
capability gap becomes a separately scoped owning task, not a silent fallback.

Prepare everything in task worktrees. Before implementation run the documented
full-suite baseline, then the focused and fast checks the project defines. The
plan must provide tests for:

- the pinned harness coverage table, including OpenCode's idle-event reduction and
  last permission-reply aggregate update, and absent Codex input/error events;
- Codex root approval followed by worker working/done (root marker survives), worker
  approval attributed to root without overwriting it, root and worker requests
  coexisting/closing independently, root completion suppressed for live workers,
  duplicate delivery, repeated waiting state, exit/re-entry and session reuse;
- Claude same-session approval followed by another sub-agent's before-tool event:
  verify the adapter aliases them, exercise and label the accepted early-closure
  behavior and tooltip, and require planning's parallel-permission runtime check
  to determine whether the scenario occurs with the installed harness;
- Codex missing SubagentStop while the root remains alive: repeat genuine root
  completions, retain conservative suppression but show the diagnostic each time
  unless its unchanged blocker set was dismissed; show stranded approval age,
  survive restart, remove confirmed blockers and handle the next real completion
  without replaying a withheld one. Verify diagnostic dismissal never answers a
  request, removes a worker, or overrides suppression;
- genuine root completion on focused versus unfocused workspaces, ordinary idle
  exclusions, late Claude idle-input upgrade without another announcement, and
  unknown-origin completion mapped later without replay;
- OpenCode `working → done → idle → idle`: preserve the same completion ID,
  seen/dismissed state and delivery decisions through passive idle, reconciliation
  and restart, announce at most once, then clear it on genuine new root activity;
- Claude completion while focused, or an unfocused completion later seen/dismissed:
  retain completed-turn metadata after clearing/hiding the marker, restart, then
  process delayed idle-input with the same episode/dispositions and no new popup/
  toast opportunity; require the dismissed case to stay hidden. Include a control
  where genuine new activity ends the old turn association;
- Claude/Codex approval granted before a ten-minute tool with no further event:
  retain the explicitly unconfirmed observation, stop motion on seen/dismiss,
  never claim it is currently pending, then close only on same-source evidence;
- seen versus dismissed versus resolved, restart persistence, stale dismissal
  races, DND, motion policies and art/identity failure;
- all-harness approval wording (including OpenCode's reply-driven closure), plus
  unknown-DND queue suppression followed by known/off with no backlog replay;
- multiple sessions sharing windows/workspaces, priority/counts, window moves,
  workspace renumbering, multiple outputs (visible is not focused), missing
  mappings and disconnect/recovery;
- burst coalescing, per-surface reservations, send failures and process restarts,
  validating the documented crash limitation without losing pending requests;
- plugin navigation/gesture behavior, static distinctions and bounded animation
  updates against Noctalia 5.3, including right-click conflict/fallback verification,
  with no secret-bearing inherited fixture environment;
- native toasts disabled, then kill/freeze the coordinator with healthy Noctalia:
  restart supervision, ten-second disconnected detection, independent health
  notice, DND, flap limiting, stale heartbeat after reboot, and successful recovery;
- a held presentation lock does not block atomic heartbeat refresh, and refreshing
  `attention-health.json` does not change the attention revision or run projection.

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
