# Desktop Attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Inline execution is the recommended default because these tasks share one state contract; retain the independent final whole-branch review and corrective rounds required by the repository instructions.

**Goal:** Make familiar's popup, Noctalia workspace markers and desktop toasts consume the same durable attention episodes without inventing harness lifecycle evidence.

**Architecture:** A portable reducer records raw relay sources independently of the existing pet-state fold. One atomically written attention snapshot owns episodes, completed-turn history, dispositions and delivery reservations; the Niri coordinator supplies desktop attribution and delivery policy. Ordinary workspace navigation uses a separate immediate, lock-free topology feed, with direct read-only Niri polling if that feed fails. QML and a native Noctalia plugin share attention episodes, while an independent heartbeat exposes coordinator failure.

**Tech Stack:** Node.js 22+, existing relay v0.1.1 public exports, existing atomic-write/lock helpers, Niri 26.04 socket/event IPC, Quickshell/QML and Noctalia 5.3 Luau API 34. Luau 0.743 is the pinned development contract-test runtime; no new npm or production service dependency.

**Spec:** `docs/specs/2026-10-24-desktop-attention-design.md`, accepted frozen commit `2b58b29009267ac0978945515cdadc3309736a74`, SHA256 `80b40928412fd0ab43c63fcc5e20c64576ca695ed5542ef0bb610c052468d1b9`. Task `fam-9c8dd1`; coordination `ops-e40874`. This plan is a separate review gate and does not authorize implementation or live activation.

## Global Constraints

- Local Niri and Noctalia 5.3; `plugin_api = 34`. No Noctalia fork, new daemon/repository, network server, phone routing, focus scheduling or new art generation.
- Preserve independent raw Codex root/worker source states. Claude same-session worker attribution remains an accepted v1 limitation, never a successful separate-worker retention claim.
- Global Niri `is_focused` defines seen; another monitor's visible `is_active` workspace does not.
- Dismiss explicit episode/diagnostic IDs only. Never answer a request, grant approval, mutate relay or unlock completion suppression through dismissal.
- Approval wording for all harnesses: `Approval requested — response unconfirmed`, with observation age. There is no finite bound on Claude/Codex approval-observation lag.
- A missing worker end hook causes a visible `Completion withheld — worker status unconfirmed` diagnostic, not guessed expiry. No replay of withheld completion.
- Keep completed-turn history after initially focused, seen, hidden or dismissed markers. Passive OpenCode `done → idle → idle` preserves it; same-turn Claude idle-input cannot create another transient opportunity.
- Delivery reservations precede external sends. A crash may lose a transient effect; pending attention survives. Never promise exactly-once visual display.
- Unknown/on DND suppresses queued opportunities durably; known/off never replays them. In-flight external sends may finish.
- `attention-health.json` is independent of the presentation lock/revision/projection. Heartbeat every 2000 ms; stale after more than 10000 ms; independent health notices no more than once per 60000 ms.
- Pill arrival 200–350 ms at 16 ms updates only during that finite arrival; sustained low-amplitude pulse approximately 4000 ms at 200 ms updates. Static widgets use 2000 ms updates plus shared-state invalidation. Reduced/off use static distinctions.
- Normal navigation never waits for the presentation lock, identity/art, notification IPC or the 100 ms attention debounce. Healthy topology-to-widget latency budget is 100 ms under the explicit I/O assumptions below; native timing remains to be measured.
- Generic notification content only: no prompts, tool arguments, transcript prose, commands or approval contents in toast history or fixtures.
- Preserve the launchers' dependency boundary and familiar-theme package exports. Do not change relay or add compatibility layers.
- All new subprocess fixtures build environments key by key before RED, with temporary HOME, fake credentials, and isolated git configuration where git is used.
- Use the existing test front door. This checkout has no `test-one` or documented focused route: each RED/GREEN and pre-commit check uses `just test-fast`; do not call Node's test runner directly or add a recipe to fill the gap.

## Review Focus

1. Delayed old events, registry replacement or PID reuse must not reopen a dismissed successor request: Task 1 and Task 2 tests.
2. A source moves, disappears or changes output between display and click: Task 4 attribution and Task 6 captured-ID tests.
3. A crash between reservation and display, or between independent file renames, must not duplicate notices or destroy pending state: Task 2, Task 4 and Task 5 tests.
4. Luau drops JSON null keys and callbacks retain an old render's IDs: Task 6 runs every production entry in Luau with the real CLI view, not a hand-maintained idealized fixture.
5. Coordinator death, presentation-lock contention, unknown DND and a quiet session must remain distinguishable without replaying a queue or removing ordinary navigation: Task 4 and Task 6 topology/latency/watchdog tests.

## Planning checks and remaining validation

The sanitized `planning-checks.json` attachment on `fam-9c8dd1` records the checks already performed. Persistent reproducer/source copies and their manifest are noted on the task, off the synced checkout.

| Check | Observed result | Limit and disposition |
| --- | --- | --- |
| Codex parent/worker timelines, 2026-10-23/24 | 122 rollout files, 51 parent/worker pairs; no root completion inside an active worker turn found | Lifecycle records were verified nonempty; this bounded sample is not proof that overlap is impossible. Spec round 7 minor remains deferred. |
| Claude parallel permission waits | Thirty recent sessions had 544 bypassPermissions records and no explicit permission-wait boundaries | Inconclusive; cannot establish runtime scheduling during a permission wait. The attribution limitation stays accepted regardless. |
| Noctalia 5.3 click routing | Two headless self-checks passed using exact callback bodies from pinned `plugin_widget.cpp` and `ui_tree_reconciler.cpp` | Proves callback registration/dispatch only, not Wayland hit testing or configured action interception. Native runtime gesture acceptance remains Task 6/rollout validation. |
| Modifier fallback | Pinned native gesture test explicitly rejects modifier chords | Do not choose modifier-plus-click. Use the explicit left-click Alerts panel fallback. |
| Niri focused field | Read-only installed workspace query returned boolean `is_focused` for every workspace and exactly one true | Does not test every multi-monitor transition; fixtures and the eventual desktop pilot still do. |
| Plugin workspace capabilities | Published runtime API supplies outputs, file/process APIs and notifications, but no workspace list/events or focus-by-ID API | Task 4 supplies a separate topology feed and socket helper; Task 6 implements its own bounded read-only recovery query. [Runtime API](https://docs.noctalia.dev/noctalia/plugins/development/runtime-api/). |
| Niri 26.04 ID route | Pinned IPC source defines `Action(FocusWorkspace { reference: Id(u64) })`; EventStream initially supplies full workspace state | Source verification, not a live focus action or performance measurement. [Protocol](https://github.com/YaLTeR/niri/blob/v26.04/niri-ipc/src/lib.rs), [socket framing](https://github.com/YaLTeR/niri/blob/v26.04/niri-ipc/src/socket.rs). |
| Contract runtime | Private Luau 0.743 release binary passed three capability checks: Luau-only syntax, double-number behavior and isolated entry environments | No plugin exists yet; this is interpreter preparation, not a plugin test. Release archives/digests are pinned below. |

`hq-4c954d` owns the remaining bounded native concurrency evidence. It must check Claude parallel permission scheduling and whether Codex normally ends root turns with workers active, without changing live settings, emitting desktop alerts or launching paid model runs without separate authorization. If ordinary Codex overlap is observed, revisit the deferred warning/completion policy before rollout; do not silently change the accepted spec. Actual interrupt-to-SubagentStop guarantees are not required: test the missing-hook case conservatively.

These evidence limits do not authorize treating an unperformed native check as passed. They block live rollout, not implementation of the explicitly accepted v1 attribution limit. `hq-d6e13a` prepares native-toast suppression while preserving relay hooks; `dots-dfecf1` prepares plugin/bar/startup changes. `ops-f800b0` declares the CLI contract before Task 3. The ops goal depends on the code and owner-specific rollout tasks so code readiness cannot close desktop acceptance.

| Plan step | Task | Prerequisites |
| --- | --- | --- |
| 1 | `fam-2b65f5` | Accepted implementation plan and execution baseline |
| 2 | `fam-14cb56` | Step 1 |
| 3 | `fam-c58260` | Step 2; `ops-f800b0` contract landed/adoptable |
| 4 | `fam-e810ef` | Step 3 |
| 5 | `fam-f34642` | Step 4 |
| 6 | `fam-4796ce` | Step 4 |
| 7 | `fam-fa17bb` | Steps 5 and 6 |

All seven steps and the CLI contract prerequisite are blocked pending this plan's user review. Native validation/activation stays with the separate owner tasks above.

## File responsibilities and fixed interfaces

| Path | Responsibility |
| --- | --- |
| `src/attention/model.js` | Pure schema, raw-source lifecycle, completed turns, dispositions, diagnostics and delivery state machine |
| `src/attention/store.js` | Strict reads, shared presentation-lock mutations, atomic state publication, health-aware read view |
| `src/attention/commands.js` | Three attention CLI leaves; no rendering or Niri calls |
| `src/observe/run.js`, `src/bus/paths.js` | Capture before visual failures; declared state/health/coordinator-lock paths |
| `src/commands.js`, `bin/familiar.js`, `tools/cli.toml` | Declared CLI surface, help/completion and dispatch; table adopted from ops |
| `integrations/niri/attention.js` | Pure origin/workspace projection from raw sources and Niri data |
| `integrations/niri/topology.js`, `integrations/niri/ipc.js` | Lock-free workspace feed/event reduction and bounded socket action by stable ID |
| `integrations/niri/coordinator.js`, `bin/familiar-niri` | One runtime watcher, delivery coordination, heartbeat, cleanup and recovery |
| `integrations/noctalia/adapter.js`, `bin/familiar-noctalia` | Native Noctalia DND/notification IPC adapter; preserve scheme-sync |
| `integrations/niri-desktop/{logic.js,shell.qml}` | Snapshot consumer and finite input/approval/done/error playback; no lifecycle inference |
| `integrations/noctalia-plugin/{plugin.toml,service.luau,widget.luau,panel.luau,presentation.luau}` | Native plugin, bounded file reads, workspace pills, explicit dismiss fallback and independent health indication |
| `test/helpers/attention.js` | Shared deterministic raw-registry traces for this feature's tests |
| `test/attention-*.test.js`, integration `*.test.mjs` | State, storage, CLI, coordinator, UI-contract and end-to-end regression coverage |
| `.github/workflows/test.yml`, `docs/attention.md`, `docs/install.md`, `docs/runbooks/desktop-attention-rollout.md` | Declare Lua test tooling, current reference behavior and gated activation/rollback |

### State contract

`AttentionState` is strict schema 1 with `revision`, `registry`, `nextEpisode`, `sources`, `episodes`, `turns`, `diagnostics`, and `desktop`. No transcript or native tool payload is stored. `registry` is the observed relay generation/revision; `revision` changes only for a changed attention/control state, not heartbeat refreshes.

- `sources[sourceKey]`: raw `agentId`, `rootKey`, harness, process/incarnation stamp, state, last observation/activity and processed event frontier. Keys combine registry generation, agent ID and process identity; absence/reappearance allocates a new local incarnation when no process identity is available. Do not infer independent worker liveness from the root handle.
- `episodes[id]`: source/root keys, kind (`needs-input`, `needs-approval`, `error`, `completion`), creation/order, `seen`, `dismissed`, source-closed status, and `delivery.popup`/`delivery.toast`. IDs are opaque strings allocated under the state lock, never filenames.
- Delivery status is `pending`, `eligible`, `reserved`, `delivered`, `failed`, `suppressed`, `interrupted` or `uncertain`; a reservation includes token and consumer-instance ID. Only current eligible IDs can be reserved. Terminal delivery outcomes never return to pending on reconnect.
- `turns[rootKey]` references the recorded completion episode ID and completion observation. Dispositions and delivery decisions have one owner in `episodes`, not duplicated copies. Keep the referenced episode after hiding/superseding its marker until new genuine root activity or teardown; preserve the same ID on the permitted late-input upgrade.
- `diagnostics[id]`: root incarnation, sorted blocking worker incarnation keys, latest suppression observation and dismissed flag. ID identity depends on the blocker set, not each root turn. This is distinct from request counts and never creates a toast.
- `desktop`: coordinator instance, known/unknown/disconnected state, DND (`on`, `off`, `unknown`), normalized workspaces/origins, optional identity/sprite enrichment and per-source motion policy. Its workspace list is the attention classification context; normal switcher rendering uses the independent topology contract below.
- `AttentionView` is the complete state plus a `health` field read independently from the health file. JSON null becomes an absent optional key in Luau; frontend validators accept that representation while rejecting unknown schema/invalid required fields.

`Health` is schema 1 with `instanceId`, `epoch:{bootId,desktopSession}`, coordinator owner `{pid,start}`, and `writtenAt` milliseconds. The live epoch is independent of saved attention: boot ID comes from the public relay process handle (Node) or `/proc/sys/kernel/random/boot_id` (Linux UI consumers), and desktopSession is the current nonempty `NIRI_SOCKET` value. Service launch must preserve that environment. Missing live identity is unknown, not a match to a saved null. The shared health rule is `healthStatus(health, {now,instanceId,bootId,desktopSession}) -> 'healthy'|'missing'|'stale'|'invalid'|'mismatched'`; each UI handles its initial 10000 ms missing-data grace separately. Compare the live epoch even if both saved state and heartbeat agree with one another, so old files cannot appear healthy after reboot/session replacement.

`src/attention/model.js` exports:

```js
initialAttention() // -> AttentionState
validateAttention(value) // -> AttentionState; throws named schema error
reduceAttention(state, input) // -> { state: AttentionState, result: object | null }
```

Inputs are an explicit tagged union: `observe` (raw snapshot, normalized envelope or null, now), `desktop` (validated attribution/DND/enrichment, optional explicit `seenIds`, now), `dismiss` (explicit IDs), `initialise-popup` (consumer ID, initial snapshot IDs), `claim` (surface, consumer ID, token), `finish` (surface, token, outcome), and `recover` (coordinator instance, explicit startup IDs). A deferred focus update uses `seenIds` to exclude episodes created after that visit; classification of a newly observed episode uses the latest focus as before. No arbitrary property patch operation exists.

Apply normalized lifecycle observations only when they advance that source's envelope registry frontier, using public relay `adapterFor`, then reconcile with the latest raw snapshot. Do not buffer waiting for missing global revisions. Newer current evidence wins over delayed envelopes; old generations and old source incarnations cannot reopen episodes. Reconciliation uses raw rows before familiar's fold and preserves passive-idle/completed-turn exceptions. Snapshot-only initial recovery restores current static attention and suppresses historical transient opportunities. Record a latest-observation frontier rather than claiming a complete native request journal.

`src/attention/store.js` exports:

```js
readAttention(paths) // -> Promise<AttentionState>; missing file is initial state, corrupt is an error
mutateAttention({ paths, lockWith }, fn) // fn(state) -> Promise<{state,result}>; locks once, validates, atomically writes only changes
readAttentionView({ paths, now, liveEpoch }) // -> Promise<AttentionView>; liveEpoch() returns {bootId,desktopSession}, default reads current identity; no presentation lock
```

`src/bus/paths.js` adds `attentionPath` (`attention.json`), `attentionHealthPath` (`attention-health.json`) and `attentionCoordinatorLockPath` (`attention-coordinator.lock`) under the existing configured state directory. Use `presentationLockPath` for episode/control writes; the coordinator singleton lock is separate and held for its lifetime. Heartbeat writes use `writeJsonAtomic` without either mutation lock. No default path is moved or pointed at a worktree.

### Workspace navigation contract (Task 4 and Task 6)

Noctalia plugins have no workspace API. The attention snapshot's `desktop.workspaces` is classification context; it is not the navigation widget's live topology authority. `niriWorkspacesPath(paths)` in `integrations/niri/topology.js` resolves `niri-workspaces.json` in the configured state directory, without putting compositor paths in core code. Only the singleton coordinator writes this file, independently of all episode/control locks and revisions.

`Topology` is schema 1: `instanceId`, `epoch:{bootId,desktopSession}`, `revision`, `writtenAt`, `connected`, and `workspaces`. All attention origin/workspace joins use the same ID normalization as this feed; indices are labels only. Each row has opaque decimal-string `id`, `idx`, optional `name`/`output`, `is_active`, `is_focused`, `is_urgent`, and `occupied`. Validate integral Niri IDs in `0..9007199254740991` before converting to decimal strings; reject unsafe numbers explicitly rather than round them into another target. The socket helper uses the same accepted range. This is an explicit adapter limit for future larger u64 IDs, not permission to use index/name as fallback.

- Seed from `WorkspacesChanged` in Niri's initial event stream; no separate startup workspaces round trip is required. Reduce `WorkspacesChanged`, `WorkspaceActivated`, `WorkspaceUrgencyChanged` and `WorkspaceActiveWindowChanged` directly. Activation changes only that output's active row and, when `focused:true`, the single globally focused row; occupancy follows non-null active-window ID. A workspace delta before a full snapshot or an unknown row reference invalidates topology and fails the stream for supervision to reacquire its initial state; never guess an index.
- Publish each changed topology immediately, bypassing the attention debounce, window queries, enrichment and presentation lock. One independent latest-value writer serializes atomic renames and never lets an older write replace newer state. Refresh `writtenAt` every 1000 ms even when quiet; these refreshes trigger neither episode projection nor delivery. On disconnect publish `connected:false` if possible, then exit for supervision. Missing/stale (>2000 ms), future-dated, malformed or epoch-mismatched topology is untrusted.
- The plugin reads topology every 50 ms, at most one read in flight. Budget accepted Niri workspace event to updated shared widget state at **100 ms** in the deterministic full-path test: each atomic publication at most 10 ms (up to one older in-flight write plus the latest value, 20 ms total), worst poll phase 50 ms, asynchronous read at most 10 ms and render invalidation at most 20 ms. Include the older in-flight freshness write and hold the presentation lock for 2000 ms in that test. These I/O/scheduling assumptions are explicit; they do not establish native latency. The gated native pilot must measure p95 <=100 ms and maximum <=200 ms over 100 switches before replacing the built-in widget.
- If topology is untrusted, immediately enter an explicitly indicated navigation fallback: `noctalia.runAsync({'niri','msg','-j','workspaces'}, callback, 2000)`, once every 250 ms start-to-start, never overlapping a query. This read-only query is independent of familiar and needs no new daemon. Validate output into the same row shape; derive epoch from the plugin's live environment. A later callback cannot overwrite a newer healthy feed, a changed runtime generation or a different socket epoch. Query results older than 2000 ms are not current.
- During fallback, fresh compositor rows retain labels, occupancy, native urgency, output scoping, active highlight and stable-ID navigation; show `Workspace feed reconnecting`. Hide familiar attribution/motion until both the matching coordinator attention/health and feed are trustworthy. The health indicator/notice still follows its own 10000 ms rule. If Niri also fails, show `Workspace navigation unavailable`; cached rows may remain as disabled, unhighlighted labels explicitly marked stale, never as live attribution. Test first startup with no files and a dead coordinator as well as recovery. A fallback query may trail changes by 250 ms plus IPC/render time; it is not represented as meeting the healthy 100 ms budget.
- Focus events only enqueue a seen mutation when a lock-free view read finds currently unseen, undismissed episode IDs on the newly focused workspace. Recheck those explicit IDs and their source incarnation under the lock; later episodes are not marked seen by an older visit. Repeated focus, no matching episodes and ordinary active-highlight changes take no presentation lock. Keep topology publication and reads running while an actual seen mutation waits.

User-click navigation is `familiar niri focus ID`, implemented in Task 4 and declared/adopted through `ops-f800b0` before adding the route. Reuse familiar's existing typed CLI parser/help/error machinery; no new portable `familiar attention` leaf or separate helper CLI is added. Validate one canonical decimal ID and connect to the current nonempty `NIRI_SOCKET` using `node:net`. First send `"Workspaces"\n` on that socket: a missing target fails before action; an already globally focused target returns without an action, avoiding ordinary auto-back-and-forth toggling. Otherwise send exactly `{"Action":{"FocusWorkspace":{"reference":{"Id":123}}}}\n` with the selected numeric ID. Accept only `{"Ok":"Handled"}` as action acknowledgment; a native `Err`, EOF, oversized (>65536 bytes per reply) or malformed reply fails explicitly. Bound the entire exchange to 2000 ms and close the socket in every exit path. Never issue index-based focus, switch monitors first, or retry another workspace after an error. Niri may acknowledge a no-op if the target disappears between its separate requests; acknowledgment is not a claim of confirmed focus. The widget updates highlight only from fresh compositor data, never optimistically from command success. Argument-vector dispatch and an unfocused-monitor fixture prove that two outputs both having workspace index 2 still target the clicked ID. No live focus action is part of planning.

### Consumer and delivery contract

- `familiar attention status`: complete `AttentionView` JSON, regardless of pretty/color globals; no side effects.
- `familiar attention dismiss ID...`: applies only those episode/diagnostic IDs and returns `{dismissedIds, missingIds}` JSON. Unknown/old IDs do not affect successors.
- `familiar attention popup`: one strict JSON request on stdin (maximum 65536 bytes) and one JSON reply. Requests are `{op:'initialise',consumerId,ids}`, `{op:'claim',consumerId}`, or `{op:'finish',consumerId,token,outcome}`. Allowed outcomes are `delivered`, `failed`, `suppressed`, `interrupted`. Consumer IDs/tokens are nonempty strings at most 128 characters; an initialise request contains at most 512 opaque IDs. Reject unknown keys/operations, invalid values and trailing extra input. Errors identify the field/limit without printing the request or credential-like supplied values. Use own-key membership for ID lookup; prototype property names are never live episodes.
- A popup claim reserves one currently eligible episode and returns `{token,job}` or `{token:null,job:null}`. `job` carries episode/root ID, logical kind, pose (`completion` maps to `done`; other kinds retain their state name), sprite/color/motion enrichment, origin label and seen-at-claim state. Resolve the pose for that episode's kind using its root's identity, never copy a possibly folded working/expired pose from current intent. Missing art produces a diagnosed unavailable popup outcome, while its pill/toast remain usable.
- The coordinator claims toast opportunities internally, coalescing currently eligible notices by workspace into a generic count summary per dispatch pass. A claim reserves all contributing IDs atomically before IPC; source closure/dismissal invalidates not-yet-started work.
- On coordinator startup, recover reservations from a previous instance as uncertain and suppress preexisting queued transient IDs. Initial popup attachment likewise suppresses the explicit initial IDs, in batches of at most 512; newer concurrent IDs survive. Wait for all initial batches to complete before making claims, so a large initial snapshot or a failed initialisation cannot replay old effects. No restart replays uncertain or historical effects.
- Niri focus/DND updates are store actions. Seen stops ongoing motion; initially seen input/approval/error can still have one finite arrival opportunity. QML must compare seen-at-claim with later seen state to avoid cancelling every initially focused arrival immediately.

No watch command or new transport server is needed: QML already supports rename-safe FileView, and the Noctalia service uses bounded `readFileAsync` polls. CLI dispatch stays in the `.js` implementation; `bin/familiar` remains unchanged.

## Execution setup (after plan approval)

- [ ] Re-enter the worktree skill and verify this is the retained locked `.worktrees/desktop-attention`, with dependencies hydrated and no user changes. Do not create a second tree or repoint shared launchers.
- [ ] Run `just test` before the first product-code change; record actual fast/slow test counts and failures on the task. A zero-selected run is not a baseline. If it fails, investigate the observed baseline before attributing it to this feature.
- [ ] Read the accepted spec, this plan, latest ledger and `planning-checks.json`. Verify persistent evidence against the task's recorded manifest hash before any resumed experiment.
- [ ] After recording user acceptance of this plan, unblock its seven implementation children and `ops-f800b0`; do not bypass the review blocks while this draft is under review.
- [ ] Run child tasks sequentially in this worktree, starting/arming each and closing it on its branch after its commit. Use `just test-fast` for RED/GREEN and before each code commit, plus `just check`; final full-suite routing follows the hooks/CI rule.
- [ ] Declare and provision the pinned Luau development runtime in Task 6 before its contract tests run. Lua 5.4 is not a substitute. The private planning probe is retained evidence, not an undeclared production dependency. No live desktop or paid native probe is authorized by this plan's approval.

### Task 1: Implement the portable attention state machine

**Files:** Create `src/attention/model.js`, `test/attention-model.test.js`, `test/helpers/attention.js`.

**Interfaces:** Consumes public relay raw registry/envelope fields and `adapterFor`; produces `initialAttention`, `validateAttention`, `reduceAttention` and the state contract above. The test helper `traceAttention()` exposes `observe(rows,event,revision)`, `desktop({focused,origins,dnd,now})`, `dismiss(ids)`, `restart()`, and a `state` getter; it wraps the production reducer, not a second implementation.

- [ ] **Step 1: Write source-isolation and turn-history tests.** Use raw Codex root/worker rows with distinct IDs and the same process handle; a Claude alias trace must intentionally share one ID. Include these named assertions:

```js
assert.equal(rootApproval.closed, false); // after identified worker working/done
assert.notEqual(rootApproval.id, workerApproval.id);
assert.equal(claudeAliasedApproval.closed, true); // explicit v1 limitation
assert.equal(afterPassiveIdle.turns[rootKey].episodeId, completedId);
assert.equal(afterFocusedThenIdleInput.episodes[completedId].delivery.toast.status, 'suppressed');
assert.equal(afterDismissThenIdleInput.episodes[completedId].dismissed, true);
```

Also test root/worker closure independently, root teardown, same-state duplicate aggregation, old frontier/generation/incarnation, process reuse, working→done→idle→idle, initially focused/no-marker completion, same-turn upgrade and a new-root-activity control. Assert no fabricated Codex input/error and OpenCode reply/idle reductions using the public adapter.

- [ ] **Step 2: Write disposition, suppression and reservation tests.** Assert stale dismissal affects zero successor IDs; missing worker Stop produces a static diagnostic on repeated completions with stable blocker-set ID; dismissing it never unlocks completion; changed blocker sets survive old clicks; blocker removal never replays completion. For Claude/Codex approval followed by ten minutes with no observation, retain the unconfirmed episode without guessed expiry and stop motion when seen; source progress closes it, while dismissal only hides its attention. Cover unknown/on DND dropping queued effects through restart and recovery, all-harness approval wording inputs, and reservation-before-send transitions without automatic retry.
- [ ] **Step 3: Run `just test-fast`; confirm the named new tests fail for the missing reducer, not an invalid fixture or leaked environment.**
- [ ] **Step 4: Implement the three model exports.** Keep visual intent expiry out of lifecycle closure. Preserve only referenced completed-turn/dismissal history; prune history after its source incarnation ends. Leave request-level multiplicity explicitly aggregate where native IDs do not exist.
- [ ] **Step 5: Run `just test-fast` and `just check`; require all new assertions and existing tests green, then commit `feat: track independent desktop attention episodes`.**

### Task 2: Persist attention independently of visual projection

**Files:** Create `src/attention/store.js`, `test/attention-store.test.js`; modify `src/bus/paths.js`, `src/observe/run.js`, `test/paths.test.js`, `test/observe-run.test.js`, `test/fixtures/observe-event.mjs`.

**Interfaces:** Consumes Task 1; produces the store exports above. Add `captureAttention({paths,envelope,relay,adapterFor,now,lockWith}) -> Promise<AttentionState>` in `src/observe/run.js`; call it before terminal/theme enrichment can return or throw. Reconcile captures attention before visual context loading too. The existing pet projection retains its behavior and fold; new attention never reads folded intent as lifecycle truth.

- [ ] **Step 1: Write tests that a root request persists despite a thrown theme load, missing sprite, enrichment failure or terminal emission failure.** Assert:

```js
assert.equal(saved.episodes[approvalId].kind, 'needs-approval');
assert.equal(saved.sources[rootKey].state, 'needs-approval');
assert.deepEqual(previousBytes, bytesAfterRejectedCorruptMutation);
assert.equal(heartbeatWriteTookPresentationLock, false);
```

Add competing dismiss/capture/reservation mutations, corrupt/truncated JSON (never overwrite it), atomic rename reads, missing first-run state, registry reset and idempotent reconcile. Fixtures that run git must verify both repository paths and isolate all inherited Git configuration/variables.

- [ ] **Step 2: Run `just test-fast` and observe the new capture/storage failures.**
- [ ] **Step 3: Implement strict reads and `mutateAttention`.** Use the existing lock once per transaction and `writeJsonAtomic`; do not nest the presentation lock. Read the raw relay snapshot inside capture's mutation and apply the model. Capture must perform no compositor or notification calls. Record capture errors as named observer diagnostics without clearing saved attention; existing visual diagnostics remain visible.
- [ ] **Step 4: Implement health-aware view reads.** A mismatched boot/instance, future timestamp or age over 10000 ms is unhealthy; absent health has the startup grace defined by the consumer, never fabricated healthy state. Health reads/writes cannot change episode revision or trigger projection.
- [ ] **Step 5: Run `just test-fast` and `just check`, verify the observer fixtures emit no desktop effects, then commit `feat: persist attention before visual projection`.**

### Task 3: Expose the minimal attention control interface

**Files:** Create `src/attention/commands.js`, `test/attention-cli.test.js`; modify `src/commands.js`, `bin/familiar.js`, `test/cli-help.test.js`, `test/cli-surface.test.js`, `tools/cli.toml` via adoption only.

**Interfaces:** Consumes Task 2 and `ops-f800b0`; produces the three CLI leaves defined above. Export `runAttentionCommand(command, argv, {paths,stdin,stdout,now,lockWith}) -> Promise<void>` from `src/attention/commands.js`; route the existing CLI to it without changing `bin/familiar` or adding unrelated options.

- [ ] **Step 1: Complete/adopt the reviewed shared CLI declaration from `ops-f800b0` using `vendored adopt`; do not hand-copy table entries.**
- [ ] **Step 2: Write subprocess tests with explicit fixture environments.** Verify help/completion, whole-snapshot JSON, variadic captured-ID dismissal and strict stdin request validation. Include:

```js
assert.deepEqual(reply.dismissedIds, [clickedEpisodeId]);
assert.equal(nextRequest.dismissed, false);
assert.equal(firstClaim.token === null, false);
assert.equal(secondClaim.job, null); // a competing renderer cannot claim it again
assert.match(invalid.stderr, /attention.*unknown operation/);
```

Use paths/IDs containing spaces, quotes and shell metacharacters; they must remain values, not shell commands. Reject malformed schema, oversize input, unknown prototype-property IDs and extra stdin content without mutation or raw-input echoes. Test popup initialise against IDs arriving concurrently and old consumer/token completion.

- [ ] **Step 3: Run `just test-fast` and confirm the new command tests fail.**
- [ ] **Step 4: Implement dispatch/help/protocol and store actions.** Use argument vectors; status is read-only. Popup claim checks current episode, DND and health at the locked decision boundary and returns no job when unavailable. No flag, wrapper or generic state-patch interface is added.
- [ ] **Step 5: Run `just test-fast` and `just check`, verify shared CLI conformance, then commit `feat: expose desktop attention controls`.**

### Task 4: Coordinate Niri attribution, notification delivery and health

**Files:** Create `integrations/niri/attention.js`, `integrations/niri/topology.js`, `integrations/niri/ipc.js`, `integrations/niri/coordinator.js`, `integrations/noctalia/adapter.js`, `test/attention-desktop.test.js`, `test/niri-topology.test.js`, `test/niri-ipc.test.js`, `test/attention-coordinator.test.js`, `test/noctalia-adapter.test.js`; modify `bin/familiar-niri`, `bin/familiar-noctalia`, `test/bin-familiar-niri.test.js`, `test/bin-familiar-noctalia.test.js`, `src/commands.js`, `bin/familiar.js` and `test/cli-surface.test.js`; adopt `tools/cli.toml` from ops for the `niri` group and `niri focus` leaf.

**Interfaces:** Consumes Tasks 1–3 and existing `mapSessionsToWindows`, signal planning and process helpers. Produce:

```js
resolvePresentations({state,intent,loadContext}) // -> Promise<{presentations,diagnostics}> keyed by episode ID
projectDesktop({state,windows,workspaces,presentations,dnd,instanceId,now,ancestors}) // -> desktop input
niriWorkspacesPath(paths) // -> topology file path; lives in integrations/niri/topology.js
reduceTopology(topologyOrNull,event,{now,instanceId,epoch}) // -> validated Topology; pure
focusWorkspace(id,{socketPath,connect,timeoutMs:2000}) // -> Promise<void>; node:net protocol above
readDnd({execFile,timeoutMs:2000}) // -> Promise<'on'|'off'>; throws on invalid/unavailable
sendToast({payload,execFile,timeoutMs:2000}) // -> Promise<void>; exact argv, normal/low only
runCoordinator({paths,relay,execFile,watch,clock,signals,writeAtomic,stderr}) // -> Promise<void>, lifetime ends after cleanup
```

Default the integration's dependencies at its composition root, not in pure policy functions. `bin/familiar-niri sync` performs one coordinated resync; `watch` is the singleton long-running route. `familiar niri focus ID` dispatches from `bin/familiar.js` directly to the integration's `focusWorkspace`, is a bounded user-click action and takes no attention lock. Preserve existing material signals and the existing window-map output for current consumers; never use its folded state for new attention decisions. `familiar-noctalia scheme-sync` remains behaviorally unchanged.
`clock` supplies `now`, `setInterval`, `clearInterval`, `setTimeout` and `clearTimeout`; `signals` has Node process-style `on`/`off` for TERM/INT. `writeAtomic` defaults at the composition root to the existing `writeJsonAtomic`; tests can wrap that real writer with a bounded fake-clock delay. Tests inject these without real waits or host signals.

- [ ] **Step 1: Write pure attribution tests for moving/renumbering workspaces, two monitors, headless sessions, source teardown and output changes.** Assert exactly the originating stable workspace ID is marked; visible-but-unfocused is unseen; moving a source onto the focused workspace marks it seen; no mapping means no guessed pill. Unmapped requests allow generic notices, while an unmapped completion sends no toast and becomes only a static marker on later unfocused mapping, without replaying transients. Verify completion/error/approval/input priority and episode counts. A suppression diagnostic remains visible beside a higher-priority request, including focused and unmapped cases. Test a worker approval while root intent shows working, and an unseen error after art expiry: both use the episode-specific pose and root identity, not the current folded/expired pose.
- [ ] **Step 2: Write fake-IPC/watch/clock tests for runtime coordination.** Assert:

```js
assert.deepEqual(notifyArgv.slice(0, 2), ['msg', 'notification-show']);
assert.equal(JSON.parse(notifyArgv[2]).app_name, 'familiar');
assert.equal(reservationWasPersistedBeforeExec, true);
assert.equal(afterUnknownThenOff.toastSends, 0);
assert.equal(afterRestartUncertain.toastSends, 0);
assert.equal(healthyQuietHeartbeatAgeMs <= 2000, true);
assert.equal(secondCoordinatorStarted, false);
assert.equal(topologyWrittenWhilePresentationLockHeld, true);
assert.equal(lockAcquisitionsFor100FocusChangesWithoutUnseenEpisodes, 0);
assert.equal(lockAcquisitionsForOneSeenTransitionThenRepeatedFocus, 1);
assert.equal(eventToTopologyPublishMs <= 20, true);
assert.deepEqual(socketRequest, {Action:{FocusWorkspace:{reference:{Id:outputBWorkspaceId}}}});
```

Cover every invalid DND response, send timeout/failure, an event resolving/dismissed between reads and claim, batch summary IDs, compositor disconnect/reconnect, startup queues, file rename bursts and no-change focus events. Hold the presentation lock for 2000 ms while heartbeat/topology continue; wrap the real atomic writer with the explicit 10 ms delay and include one older in-flight freshness write in the 20 ms publication assertion. Task 6 adds the full 100 ms end-to-end budget once its plugin exists; Task 4 must not depend on later plugin files or Luau tooling. Verify stale/out-of-order topology publications never regress focus. Future-time/boot/instance mismatch is unhealthy. Health/topology filenames are ignored by the attention resync watcher.

Use a fake Unix socket server in a test-owned directory to check the Workspaces preflight, exact newline framing, partial replies, native Err, EOF, timeout, bad IDs and cleanup. Both fake outputs have index 2, the first is focused, and the captured click targets the second output's ID. Assert exactly one ID action and no monitor/index action. A missing target or already focused target sends no action; a target removed after preflight may get Handled without confirmed focus, but never an index fallback or optimistic highlight. These tests never connect to the inherited host socket.

- [ ] **Step 3: Run `just test-fast`; confirm these tests fail before wiring side effects.**
- [ ] **Step 4: Implement adapter, socket action and pure desktop/topology projection.** Use validated event-stream workspace state and query windows outside the state lock only when the existing attribution path needs them. Implement the explicit focus socket protocol above. Use raw source/root process handles for the existing ancestry join. `resolvePresentations` reuses the existing context loader and public familiar-theme `assetsFor` for the episode-specific pose; use root intent for identity/color, not pose truth. Cache a successfully loaded context for one resync only; changes/repairs are picked up on the next resync. Missing identity/art exposes neutral styling and a named visual diagnostic without preventing attribution, lifecycle capture or text toasts. It must not silently select a different state image.
- [ ] **Step 5: Implement the coordinator's independent topology and attention paths over its existing Niri event stream.** Acquire the independent singleton lock; maintain separate 1000 ms topology freshness and 2000 ms heartbeat timers. Topology publication bypasses the existing 100 ms attention coalescing and all visual/notification work, following the navigation contract above. For focus-only events, preflight unseen IDs without a lock, skip mutation when none qualify, and recheck explicit candidates under the lock; ordinary highlight changes must not rewrite the attention snapshot. Serialize genuine attribution/DND/reservation changes under short state mutations, then await IPC outside the lock. On stream close publish disconnected topology if possible, stop children/watchers/timers and exit nonzero for supervision. On TERM/INT reap the event-stream child. Publish bounded failures without preventing healthy-surface delivery.
- [ ] **Step 6: Run `just test-fast` and `just check`; prove tests used only fake IPC/fixture state, then commit `feat: coordinate Niri attention delivery and health`.**

### Task 5: Drive familiar moments from shared episodes

**Files:** Modify `integrations/niri-desktop/logic.js`, `integrations/niri-desktop/logic.test.mjs`, `integrations/niri-desktop/shell.qml`.

**Interfaces:** Consumes the state/view schema and popup control protocol. Replace `parseIntent`/state-transition observation with `parseAttention(text) -> {snapshot,error}`, `nextMoment(snapshot, activeJob) -> {action,episodeId}` and the common `healthStatus` signature above. Keep the QML-safe JavaScript file loaded by the existing vm test pattern. QML uses FileView for atomically replaced state/health files, reads the live Linux boot ID separately, and uses Process stdin/stdout for serialized control requests.

- [ ] **Step 1: Replace the old independent transition-detector tests with shared-opportunity tests.** Test initial attachment suppression, subsequent eligible input/approval/error/completion, initially seen finite arrivals, later seen cancellation, explicit dismissal/closure, DND unknown/on and unhealthy coordinator. Include:

```js
assert.equal(firstSnapshot.action, 'initialise');
assert.equal(lateSameTurnInput.action, 'none');
assert.equal(oldTokenFinishChangedCurrentJob, false);
assert.equal(errorPreemptsCompletion.action, 'preempt');
assert.equal(offPolicyDrawsPopup, false);
```

Test queued lower-priority episodes remain in state when an error interrupts playback. Preserve reduced/off behavior, render-watchdog cleanup and no popup on a worker's done or an ordinary source reconcile.

- [ ] **Step 2: Run `just test-fast` and confirm the old detector fails the new contract.**
- [ ] **Step 3: Implement snapshot validation/claim scheduling and remove the old folded-intent observation path completely.** Add finite input/approval peeks with existing state art; retain done/error choreography. Claim before mapping; finish with the actual outcome and token. Missing art is a failed popup outcome with a diagnostic, never a synthesized request closure. A new error may preempt a lower-priority visual; other eligible episodes stay queued. State/health changes cancel obsolete motion without inventing new delivery.
- [ ] **Step 4: Keep the overlay on the user's focused output and preserve namespace, no keyboard focus, click-through mask, frame readiness and watchdog cleanup.** For each control Process, enable stdin before starting, write one JSON request in `onStarted`, then close stdin by setting `stdinEnabled` false so the EOF-reading CLI can finish. Collect both outputs, enforce a 2000 ms control timeout, and wait for exit before starting the next queued request. Quickshell owns/kills its children; never detach them. Test this wiring headlessly through stubs; postpone real desktop effects to approved activation.
- [ ] **Step 5: Run `just test-fast` and `just check`, then commit `feat: render familiar moments from shared attention`.**

### Task 6: Build the native Noctalia workspace consumer

**Files:** Create `integrations/noctalia-plugin/plugin.toml`, `service.luau`, `presentation.luau`, `widget.luau`, `panel.luau`, `contract.test.mjs`; create `test/fixtures/noctalia-host.luau`, `test/helpers/luau.mjs`; modify `.github/workflows/test.yml` for pinned Luau development tooling.

**Interfaces:** Plugin ID `khughitt/familiar`, API 34, dependency `familiar`; widget entry `workspaces`, panel entry `alerts`, service entry `attention`. No configurable command strings or global shortcuts. `presentation.luau` exports `validateView(view)`, `validateTopology(topology)`, `pillsFor(view,topology,outputName)`, `dismissIds(pill)`, `animationFor(pill,now,policy)` and the common `healthStatus` signature above. Execute every production module/entry in **Luau**, including service, widget and panel callbacks. There is no Lua-compatible subset restriction and no Lua 5.4 substitute.

- [ ] **Step 1: Provision Luau 0.743 locally and in both Linux/macOS test jobs, before the new contract tests run.** Download the official release archive below, verify its SHA-256 before extraction, and put `luau` under `node_modules/.cache/familiar-luau/0.743/` with executable permission. The test helper runs that explicit path; it never downloads during tests, substitutes `lua`, or silently skips. Document this reproducible development setup. No npm/production dependency or host-wide installation is added, and existing smoke expectations remain intact.

| Host | Official release archive | SHA-256 |
| --- | --- | --- |
| Linux x86_64 | [luau-ubuntu.zip](https://github.com/luau-lang/luau/releases/download/0.743/luau-ubuntu.zip) | `99d45afb4afaee00ba631c526c8e8c76c67b60f6f119953ce6409be6d6953663` |
| macOS arm64 | [luau-macos.zip](https://github.com/luau-lang/luau/releases/download/0.743/luau-macos.zip) | `4334afbfb0c05ee697c9bfea64a85f950249c1e8f6f7d99aaa5a24ee362b09c3` |

Both archives were downloaded and verified against the [0.743 release metadata](https://github.com/luau-lang/luau/releases/tag/0.743). The macOS binary's arm64 header was checked against the [current macos-14 runner architecture](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); do not assume that archive is universal. Reject an unmatched development-host architecture with an explicit setup error rather than run the wrong binary. This is a real Luau language/number runtime; mocked host contracts still do not establish full parity with Noctalia's embedded host or native renderer.

- [ ] **Step 2: Write the contract tests through the existing suite inventory.** `test/helpers/luau.mjs` assembles a test-owned Luau chunk from the unmodified bytes of all four production entry/module files. Use isolated `setfenv` environments with mock `noctalia`/`ui` and a relative `.luau` module cache matching the pinned host's require contract; capture actual global entry callbacks. Node supplies fixtures from actual `attention status` JSON plus actual topology bytes as Luau literals, omitting null keys exactly as the host does. Mock decoding/IO only; do not transpile the production language or implement its presentation in JS. Luau's sandbox has no `io`/`loadfile`, so do not design the harness around Lua filesystem calls. Capture constructed UI trees and execute real service/widget/panel callbacks in `noctalia-host.luau`. Assert:

```js
assert.equal(pillsForOutputB.some(p => p.workspaceId === outputAWorkspace), false);
assert.deepEqual(rightClick.argv, ['familiar', 'attention', 'dismiss', capturedId]);
assert.equal(newConcurrentIdWasDismissed, false);
assert.equal(panelDismissWorksWithRightClickIntercepted, true);
assert.equal(view.approvalLabel, 'Approval requested — response unconfirmed');
assert.equal(healthToastsDuringOneDisconnectedMinute, 1);
assert.deepEqual(leftClick.argv, ['familiar', 'niri', 'focus', outputBWorkspaceIdString]);
assert.equal(activeHighlightStillUpdatesWithCoordinatorDead, true);
assert.equal(healthyEventToWidgetStateMs <= 100, true);
assert.equal(sustainedPulseIntervalMs, 200);
assert.equal(widgetTicksDuringOneStaticHour, 1800);
```

Add health grace/stale/recovery/boot/future-time cases, no-data versus disconnected, invalid schema, pending requests plus suppression diagnostic, native urgency separation, root/worker tooltip labeling, both bar orientations, empty/occupied/focused states, count/tie rules, stable IDs after moves and stale click callbacks. Assert dismissal leaves native urgency and relay requests unchanged. Exercise loss of the coordinator, topology feed and Niri independently; fallback startup without any familiar files; fallback replies arriving after recovery; unsafe numeric IDs; and output B navigation while A is focused. Add the full 100 ms fake-clock path from Task 4's real writer with bounded delays, through worst-phase file polling, production service callbacks and widget invalidation; a reducer-only timing test is insufficient. For an unseen request left overnight, advance a fake clock by eight hours: after its finite arrival, at most five scheduled widget updates per second (144000 over eight hours), never 16 ms pulsing. Test finite arrival <=350 ms, 4000 ms pulse, reduced/off and DND stopping motion; event-driven invalidations are counted separately.
- [ ] **Step 3: Run `just test-fast`; a missing pinned Luau executable must fail with the exact development-prerequisite path/setup hint, never silently skip contract coverage.** Confirm functional assertions fail before implementation.
- [ ] **Step 4: Implement independent navigation and bounded attention reads.** Resolve `FAMILIAR_STATE_DIR` when set, otherwise `$HOME/.local/state/familiar`, matching core's default; reject empty/relative overrides with a diagnostic rather than resolving against a different plugin working directory. Do not infer XDG_STATE_HOME behavior that core does not implement. Read the live boot ID once per service runtime and capture its current `NIRI_SOCKET`; never trust only saved identities. Set the service interval to 50 ms for topology reads; state/health reads remain every 250 ms. Allow at most one asynchronous read per file (three outstanding in steady state, within Noctalia's four-read runtime bound); never overlap reads or start Node subprocesses for polling. Compare bytes/revision and invalidate widgets only when rendered data changes, not on freshness-only writes. Follow the exact fallback/query validation contract above when topology becomes untrusted. A hung/failed attention read must not block topology/fallback. Runtime teardown owns callbacks, and late callbacks from old generations are ignored.
- [ ] **Step 5: Implement pills and panel from Noctalia's own palette and the supplied identity accent.** Per-pill left click dispatches `{'familiar','niri','focus',capturedWorkspaceId}` through `noctalia.runAsync(argv,callback,2000)` and diagnoses a failed action without trying an index; plain right-click dismisses the captured IDs. Keep middle-click settings. Add an explicit left-click Alerts button opening the plugin panel, whose per-workspace dismiss buttons are the fallback if configured right-click interception occurs. Do not use unsupported modifier gestures. Include the specified uncertainty/Claude attribution tooltip and independent suppression status glyph. Use distinct input/approval/error/completion glyph/outline treatments without hue-as-severity substitution.
- [ ] **Step 6: Implement three bounded widget cadences.** Use 16 ms updates only for the finite 200–350 ms arrival, then 200 ms during the low-amplitude 4000 ms pulse until seen; when static use 2000 ms plus changed shared-state invalidation. The 50 ms service I/O poll does not force widget redraws. On seen, dismissal, resolution, DND, reduced/off or disconnect, select the appropriate slower/static cadence immediately. The overnight fake-clock test must bound the sustained rate, not merely test a single interval value.
- [ ] **Step 7: Implement independent DND-gated health notices.** The service keeps its persistent disconnected indication after the 10000 ms health grace/staleness rule while normal navigation follows the separate topology/fallback state. Before each otherwise eligible health notice, reserve the 60000 ms throttle slot and query `noctalia.runAsync({'noctalia','msg','notification-dnd-status'}, callback,2000)` itself. Only an exit-0, nontruncated exact `off` permits `noctalia.notify`; exact `on`, invalid/failed/timed-out output or a launch refusal drops that opportunity, with no retry/backlog on DND recovery. Recheck the captured failure-generation token before notifying so a reply after recovery cannot produce a stale health toast. Test off/on/unknown plus an old off reply after healthy recovery. This does not depend on a dead coordinator's cached DND or on an unverified promise that `noctalia.notify` enforces DND. A live DND change after the check remains the external-send race already accepted for notices. No widget can emit a notice while Noctalia itself is down.
- [ ] **Step 8: Run `just test-fast`, `just check`, and `noctalia plugins lint integrations/noctalia-plugin`; validate manifest/API bounds and actual CLI-to-Luau contract, then commit `feat: add Noctalia attention workspace indicators`.** The headless callback probe is not a substitute for the approved native gesture/latency pilot.

### Task 7: Verify the complete pipeline and prepare gated rollout

**Files:** Create `test/attention-e2e.slow.test.js`, `docs/attention.md`, `docs/runbooks/desktop-attention-rollout.md`; modify `docs/install.md`, `README.md` and task notes as results warrant. No owner project's live configuration changes are made in this task.

**Interfaces:** Consumes Tasks 1–6 and owner tasks `hq-4c954d`, `hq-d6e13a`, `dots-dfecf1`. Produces an isolated end-to-end verdict and a concrete activation/rollback runbook; code readiness is distinct from desktop rollout acceptance.

- [ ] **Step 1: Write an end-to-end fixture using public relay `applyEvent`/`readSnapshot`, real familiar observer/CLI, fake Niri/Noctalia executables, the production QML logic and production Luau presentation.** Build subprocess environments key by key from test-owned paths and fake values. Include one event per actual harness capability rather than synthesizing unsupported Codex input/error. Assert one origin marker, one allowed popup opportunity and one toast reservation; repeat/rename/reconcile/restart does not duplicate them.
- [ ] **Step 2: Cover cross-boundary failures.** Inject corrupt state, visual failure, process/source reuse, registry replacement, old callbacks, unknown DND, missing worker Stop, coordinator death and crash after reservation. Verify pending state/turn history, static diagnosis, no replay, and independent healthy-surface behavior. Record that extracted/native callback and mocked UI checks do not prove Wayland layout/gesture behavior.
- [ ] **Step 3: Run `just test` when required for the affected slow pipeline and record actual counts/results.** Run `just check` and `tasks check`; resolve errors and report every warning. Confirm no test process or host pointer survives. Do not claim live notification or native scheduling acceptance from the fixture.
- [ ] **Step 4: Write current reference docs and the exact runbook.** Reuse dotfiles' existing local-plugin installation route: link the integration under its XDG data plugin directory, then explicitly enable `khughitt/familiar`. Replace built-in `workspaces` with `khughitt/familiar:workspaces`, preserve per-output behavior, and use one supervised `familiar-niri watch` transient user service with restart-on-failure. Preserve popup startup. Name status/journal/stop commands and all preimage/restore commands; capture actual command resolution before routing any live state to another project's tool.
- [ ] **Step 5: Prepare the one-host/one-profile native pilot.** List `hq-4c954d` evidence and disposition of the round-7 deferred minor, verified suppression preserving relay hooks from `hq-d6e13a`, the dotfiles reviewable changes, and a bounded headless gesture/visual run as mandatory prerequisites before requesting the live desktop. Test one input/approval/error/completion case per supported harness mapping, seen/dismissal, normal/live versus missing worker, DND, kill/freeze/restart and at least two outputs where available. Task 7 records still-pending prerequisites with their owner IDs; it does not fabricate native verdicts or close those owner tasks. Do not launch paid native probes or take the desktop without the relevant approval.
- [ ] **Step 6: Treat integration through live pointers as activation.** Existing hooks and QML source pointers can resolve into main, so do not merge code/config through them merely because the profile permits ordinary local merges. Present the completed code, native-setting diffs, bar/startup changes and rollback as the concrete approval artifact. Check `systemctl --user` readiness; launch nothing on failure and use no nohup fallback. An activation service must be named with PID/unit, readiness verdict, logs and stop command in its final report.
- [ ] **Step 7: Run the independent whole-branch implementation review and corrective rounds, then close code steps before integration.** Keep the round-7 minor labelled `minor (deferred)` until an explicit later ruling addresses it. `fam-9c8dd1` may report implementation ready, while the ops goal stays open through native activation/acceptance and rollback verification. Commit the tests/docs as `test: verify desktop attention pipeline and rollout`. Pushes and live activation remain separately gated.

## Plan self-review and handoff

- [x] Verify every accepted spec section against Tasks 1–7, including aggregate limits, completed-turn tombstones, independent health, diagnostic dismissal and native-toast deduplication.
- [x] Check input/field/signature consistency across the reducer, store, CLI, coordinator, QML and Luau; remove unused interfaces. No watch command, state-patch API, new settings menu or speculative option is included.
- [x] Confirm all five Review Focus items have named regression coverage, all subprocess fixtures have explicit environments, and native checks retain their real evidence limits.
- [ ] **User review gate:** review the frozen plan commit/path supplied in the handoff. The author self-review is recorded separately and the round-7 minor remains deferred. Do not start product code until this plan review accepts it.
