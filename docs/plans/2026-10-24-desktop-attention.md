# Desktop Attention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Inline execution is the recommended default because these tasks share one state contract; retain the independent final whole-branch review and corrective rounds required by the repository instructions.

**Goal:** Make familiar's popup, Noctalia workspace markers and desktop toasts consume the same durable attention episodes without inventing harness lifecycle evidence.

**Architecture:** A portable reducer records raw relay sources independently of the existing pet-state fold. One atomically written attention snapshot owns episodes, completed-turn history, dispositions and delivery reservations; the Niri coordinator supplies desktop attribution and delivery policy. QML and a native Noctalia plugin consume this snapshot, while a separate lock-free heartbeat exposes coordinator failure.

**Tech Stack:** Node.js 22+, existing relay v0.1.1 public exports, existing atomic-write/lock helpers, Niri IPC, Quickshell/QML and Noctalia 5.3 Luau API 34. Lua is a development-only contract-test executable; no new npm or production service dependency.

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
- Pill arrival 200–350 ms; sustained low-amplitude pulse approximately 4000 ms. Reduced/off use static distinctions; no continuous high-frequency updates while static.
- Generic notification content only: no prompts, tool arguments, transcript prose, commands or approval contents in toast history or fixtures.
- Preserve the launchers' dependency boundary and familiar-theme package exports. Do not change relay or add compatibility layers.
- All new subprocess fixtures build environments key by key before RED, with temporary HOME, fake credentials, and isolated git configuration where git is used.
- Use the existing test front door. This checkout has no `test-one` or documented focused route: each RED/GREEN and pre-commit check uses `just test-fast`; do not call Node's test runner directly or add a recipe to fill the gap.

## Review Focus

1. Delayed old events, registry replacement or PID reuse must not reopen a dismissed successor request: Task 1 and Task 2 tests.
2. A source moves, disappears or changes output between display and click: Task 4 attribution and Task 6 captured-ID tests.
3. A crash between reservation and display, or between independent file renames, must not duplicate notices or destroy pending state: Task 2, Task 4 and Task 5 tests.
4. Lua drops JSON null keys and callbacks retain an old render's IDs: Task 6 uses the real CLI view, not a hand-maintained idealized fixture.
5. Coordinator death, presentation-lock contention, unknown DND and a quiet session must remain distinguishable without replaying a queue: Task 4 and Task 6 watchdog tests.

## Planning checks and remaining validation

The sanitized `planning-checks.json` attachment on `fam-9c8dd1` records the checks already performed. Persistent reproducer/source copies and their manifest are noted on the task, off the synced checkout.

| Check | Observed result | Limit and disposition |
| --- | --- | --- |
| Codex parent/worker timelines, 2026-10-23/24 | 122 rollout files, 51 parent/worker pairs; no root completion inside an active worker turn found | Lifecycle records were verified nonempty; this bounded sample is not proof that overlap is impossible. Spec round 7 minor remains deferred. |
| Claude parallel permission waits | Thirty recent sessions had 544 bypassPermissions records and no explicit permission-wait boundaries | Inconclusive; cannot establish runtime scheduling during a permission wait. The attribution limitation stays accepted regardless. |
| Noctalia 5.3 click routing | Two headless self-checks passed using exact callback bodies from pinned `plugin_widget.cpp` and `ui_tree_reconciler.cpp` | Proves callback registration/dispatch only, not Wayland hit testing or configured action interception. Native runtime gesture acceptance remains Task 6/rollout validation. |
| Modifier fallback | Pinned native gesture test explicitly rejects modifier chords | Do not choose modifier-plus-click. Use the explicit left-click Alerts panel fallback. |
| Niri focused field | Read-only installed workspace query returned boolean `is_focused` for every workspace and exactly one true | Does not test every multi-monitor transition; fixtures and the eventual desktop pilot still do. |

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
- `desktop`: coordinator instance, known/unknown/disconnected state, DND (`on`, `off`, `unknown`), normalized workspaces/origins, optional identity/sprite enrichment and per-source motion policy. Keep the full workspace list, including workspaces without requests, for normal switcher behavior.
- `AttentionView` is the complete state plus a `health` field read independently from the health file. JSON null becomes an absent optional key in Luau; frontend validators accept that representation while rejecting unknown schema/invalid required fields.

`Health` is schema 1 with `instanceId`, `epoch:{bootId,desktopSession}`, coordinator owner `{pid,start}`, and `writtenAt` milliseconds. The live epoch is independent of saved attention: boot ID comes from the public relay process handle (Node) or `/proc/sys/kernel/random/boot_id` (Linux UI consumers), and desktopSession is the current nonempty `NIRI_SOCKET` value. Service launch must preserve that environment. Missing live identity is unknown, not a match to a saved null. The shared health rule is `healthStatus(health, {now,instanceId,bootId,desktopSession}) -> 'healthy'|'missing'|'stale'|'invalid'|'mismatched'`; each UI handles its initial 10000 ms missing-data grace separately. Compare the live epoch even if both saved state and heartbeat agree with one another, so old files cannot appear healthy after reboot/session replacement.

`src/attention/model.js` exports:

```js
initialAttention() // -> AttentionState
validateAttention(value) // -> AttentionState; throws named schema error
reduceAttention(state, input) // -> { state: AttentionState, result: object | null }
```

Inputs are an explicit tagged union: `observe` (raw snapshot, normalized envelope or null, now), `desktop` (validated attribution/DND/enrichment, now), `dismiss` (explicit IDs), `initialise-popup` (consumer ID, initial snapshot IDs), `claim` (surface, consumer ID, token), `finish` (surface, token, outcome), and `recover` (coordinator instance, explicit startup IDs). No arbitrary property patch operation exists.

Apply normalized lifecycle observations only when they advance that source's envelope registry frontier, using public relay `adapterFor`, then reconcile with the latest raw snapshot. Do not buffer waiting for missing global revisions. Newer current evidence wins over delayed envelopes; old generations and old source incarnations cannot reopen episodes. Reconciliation uses raw rows before familiar's fold and preserves passive-idle/completed-turn exceptions. Snapshot-only initial recovery restores current static attention and suppresses historical transient opportunities. Record a latest-observation frontier rather than claiming a complete native request journal.

`src/attention/store.js` exports:

```js
readAttention(paths) // -> Promise<AttentionState>; missing file is initial state, corrupt is an error
mutateAttention({ paths, lockWith }, fn) // fn(state) -> Promise<{state,result}>; locks once, validates, atomically writes only changes
readAttentionView({ paths, now, liveEpoch }) // -> Promise<AttentionView>; liveEpoch() returns {bootId,desktopSession}, default reads current identity; no presentation lock
```

`src/bus/paths.js` adds `attentionPath` (`attention.json`), `attentionHealthPath` (`attention-health.json`) and `attentionCoordinatorLockPath` (`attention-coordinator.lock`) under the existing configured state directory. Use `presentationLockPath` for episode/control writes; the coordinator singleton lock is separate and held for its lifetime. Heartbeat writes use `writeJsonAtomic` without either mutation lock. No default path is moved or pointed at a worktree.

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
- [ ] Declare Lua development tooling in Task 6 before its contract tests run; this host already has `lua`. No live desktop or paid native probe is authorized by this plan's approval.

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

**Files:** Create `integrations/niri/attention.js`, `integrations/niri/coordinator.js`, `integrations/noctalia/adapter.js`, `test/attention-desktop.test.js`, `test/attention-coordinator.test.js`, `test/noctalia-adapter.test.js`; modify `bin/familiar-niri`, `bin/familiar-noctalia`, `test/bin-familiar-niri.test.js`, `test/bin-familiar-noctalia.test.js`.

**Interfaces:** Consumes Tasks 1–3 and existing `mapSessionsToWindows`, signal planning and process helpers. Produce:

```js
resolvePresentations({state,intent,loadContext}) // -> Promise<{presentations,diagnostics}> keyed by episode ID
projectDesktop({state,windows,workspaces,presentations,dnd,instanceId,now,ancestors}) // -> desktop input
readDnd({execFile,timeoutMs:2000}) // -> Promise<'on'|'off'>; throws on invalid/unavailable
sendToast({payload,execFile,timeoutMs:2000}) // -> Promise<void>; exact argv, normal/low only
runCoordinator({paths,relay,execFile,watch,clock,signals,stderr}) // -> Promise<void>, lifetime ends after cleanup
```

Default the integration's dependencies at its composition root, not in pure policy functions. `bin/familiar-niri sync` performs one coordinated resync; `watch` is the singleton long-running route. Preserve existing material signals and the existing window-map output for current consumers; never use its folded state for new attention decisions. `familiar-noctalia scheme-sync` remains behaviorally unchanged.
`clock` supplies `now`, `setInterval`, `clearInterval`, `setTimeout` and `clearTimeout`; `signals` has Node process-style `on`/`off` for TERM/INT. Tests inject these without real waits or host signals.

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
```

Cover every invalid DND response, send timeout/failure, an event resolving/dismissed between reads and claim, batch summary IDs, compositor disconnect/reconnect, startup queues, file rename bursts and no-change focus events. Hold the presentation lock while the heartbeat continues. Future-time/boot/instance mismatch is unhealthy. Heartbeat filenames are ignored by the resync watcher.

- [ ] **Step 3: Run `just test-fast`; confirm these tests fail before wiring side effects.**
- [ ] **Step 4: Implement adapter and pure desktop projection.** Query windows/workspaces outside the state lock; validate their fields. Use raw source/root process handles for the existing ancestry join. `resolvePresentations` reuses the existing context loader and public familiar-theme `assetsFor` for the episode-specific pose; use root intent for identity/color, not pose truth. Cache a successfully loaded context for one resync only; changes/repairs are picked up on the next resync. Missing identity/art exposes neutral styling and a named visual diagnostic without preventing attribution, lifecycle capture or text toasts. It must not silently select a different state image.
- [ ] **Step 5: Implement one coordinator loop with the existing 100 ms event coalescing, directory filename filter and Niri event stream.** Acquire the independent singleton lock; maintain a separate 2000 ms atomic heartbeat timer. Perform DND/focus classification, store actions and per-surface reservations under short state mutations, then await IPC outside the state lock. On stream close, stop children/watchers/timers and exit nonzero for supervision; do not silently continue stale attribution. On TERM/INT reap the event-stream child. Publish bounded failures without preventing healthy-surface delivery.
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

**Files:** Create `integrations/noctalia-plugin/plugin.toml`, `service.luau`, `presentation.luau`, `widget.luau`, `panel.luau`, `contract.test.mjs`; create `test/fixtures/noctalia-host.lua`; modify `.github/workflows/test.yml` for Lua development tooling.

**Interfaces:** Plugin ID `khughitt/familiar`, API 34, dependency `familiar`; widget entry `workspaces`, panel entry `alerts`, service entry `attention`. No configurable command strings or global shortcuts. `presentation.luau` exports `validateView(view)`, `pillsFor(view,outputName)`, `dismissIds(pill)`, `animationFor(pill,now,policy)` and the common `healthStatus` signature above. Source it as ordinary Lua-compatible Luau so tests can execute the production functions in a mocked Noctalia host.

- [ ] **Step 1: Add `lua5.4` to the existing Linux CI tool install and a Lua install step to the macOS test job; document it as a development prerequisite.** Do not add npm/runtime dependencies or change unrelated existing smoke expectations. Production runs inside Noctalia's Luau VM.
- [ ] **Step 2: Write the contract tests through the existing suite inventory.** Feed actual `attention status` output into the production Luau module, including null/absent optional keys. Capture constructed UI trees and call their real callbacks in `noctalia-host.lua`. Assert:

```js
assert.equal(pillsForOutputB.some(p => p.workspaceId === outputAWorkspace), false);
assert.deepEqual(rightClick.argv, ['familiar', 'attention', 'dismiss', capturedId]);
assert.equal(newConcurrentIdWasDismissed, false);
assert.equal(panelDismissWorksWithRightClickIntercepted, true);
assert.equal(view.approvalLabel, 'Approval requested — response unconfirmed');
assert.equal(healthToastsDuringOneDisconnectedMinute, 1);
```

Add health grace/stale/recovery/boot/future-time cases, no-data versus disconnected, invalid schema, pending requests plus suppression diagnostic, native urgency separation, root/worker tooltip labeling, both bar orientations, empty/occupied/focused states, count/tie rules, stable IDs after moves and stale click callbacks. Assert dismissal leaves native urgency and relay requests unchanged. Include reduced/off/static update cadence, DND stopping motion, and clamped 200–350 ms arrival/4000 ms pulse behavior.
- [ ] **Step 3: Run `just test-fast`; missing Lua must fail with an explicit development-prerequisite message, never silently skip new contract coverage.** Confirm functional assertions fail before implementation.
- [ ] **Step 4: Implement the service's bounded reads.** Read the live boot ID once per service runtime and capture its current `NIRI_SOCKET`; never trust only the identities in saved files. Every 250 ms, use at most one asynchronous read each for state and health; do not overlap an outstanding read or start Node subprocesses for polling. Compare bytes/revision and publish changed data through `noctalia.state`; health aging is checked even when episodes are unchanged. Diagnose absent/malformed state and preserve no stale trusted attribution. Runtime teardown owns its callbacks; no custom detached watcher is spawned.
- [ ] **Step 5: Implement pills and panel from Noctalia's own palette and the supplied identity accent.** Per-pill left click focuses its stable workspace ID; plain right-click dismisses the captured IDs. Keep middle-click settings. Add an explicit left-click Alerts button opening the plugin panel, whose per-workspace dismiss buttons are the fallback if configured right-click interception occurs. Do not use unsupported modifier gestures. Include the specified uncertainty/Claude attribution tooltip and independent suppression status glyph. Use distinct input/approval/error/completion glyph/outline treatments without hue-as-severity substitution.
- [ ] **Step 6: Implement bounded animation and health notification.** Use 16 ms widget updates only during finite arrival/pulsing; otherwise a 2000 ms idle update suffices because changed shared state triggers rendering. The service's health transitions create a persistent disconnected indicator after the 10000 ms grace/staleness threshold and one DND-respecting native health notice, throttled to 60000 ms across flaps. Unknown/on DND drops it without later replay. No widget can emit a notice while Noctalia itself is down.
- [ ] **Step 7: Run `just test-fast`, `just check`, and `noctalia plugins lint integrations/noctalia-plugin`; validate manifest/API bounds and actual CLI-to-Luau contract, then commit `feat: add Noctalia attention workspace indicators`.** The headless callback probe is not a substitute for the approved native gesture pilot.

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
