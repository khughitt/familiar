# Attention crash history Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a slowly crash-looping desktop attention coordinator visible: a schema-2 heartbeat carries a crash history, readers derive `crashes`, and the bar warns "unstable" without changing any gate.

**Architecture:** The singleton coordinator is the only writer of `attention-health.json`. It carries its predecessors' unclean ends forward under the singleton lock, normalises the list at every write, and marks a clean stop with a final `stopped: true` record. A clean stop includes a group SIGTERM/SIGINT that reaches the `niri msg` child first. Every restatement of the health rule (Node store, popup `logic.js`, plugin `presentation.luau`) validates schema 2. Node and Luau derive `crashes`, and the plugin turns `crashes ≥ 2` while healthy into a widget node and one notice per unstable episode.

**Tech Stack:** Node 22 ESM (`node:test`), Luau 0.743 for tests (plugin code must stay valid for the host's vendored 0.724), Quickshell JS (ES5-style `logic.js`).

**Spec:** `docs/specs/2026-10-24-desktop-attention-design.md`, subsection "Repeated crashes" under "Detecting coordinator failure" (accepted at ee3b32a), and its "crash history" validation bullet.

## Global Constraints

- Window and bounds: `CRASH_WINDOW_MS = 600000` (ten minutes), at most `8` entries, unstable at `crashes ≥ 2` while status is `healthy`.
- Schema-2 record keys, exactly: `schema, instanceId, epoch, owner, writtenAt, stopped, crashedAt`; `schema === 2`; `stopped` boolean; `crashedAt` an array of at most 8 non-decreasing safe integers, each in `[writtenAt − 600000, writtenAt]`. Schema 1 is invalid everywhere.
- `crashes` is the number of `crashedAt` entries with `0 ≤ now − t ≤ 600000`, for a valid record whose epoch equals the live boot ID and desktop session (both non-empty text); otherwise `null`.
- Unstable changes no gate. The popup gate (`commands.js` `healthy()`, `logic.js` `interruptible`), the widget's trusted attribution and the coordinator's toast claims keep their current conditions.
- Copy, verbatim: widget node text `Agent alerts unstable — the coordinator crashed N times in 10 minutes; alerts arriving at each crash may be lost`, with N rendered `8 or more` at 8. Notice text: `Agent alerts unstable — the coordinator keeps crashing`.
- Clean stop: exit on SIGTERM/SIGINT with code 0. The wait for the coordinator's own signal after the child dies by a signal it did not send is `1000` ms. The wait for the child's `close` after the lines end is `1000` ms.
- `familiar-niri sync` (`syncOnce`) neither reads nor writes the health record.
- Tests build every subprocess environment key by key (`PATH`, `HOME` in a test-owned temp dir, each variable read); never the inherited environment. Never signal processes by name (`pkill niri` kills the compositor); signal recorded pids or process groups only.
- Test route: `just test-fast` for focused and pre-commit runs (the project defines no `test-one`); `just test` when a task touches a `*.slow.test.*` file. Never call `node --test` directly. Never pipe test output through `tail`.
- No new dependencies. The plugin's Luau stays within what Luau 0.724 accepts.

## Review Focus

1. A heartbeat write racing the final clean-stop write. Expected: the final record is the last successful heartbeat with `stopped: true`, never overwritten by a late beat. Pinned in Task 2, "a late heartbeat cannot overwrite the final record".
2. A wall clock stepping backwards between instances. Expected: the writer drops future entries and keeps writing valid records, so health never fails closed. Pinned in Task 2, "a backward clock step keeps the heartbeat valid".
3. A plugin started (Noctalia restart) while the coordinator is already unstable. Expected: one notice for that episode, not one per restart afterwards. Pinned in Task 4, "an unstable episode found at plugin start sends one notice".
4. Only the `niri msg` child signalled (`kill <child pid>`). Expected: exit 1, so supervision restarts it. Pinned in Task 3's real-process test.
5. A history full at 8 entries. Expected: the oldest is dropped, and the widget says "8 or more". Pinned in Task 2, "the history keeps the newest eight", and Task 4's label test.

---

### Task 1: Schema-2 health record across writer and all three readers

**Files:**
- Modify: `src/attention/store.js:11-78` (constants, `validHealth`, `healthStatus` unchanged in logic, `writeHealth`)
- Modify: `integrations/niri/coordinator.js:215` (`beat` writes schema 2 with `stopped: false, crashedAt: []`)
- Modify: `integrations/niri-desktop/logic.js:67-91` (`validHealth`)
- Modify: `integrations/noctalia-plugin/presentation.luau:71-93` (`P.healthStatus` predicate)
- Test: `test/attention-store.test.js`, `test/attention-cli.test.js` (seed), `integrations/niri-desktop/logic.test.mjs`, `integrations/noctalia-plugin/contract.test.mjs` (`healthAt`, parity cases), `integrations/noctalia-plugin/cadence.slow.test.mjs` (fixture)

**Interfaces:**
- Produces: `export const HEALTH_SCHEMA = 2`, `export const CRASH_WINDOW_MS = 600_000`, `export const CRASH_HISTORY_MAX = 8` from `src/attention/store.js`; `validHealth(value) -> boolean` implementing the Global Constraints predicate. Luau and `logic.js` restate the same predicate. Luau accepts an empty table for `crashedAt`, and the writer never produces `{}`.

- [ ] **Step 1: Write the failing tests.** In `attention-store.test.js` change the `health()` fixture to schema 2 (`stopped: false, crashedAt: []`), then add `test('schema-2 health validity: keys, stopped, crashedAt bounds and order')`. It asserts `healthStatus` returns `'invalid'` for: `schema: 1`; a missing `stopped`; `stopped: 'no'`; `crashedAt` of length 9; `crashedAt: [5, 4]` (descending); an entry `> writtenAt`; an entry `< writtenAt − 600000`; a non-integer entry. It returns `'healthy'` for `crashedAt: [writtenAt − 600000, writtenAt]` and for `stopped: true`. Update the parity case lists in `logic.test.mjs` and `contract.test.mjs` ("healthStatus in Luau is the Node rule") to schema-2 fixtures, plus the invalid cases above. Move every schema-1 health fixture in the files listed to schema 2.
- [ ] **Step 2: Run `just test-fast`.** Expected: the new validity test and the parity tests FAIL (schema 2 is rejected today).
- [ ] **Step 3: Implement the predicate in `validHealth` (store.js), `validHealth` (logic.js) and `P.healthStatus` (presentation.luau).** Also make the coordinator's `beat` write `{ schema: 2, instanceId, epoch, owner, writtenAt, stopped: false, crashedAt: [] }`.
- [ ] **Step 4: Run `just test-fast`.** Expected: PASS, 0 failures.
- [ ] **Step 5: Run `just test`** (cadence.slow fixture changed). Expected: PASS.
- [ ] **Step 6: Commit** `feat(attention): move the coordinator heartbeat to schema 2`.

### Task 2: Coordinator crash history, final record and early signal handling

**Files:**
- Modify: `src/attention/store.js` (add `normaliseCrashes`, `carriedCrashes`, `readHealthRecord`)
- Modify: `integrations/niri/coordinator.js:161-311` (`recover` logging, `lifetime` start/beat/stop order)
- Test: `test/attention-coordinator.test.js`, `test/attention-store.test.js`

**Interfaces:**
- Consumes: Task 1 constants and `validHealth`.
- Produces:
  - `normaliseCrashes(list: number[], now: number) -> number[]`: drops entries `> now` or `< now − 600000`, sorts ascending, keeps the newest 8.
  - `carriedCrashes(previous: object|null, live: {bootId, desktopSession}) -> { crashedAt: number[], unusable: boolean }`:
    - `previous` is `null` or another epoch, or the live boot ID or session is unknown: `{ crashedAt: [], unusable: false }`.
    - `previous` is invalid or schema 1: `{ crashedAt: [], unusable: true }`.
    - `previous` is a valid schema-2 record of the live epoch: its `crashedAt`, plus its `writtenAt` when `stopped` is false (not normalised).
  - `readHealthRecord(paths) -> { record: any|null, present: boolean }`, where a missing file gives `present: false` and unparseable JSON gives `{ record: undefined, present: true }`. Reuse the existing private `readHealth` if it fits, and export it.

- [ ] **Step 1: Write the failing store tests.** `normaliseCrashes` keeps `[now − 600000, now]`, drops `now + 1` and `now − 600001`, sorts `[3, 1, 2]`, and keeps the newest 8 of 10 ("the history keeps the newest eight"). `carriedCrashes` covers each case listed under Produces.
- [ ] **Step 2: Write the failing coordinator tests**, using the harness, `h.boot()`, `h.stop()`, `h.exit()` and fake time. Read the record with `JSON.parse(await readFile(h.paths.attentionHealthPath))`.
  - `test('an unclean predecessor is counted; a clean one is not')`. Run 1 boots, then exits via `h.stream.end()` (exit 1). Run 2 boots, and its first heartbeat carries `crashedAt: [run 1's last writtenAt]`. Run 2 stops with SIGTERM: its final record has `stopped: true`, with `writtenAt` and `crashedAt` equal to its last periodic heartbeat. Run 3 boots, and its `crashedAt` equals run 2's.
  - `test('history from another boot, schema 1 or an invalid record starts empty')`. The schema-1 and invalid cases log one stderr line matching `/health record unusable/`, and another epoch logs none.
  - `test('a backward clock step keeps the heartbeat valid')`. Seed a valid schema-2 record of the live epoch with `crashedAt` and `writtenAt` 60 s in the future of the fake clock. The new coordinator's records are valid (`healthStatus` is `healthy`) and carry no future entry.
  - `test('entries age out of the window while the coordinator runs')`. Advance 600 001 ms, and the heartbeat's `crashedAt` is empty.
  - `test('a late heartbeat cannot overwrite the final record')`. Use `writeDelayMs` so a beat is in flight when SIGTERM is emitted. The file afterwards has `stopped: true`.
  - `test('a stop during recovery exits 0 with no heartbeat and leaves the predecessor record')`. Hold the presentation lock (as the existing "lock is held" test does), emit SIGTERM during `recover`, release the lock. Exit is 0, the health file is byte-identical to the seeded predecessor record, no watcher or stream was started, and `h.clock.pending() === 0`.
  - `test('recovery logs what it gave up')`. Seed one queued and one reserved episode. stderr matches `/recover: suppressed 1 queued, 1 uncertain/`.
- [ ] **Step 3: Run `just test-fast`.** Expected: the new tests FAIL.
- [ ] **Step 4: Implement in `lifetime`, in this order:**
  1. Register the SIGTERM/SIGINT handlers first.
  2. Read the record with `readHealthRecord`, then call `carriedCrashes(record, epoch)`, logging `health record unusable; crash history reset` when `unusable`.
  3. Call `recover` and log its `suppressedIds`/`uncertainIds` counts.
  4. If a stop was requested meanwhile, unregister the handlers and return 0.
  5. Otherwise start as today.

  `beat` uses one `now = clock.now()` for `writtenAt` and `normaliseCrashes(history, now)`. It tracks its in-flight promise, and remembers the last record that wrote successfully.

  On exit, do the following in order:
  1. Clear the interval.
  2. Await the in-flight beat.
  3. Drain (`chain`, `focusChain`, `feed.idle()`).
  4. If `exitCode === 0` and a heartbeat ever succeeded, write `{ ...lastWritten, stopped: true }`. Log a failure of that write; it leaves the crash countable.

  `syncOnce` is untouched.
- [ ] **Step 5: Run `just test-fast`.** Expected: PASS, including the existing TERM and recovery tests.
- [ ] **Step 6: Commit** `feat(attention): carry the coordinator's crash history in its heartbeat`.

### Task 3: A group stop that reaches the event-stream child first is a clean stop

**Files:**
- Modify: `bin/familiar-niri:89-97` (`eventStream` returns `ended`)
- Modify: `integrations/niri/coordinator.js:264-296` (stream end handling)
- Test: `test/attention-coordinator.test.js` (fake stream gains `ended`), new `test/attention-signals.slow.test.js`

**Interfaces:**
- Consumes: Task 2's stop path and final record.
- Produces: the `eventStream()` contract `{ lines: AsyncIterable<string>, close(): void, ended: Promise<{ code: number|null, signal: string|null }> }`.
  - `ended` resolves from the child's `close` event.
  - A spawn `error` resolves it as `{ code: null, signal: null }` after logging.
  - `close()` marks the signal as coordinator-sent.

- [ ] **Step 1: Write the failing in-process tests.** Extend `fakeStream()` with `ended` and an `endBy(signal)` helper that ends the lines and then resolves `ended` with `{ code: null, signal }`.
  - `test('a child stopped by the group signal before ours is a clean stop')`. Call `endBy('SIGTERM')`, then emit SIGTERM 500 ms later in fake time. Exit is 0 and the record has `stopped: true`.
  - `test('a child signalled alone exits 1 after a second')`. Call `endBy('SIGTERM')` with no coordinator signal and advance 1000 ms. Exit is 1, the record has `stopped: false`, and stderr matches `/event stream/`.
  - `test('a child that closes its output but stays alive is a stream failure')`. End the lines with `ended` never resolving, then advance 1000 ms. Exit is 1 and `close()` was called.
  - The existing "compositor disconnect" test keeps exit 1 (`ended` resolves `{ code: 1, signal: null }`).
- [ ] **Step 2: Run `just test-fast`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** After the lines end, race `ended` against a 1000 ms `clock` timeout, which on expiry calls `stream.close()` and counts as a failure. If the end came by `SIGTERM` or `SIGINT` that `close()` did not send, race a pending stop signal against another 1000 ms `clock` timeout: a signal arriving means `stop(0)`, and the timeout means log and `stop(1)`. Every other end is today's `stop(1)`. In `bin/familiar-niri`, resolve `ended` from `child.on('close', (code, signal) => …)`.
- [ ] **Step 4: Write `test/attention-signals.slow.test.js`.** It spawns the real `bin/familiar-niri watch` as a process-group leader (`detached: true`), with a fake `niri` and `noctalia` on a test-owned `PATH`. Model them on `FAKE_NIRI` in `test/attention-e2e.slow.test.js`; the fake `niri msg -j event-stream` prints a `WorkspacesChanged` line and then blocks, installing no signal handler. The environment is built key by key (`PATH`, `HOME`, `FAMILIAR_STATE_DIR`, `NIRI_SOCKET`). It waits until the health file exists.
  - `test('SIGTERM to the process group exits 0 with stopped: true')`, using `process.kill(-pid, 'SIGTERM')`.
  - `test('SIGINT to the process group exits 0 with stopped: true')`.
  - `test('SIGTERM to the event-stream child alone exits 1 with stopped: false')`. Find the child pid from `/proc/<pid>/task/<pid>/children`, never by name.
  - Each test kills its group in `t.after` as well.
- [ ] **Step 5: Run `just test`.** Expected: PASS in both partitions.
- [ ] **Step 6: Commit** `fix(niri): count a group stop that reaches the event stream first as clean`.

### Task 4: Readers derive crashes; the plugin warns once per unstable episode

**Files:**
- Modify: `src/attention/store.js` (`crashCount`, `readAttentionView` adds `health.crashes`)
- Modify: `integrations/noctalia-plugin/presentation.luau` (`P.crashCount`, `P.UNSTABLE_NOTICE`, `P.unstableLabel`, `P.UNSTABLE_CRASHES`)
- Modify: `integrations/noctalia-plugin/service.luau:43-191` (episode state, notice, publish)
- Modify: `integrations/noctalia-plugin/widget.luau:138-146` (status node)
- Test: `test/attention-store.test.js`, `test/attention-cli.test.js`, `integrations/noctalia-plugin/contract.test.mjs`

**Interfaces:**
- Consumes: Task 1 predicate and constants.
- Produces:
  - `crashCount(health, { now, bootId, desktopSession }) -> number|null` in store.js, restated as `P.crashCount(health, live)`.
  - `readAttentionView` returns `health: { status, record, crashes }`.
  - The plugin's published health is `{ status, disconnected, crashes, unstable }`.
  - `P.unstableLabel(crashes: number) -> string`.

- [ ] **Step 1: Write the failing tests.**
  - Store: `crashCount` returns 2 for two entries in the window; null for another epoch, unknown live IDs, or an invalid or missing record; and excludes an entry `now − 600001`. The view tests assert `health.crashes` (null when missing).
  - CLI: `status` prints `health.crashes`.
  - Luau parity: `P.crashCount` equals `crashCount` over the same cases.
  - `P.unstableLabel(2)` is the Global Constraints text with N=2, and `P.unstableLabel(8)` reads `8 or more`.
  - Contract (scene with heartbeats every 2 s): `test('two crashes in ten minutes show the unstable node beside DND-unknown and send one notice')`. Heartbeats carry `crashedAt` with 2 entries. Assert the `status-unstable` node tooltip, one notice with `P.UNSTABLE_NOTICE`, the DND-unknown node also present when `dnd` is unknown, and pills still attributed.
  - `test('restarts inside an unstable episode do not re-notify')`. Interleave `mismatched` readings (instanceId changes) for 4 s between healthy unstable stretches over 5 minutes: exactly one notice.
  - `test('an unstable episode found at plugin start sends one notice')`.
  - `test('disconnected hides the unstable node')`.
  - `test('a notice refused by the shared minute bound is dropped, not delayed')`. A disconnected notice, then an unstable episode starting 30 s later: no second notice ever, but the node shows.
  - `test('the unstable node clears when crashes age out')`; `test('an unstable notice is dropped on DND on, unknown or a failed query')` (node still shown, matching the existing disconnected-notice DND cases).
- [ ] **Step 2: Run `just test-fast`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `service.luau`:
    - Keep `unstable`, `unstableGeneration` and the episode flag beside `disconnected` and `failureGeneration`.
    - An episode begins on a healthy reading with `crashes ≥ 2` and ends on a healthy reading with `crashes < 2`; non-healthy readings leave it unchanged.
    - Share `noticeAt` with the disconnected notice.
    - Guard the DND reply with `unstableGeneration` and the episode still open.
  - `widget.luau`: add a `status-unstable` node (glyph `⚠`, variant `outline`) after the fault/disconnected chain and before the DND check. It is not part of the `elseif` chain, so it can sit beside DND-unknown, and it is hidden when a fault or a disconnection is shown.
- [ ] **Step 4: Run `just test-fast`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(attention): warn when the coordinator keeps crashing`.

### Task 5: Reference docs and runbook

**Files:**
- Modify: `docs/attention.md:86-130` (heartbeat schema 2, crash history, unstable warning)
- Modify: `docs/runbooks/desktop-attention-rollout.md:84-110, 160-175` (start-limit paragraph, kill check, new upgrade step)
- Modify: `docs/surfaces.md:146` and `docs/install.md:445` only if their heartbeat wording becomes false

- [ ] **Step 1: Update `docs/attention.md`** to describe the schema-2 record, clean stop versus crash, `crashes`, and the unstable node and notice. Its precedence: below a fault or a disconnection, beside DND-unknown, and no gate change.
- [ ] **Step 2: Rewrite the runbook's start-limit paragraph.** The limit ends only fast crash loops, and the crash history reports any loop with a period under about five minutes as "unstable".
- [ ] **Step 3: Replace the kill check with `systemctl --user kill --kill-whom=main --signal=SIGKILL familiar-attention`.** Say why a plain `systemctl --user kill` is a clean, unrestarted stop.
- [ ] **Step 4: Add an upgrade step for merging this change.** Under one approval: restart the coordinator (the unit, or the Niri-started `familiar-niri watch` where no unit exists), reload the plugin, restart the popup. Then name the two transient windows from the spec's Upgrade paragraph, and confirm with `familiar attention status | jq -r '.health.status, .health.crashes'` (expected `healthy`, `0`).
- [ ] **Step 5: Run `just check`.** Expected: PASS (`ops-check` and `tasks check` clean).
- [ ] **Step 6: Commit** `docs(attention): document the crash history and the upgrade step`.
