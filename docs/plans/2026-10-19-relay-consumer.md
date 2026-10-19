# Familiar as a relay consumer: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** familiar stops owning harness hooks and its registry, and becomes a relay
observer. It projects relay's snapshot into its own `sessions.json` and the unchanged
`intent.json`, and keeps all visual identity and terminal rendering.

**Architecture:** `familiar observe` (one relay observer envelope on stdin) works in
three steps. It proves and prepares one session's enrichment outside a lock. Under
`presentation.lock` it projects the newest snapshot. After the lock, it emits through a
new per-terminal ownership gate, then acknowledges cleanup evidence. `familiar reap`
calls relay's `reapRegistry()` and then runs the same projection without emitting.
Relay's adapters, registry and OpenCode server plugin replace familiar's copies, which
are deleted.

**Tech Stack:** Node >=22 ES modules, `node:test`, relay
`git+https://github.com/khughitt/relay.git#v0.1.0` (later `#v0.1.1`), familiar-theme
v0.3.0.

**Status:** draft for review, round 2. Round 1 (codex gpt-6.1-sol) found eight gaps, all addressed: teardown acknowledgement, the two process providers, absent relay state, OpenCode retirement by package name, the theme fixture, the race-test pause point, runner-level read ordering, and a real pty.

**Spec:** `docs/specs/2026-10-19-relay-consumer-design.md` (accepted 2026-10-19). Its
parent is ops `docs/specs/2026-09-16-relay-design.md` §3 and §6, and the contract is
relay `docs/api.md` at `v0.1.0`. Section references (§n) below are to the spec.

## Global Constraints

- **Relay imports:** only from relay's root (`relay`) or `relay/fixtures/*`. No deep
  imports (package `exports` forbids them).
- **Launchers:** `bin/familiar` and `bin/familiar-opencode` keep importing nothing but
  `src/deps.js` (AGENTS.md). New CLI code goes in `bin/familiar.js` or `src/`.
- **Intent format:** `intent.json` keeps its current format, keyed by
  `Agent.sessionId`, never by `Agent.id`.
- **Old state:** familiar never reads, writes or deletes the old `agents.json` or
  `agents.lock` (§2).
- **No live configuration:** no hook, unit, `subscribers.json` or harness setting
  outside a test's temporary directory (Out of scope; `hq-539508` owns cutover).
- **Status line policy:** `statusline` is cosmetic: one stderr line and exit 0 on
  failure. `observe` exits 1 on a fault and 0 on staleness or success (§10).
- **Tests:** `just test-fast` is the only test command, since the project defines no
  `test-one`. `just check` runs before each commit. Never call `node --test` directly.
- **Commits:** conventional; no AI attribution.

## Review Focus

1. **Relay state that is absent versus unsafe.**
   - An **absent** relay state directory or `agents.json` is ordinary absence:
     `readSnapshot()` returns `null`, which projects to no sessions (admitted ones move
     to `ended`), and `observe` exits 0.
   - An **existing unsafe** one (`RELAY_STATE_DIR` at 0755) makes relay throw
     `IO_ERROR`. Then `observe` and `reap` exit 1 with one line naming the code, write
     nothing, and print no stack trace.
   - Covered in Task 4 and Task 5 for the observer, Task 6 for `reap`.
2. **Corrupt `sessions.json`.** It is an error naming the file, never treated as empty.
   An empty registry plus corrupt sessions must not wipe intent (Task 2).
3. **A fresh host.** With no familiar state directory and no `sessions.json`, the
   first `observe` creates both and admits the session (Task 5).
4. **Old `agents.json` at cutover.** A pre-existing familiar `agents.json` with live
   records is never read as prior state, and is byte-identical after `observe` and
   `reap` (Task 5).
5. **`familiar observe` run by hand.** Empty stdin, or text that is not an envelope,
   gives one line (`familiar: observe: …`) and exit 1, and writes nothing (Task 5).

---

### Task 1: Pin relay and prove state parity

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `test/relay-parity.test.js`

**Interfaces:**
- Produces: `import { STATES, adapterFor, createProcessOps, readSnapshot, reapRegistry } from 'relay'` is resolvable.

- [ ] **Step 1: Write the failing test** `test/relay-parity.test.js`:
  - `relay's observation states are exactly familiar-theme's`:
    `assert.deepEqual([...relaySTATES].sort(), [...themeSTATES].sort())`.
  - `every relay state resolves assets in the committed theme fixture`: for each relay
    `STATES` entry, `assetsFor(pack, defaultMemberForSlot(pack, 0), 'dark')[state].terminal`
    is an existing file. Load `test/fixtures/theme-pack` directly with `loadThemePack`,
    as `test/bin-familiar.test.js` and `test/cli-surface.test.js` do. The engine ships
    no `themes/` directory, so `paths().themesDir` must not be used.
- [ ] **Step 2:** `just test-fast`. Expected: FAIL, `Cannot find package 'relay'`.
- [ ] **Step 3:** add `"relay": "git+https://github.com/khughitt/relay.git#v0.1.0"` to
  `dependencies`, then `npm install`. Confirm that `package-lock.json` records
  `git+ssh://git@github.com/khughitt/relay.git#0f596607ad088be7607a9ff0b30f2073d2ee9147`.
- [ ] **Step 4:** `just test-fast`. Expected: PASS. `test/deps.test.js` stays green,
  since `missingDependencies` now also covers `relay`.
- [ ] **Step 5:** `just check`, then commit `build(deps): pin relay v0.1.0`.

### Task 2: Presentation state and the projection

**Files:**
- Create: `src/bus/sessions.js`, `src/bus/projection.js`
- Create: `test/sessions.test.js`, `test/projection.test.js`
- Modify: `src/bus/paths.js`, `test/paths.test.js`

**Interfaces:**
- Produces, in `src/bus/paths.js`: `paths()` adds `sessionsPath`
  (`<stateDir>/sessions.json`) and `presentationLockPath`
  (`<stateDir>/presentation.lock`). `agentsPath` and `lockPath` are removed in Task 8,
  not here.
- Produces, in `src/bus/sessions.js`:
  - `EMPTY_SESSIONS`: `{ schema: 1, registry: null, sessions: {}, ended: {} }`.
  - `readSessions(path) → Promise<Sessions>`: absent → a fresh `EMPTY_SESSIONS` copy.
    Corrupt JSON, wrong schema, or a malformed `Session`/`Ended` throws
    `Error('invalid sessions file at <path>: <what>')`.
  - `writeSessions(path, value) → Promise<void>` via `writeJsonAtomic`.
  - `sameBasis(a, b) → boolean`: true only when `generation`, `agentId` and `cwd` are
    equal, and `process` is non-null on both with equal `platform`, `host`, `bootId`,
    `pid` and `start`.
  - `sessionIdOf(agentId) → string`: the text after the first colon.
  - Type shapes as spec §2. `starttime` is a Number, from familiar's `startTimeOf`.
- Produces, in `src/bus/projection.js`:

  ```js
  projectSnapshot({
    snapshot,      // relay Snapshot | null
    prior,         // Sessions
    priorIntent,   // Record<sessionId, IntentRecord>
    seq,           // integer, this invocation's counter value
    mode,          // 'full' | 'drop-only'
    event,         // null | { sessionId }: the event's session after the worker fold
    prepared,      // null | { basis, terminal: { pid, starttime }, context }
    resolveVisuals // async (Record<sid, Session>) => { intent, faults: Map<sid, string> }
  }) → Promise<{
    sessions,      // Sessions to write
    intent,        // Record<sid, IntentRecord> to write
    faults,        // Map<sid, string>
    stale,         // boolean: prepared was given and did not match the locked row
    capture,       // null | { prev: Session|Ended|null, next: Session|null }; only when event
    diagnostics,   // string[]
  }>
  ```

  `context` is
  `{ cwd, projectKey, project, remote, repoRoot, repositoryRoot, projectColor }`.

- [ ] **Step 1: Write failing `test/sessions.test.js`:**
  - absent file → `EMPTY_SESSIONS`;
  - corrupt JSON → throws `/invalid sessions file/`;
  - `schema: 2` → throws;
  - round trip;
  - `sameBasis`: false when either `process` is null, false on each differing field,
    true on equal;
  - `sessionIdOf('opencode:opencode:42') === 'opencode:42'`.
- [ ] **Step 2: Write failing `test/projection.test.js`,** with snapshot rows built
  inline (schema 2 `Agent`) and a fake `resolveVisuals` that faults named sessions:
  - `a fresh prepared event admits its session`: the record carries `basis`, terminal
    `pid`/`starttime`, `seq`, the row's `state`/`updatedAt` and every context field;
    intent has the key.
  - `an unadmitted registry agent without prepared enrichment is not projected` (§4).
  - `the projection depends on the snapshot, not on the seq order`: project a newer
    row first, then again with an older `seq` and the same snapshot. The output
    reflects the snapshot. This pins only the pure property; the lock/read ordering it
    relies on is tested through the runner in Task 5.
  - `stale enrichment is discarded`: the prepared basis differs from the locked row in
    turn by process, by cwd and by generation. `stale === true`; with a matching prior
    record, the context is kept and only the state updates; with none, the session is
    out of `sessions` and `intent`, the old record is in `ended`, and `capture` is
    null.
  - `a row whose basis moved since admission leaves the projection on reconcile`
    (`event: null`).
  - `session-end drop-only`: the row is absent and the session's record moves to
    `ended` with `seq`. Other sessions and their `priorIntent` entries are copied
    unchanged, `resolveVisuals` is never called, and
    `capture = { prev: <the ended entry>, next: null }`.
  - `removal by another observer`: B's full projection drops A to `ended`. Then A's
    drop-only projection captures `prev` from `ended` and leaves the entry in place.
  - `no ended entry when a present session owns the same terminal process`: the `/clear`
    order where B is projected first.
  - `an admitted session with the same terminal retires a matching ended entry`.
  - `re-admission under the same id replaces its ended entry`.
  - `a visual fault omits intent but keeps the session`, including the event's own
    session: `capture.next` is the record, `intent[sid]` is absent, and `faults` has it.
  - `worker rows fold into their root`: the root's state and `updatedAt` come from the
    latest of the root and its workers. There is no key for the worker, and a worker
    without its root row is not projected.
  - `a sessionId shared by two agents is a collision`: neither is projected, both go to
    `ended` if they were admitted, and a diagnostic names both ids.
  - `a null snapshot projects to no sessions`: admitted sessions go to `ended`.
  - `generation reset`: sessions absent from the new generation's snapshot go to
    `ended`; `registry` records the new generation and revision.
  - Review Focus 2: `corrupt sessions never empties intent`, asserted at the
    `readSessions` boundary (it throws before any projection).
- [ ] **Step 3:** `just test-fast`. Expected: FAIL, modules missing.
- [ ] **Step 4:** implement `src/bus/sessions.js` and `src/bus/projection.js`.
  `projectSnapshot` is pure apart from awaiting `resolveVisuals`: no file or process
  access. Order of work in `full` mode:
  1. Fold the workers.
  2. Detect collisions.
  3. For each candidate row, decide its context source: `prepared` if it is the
     event's row and `sameBasis` holds; else the prior record if `sameBasis` holds;
     else drop it.
  4. Move dropped admitted records to `ended`, unless a kept session owns the same
     `pid` and `starttime`.
  5. Retire `ended` entries whose terminal a kept session owns, or whose id was
     re-admitted.
  6. Call `resolveVisuals(kept)`.
  7. Set `capture`.

  In `drop-only` mode, only steps 4 and 7 run, against keys absent from the snapshot.
- [ ] **Step 5:** `just test-fast`. Expected: PASS.
- [ ] **Step 6:** `just check`, then commit
  `feat(bus): project relay snapshots into presentation sessions`.

### Task 3: Per-terminal ownership and absent-intent emission

**Files:**
- Create: `src/render/term/terminal-owner.js`, `test/terminal-owner.test.js`
- Modify: `src/render/term/emit.js`, `src/render/term/ledger-prune.js`,
  `test/emit.test.js`, `test/emit-section.test.js`, `test/ledger-prune.test.js`

**Interfaces:**
- Produces, in `src/render/term/terminal-owner.js`:
  - `terminalOwnerPaths(transmitDir, { pid, starttime }) → { entryPath, lockPath }`,
    both under `<transmitDir>/terminals/`, named `<pid>-<starttime>.json` and `.lock`.
  - `decideClaim(current /* {sessionId, seq} | null */, { sessionId, seq /* integer | null */ }) → 'own' | 'superseded'`:
    - integer `seq`: `'own'` only when `current` is null or `seq > current.seq`;
    - `seq === null` (settle): `'own'` only when `current?.sessionId === sessionId`.
  - `withTerminal({ transmitDir, terminal, sessionId, seq, lockWith, lockOptions }, fn) → Promise<result>`:
    - takes the terminal lock;
    - reads the owner and decides;
    - on `'superseded'`, returns `{ kind: 'superseded', reason: 'terminal' }`, writing
      nothing;
    - on `'own'` with integer `seq`, writes `{ sessionId, seq }` **before** calling
      `fn()`, then returns `fn()`'s result;
    - is called before, and wraps, the session's transmission lock.
  - `pruneTerminalOwners({ transmitDir, ownerAlive, lockWith }) → Promise<{ removed: string[] }>`:
    removes records whose `pid`/`starttime` owner is confirmed not alive.
- Produces, in `src/render/term/emit.js`, for teardown (`next === null`): `{ kind: 'ended' }`
  only when the reset bytes were written. When the owner is alive but the terminal
  cannot be opened, or `isatty` rejects it, the tombstone is still written (it is
  ordering evidence) and the result is `{ kind: 'suppressed', reason: 'open' }` or
  `{ kind: 'suppressed', reason: 'not-a-tty' }`. Today both of those return `ended`.
- Produces, in `src/render/term/emit.js`: `emit({ …, next, intent })` accepts
  `intent === null` with a non-null `next`, returning `{ kind: 'withdrawn' }`. Inside
  the existing section it:
  - gates on order and ownership as today;
  - stamps `{ held: null, presented: null }`, which is not `ended`;
  - writes `oscReset()` when the owner is alive.

- [ ] **Step 1: Write failing tests:**
  - `test/terminal-owner.test.js`:
    - the `decideClaim` table, including equal `seq` → `'superseded'`;
    - `the sequence never decreases`: owner `B/40`, then `B/20`, then `A/30`. The record
      stays `{B, 40}`, and neither `fn` runs;
    - `settle proceeds only for the recorded owner`;
    - `pruneTerminalOwners` removes a dead owner's record and keeps a live one.
  - `test/emit.test.js`:
    - `absent intent withdraws visuals`: ledger `held: null`, `presented: null`,
      `ended: false`; bytes are exactly `oscReset()` for a live owner, and none for a
      dead owner;
    - a later event after the withdrawal creates normally;
    - `teardown reports a reset it could not write`: with `open` throwing, and then
      with `checkTty` returning false, a live-owner teardown returns `suppressed` with
      reason `open` and `not-a-tty`, the ledger tombstone is written, and no bytes are
      written.
  - `test/emit-section.test.js`: `a captured reset paused across another session's paint
    writes nothing`. A is paused **before it acquires the terminal lock**, not inside
    the locked callback, which would hold the lock and deadlock B. The steps:
    - A's teardown emission (seq 10) is given a `lockWith` wrapper that awaits a
      deferred and only then calls the real `withLock`;
    - B's transition (seq 11) on the same terminal runs to completion through the real
      lock;
    - the deferred is resolved, and A acquires the lock, finds the owner `B/11`, and
      returns `{ kind: 'superseded', reason: 'terminal' }`;
    - the terminal's bytes are only B's.
  - `test/ledger-prune.test.js`: the `*.json` sweep ignores the `terminals/` subdirectory.
- [ ] **Step 2:** `just test-fast`. Expected: the new cases FAIL.
- [ ] **Step 3:** implement `terminal-owner.js`. Use `withLock` with
  `transmitLockOptions` for the terminal lock. Extend `emit` for `intent === null`, and
  have `pruneLedgers` skip directories.
- [ ] **Step 4:** `just test-fast`. Expected: PASS, and existing emit, settle and
  ledger tests stay green.
- [ ] **Step 5:** `just check`, then commit
  `feat(term): serialize terminal ownership per terminal process`.

### Task 4: Ownership proof and enrichment

**Files:**
- Create: `src/observe/envelope.js`, `src/observe/enrich.js`, `src/render/harness.js`
- Create: `test/observe-envelope.test.js`, `test/observe-enrich.test.js`

**Interfaces:**
- Consumes: Task 2's `sameBasis`, `sessionIdOf`, and the `Basis`/context shapes.
- Produces, in `src/observe/envelope.js`: `parseEnvelope(text) → Envelope`, which
  throws `Error('observe: <what>')` unless the value is exactly api.md's observer
  envelope:
  - `schema: 1`;
  - `type` is `event` or `reconcile`;
  - `subscriber` is a string;
  - `event` is an object when `type` is `event`, and `null` otherwise. Within it:
    `kind`, `harness`, `agentId`, `sessionId` and `cwd` are strings, and `root` is a
    string when present;
  - `registry.generation` is a string or null, and `registry.revision` a number or
    null;
  - `changed` is a boolean and `reaped` a string array.

  Empty text gives `'observe: empty input (expected one relay observer envelope)'`.
- Produces, in `src/render/harness.js`:
  - `printsPlaceholderCells(harness) → boolean`: `claude-code` true, `codex` false,
    `opencode` false; an unknown harness throws.
  - `noTerminalMessage(harness, chain) → string`. Codex, when the chain holds a `codex`
    process without a tty, gets the `--no-daemon` text moved verbatim from
    `src/adapters/codex.js:97-103`. Otherwise: `could not find the <harness> process
    with a terminal among the ancestors: <chain>`.
- Produces, in `src/observe/enrich.js`:

  ```js
  prepareEnrichment({
    envelope, snapshot, prior,     // prior: Sessions
    relayProcess,                  // relay createProcessOps(): ancestors, handleOf, executableOf, argvOf
    renderProcess,                 // familiar defaultProcessOps (src/bus/proc.js): startTimeOf
    adapterFor,                    // relay adapterFor
    gitContext, lookupProjectColor,
    startPid = process.pid,
  }) → Promise<
      { ok: true, sessionId, basis, terminal: { pid, starttime }, context, warnings: string[] }
    | { ok: false, sessionId, exitCode: 0 | 1, reason: string }>
  ```

  The `ok: false` form gains `absent: true` when the session has no row. Its order of
  work:
  1. **Absence.** If `snapshot === null`, or the event's agent has no row
     (`snapshot.agents[envelope.event.agentId]` is missing), or a worker's root row is
     missing: return `{ ok: false, absent: true, exitCode: 0, reason: 'no registry row
     for this session' }`. Nothing is dereferenced first. The row is the root row for a
     worker (`row.root` → `snapshot.agents[row.root]`).
  2. Check `envelope.registry.generation === snapshot.generation`; otherwise
     `exitCode 0`, reason `obsolete envelope`.
  3. Get `resolveSessionPid({ startPid, ancestors: relayProcess.ancestors, executableOf: relayProcess.executableOf, argvOf: relayProcess.argvOf })`,
     then `relayProcess.handleOf(pid)`. A null result or a throw is `exitCode 1`,
     `ownership unproven`.
  4. Compare the handle with `row.process`: a null row process is `exitCode 1`; a
     different process is `exitCode 0`, `a newer process owns this session`.
  5. Get `resolveTerminalPid({ startPid, ancestors: relayProcess.ancestors })`; null is
     `exitCode 1` with `noTerminalMessage`. Stamp the terminal with
     `renderProcess.startTimeOf(pid)`.
  6. Run `gitContext(row.cwd)` on every call.
  7. Reuse `projectColor` from `prior.sessions[sessionId]` when its `repoRoot` is equal;
     otherwise call `lookupProjectColor(repoRoot)` (or `NO_PROJECT` outside a
     repository).

- [ ] **Step 1: Write failing tests:**
  - `observe-envelope.test.js`: each field's refusal, the empty-input message, and
    both valid forms.
  - `observe-enrich.test.js`, with fake `relayProcess` and `renderProcess` and chains
    built after relay's
    `relay/fixtures/ancestry.json` shapes:
    - a proven event returns `ok` with the root row's basis for a worker;
    - `absence is not an error`: a `null` snapshot, a snapshot without the event's
      agent, and a worker whose root row is missing each return `absent: true` and
      `exitCode 0`, with no process or git call;
    - an obsolete envelope generation → `exitCode 0`;
    - `stall before the first read`: the snapshot row holds B's handle, while the
      observer chain resolves A's process → `exitCode 0`, no git call made;
    - `row.process === null` → `exitCode 1`;
    - an unreadable own handle (`handleOf` throws `PROCESS_UNREADABLE`) → `exitCode 1`;
    - no terminal → `exitCode 1` and the Codex `--no-daemon` message for a tty-less
      `codex` chain;
    - `git per event`: two calls with the same `cwd`, where the fake `gitContext`
      returns no repository and then a remote, yield different `context.projectKey`
      values;
    - project colour carried on an equal `repoRoot` and looked up on a change.
- [ ] **Step 2:** `just test-fast`. Expected: FAIL, modules missing.
- [ ] **Step 3:** implement the three modules. `enrich.js` imports `gitContext` from
  familiar's `src/bus/identity.js` only as a default parameter.
- [ ] **Step 4:** `just test-fast`. Expected: PASS.
- [ ] **Step 5:** `just check`, then commit
  `feat(observe): prove session ownership before enrichment`.

### Task 5: The observer runner

**Files:**
- Create: `src/observe/run.js`, `src/observe/context.js`, `src/observe/emission.js`
- Create: `test/observe-run.test.js`
- Modify: `bin/familiar.js`: move `context()`, `makePrepareSprites` and
  `reportEvictions` out; `emitHookTransition` becomes `emission.js`. No CLI rows yet.

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces, in `src/observe/context.js`:
  - `loadContext({ paths, config }) → Promise<ctx>` (today's `context()`);
  - `makePrepareSprites(ctx, overrides)`, moved unchanged;
  - `visualResolver(ctx) → resolveVisuals` (Task 2's signature), built from
    `makePrepareSprites` plus `resolveAll`.
- Produces, in `src/observe/emission.js`:
  `emitTransition({ prev, next, intent /* Intent | null */, seq, harness, provisional, paths, renderProcess, platform, hookEnv, probe, lockWith }) → Promise<result>`.
  `renderProcess` is familiar's `defaultProcessOps` (`recordOf`, `ownerAlive`,
  `startTimeOf`), exactly what today's `emitHookTransition` uses. It never receives
  relay's provider.
  It is today's `emitHookTransition` wrapped in `withTerminal` (Task 3), with
  `transmitSprite = printsPlaceholderCells(harness)`. `prev`/`next` are `Session` or
  `Ended` records (both carry `pid`, `starttime`, `sessionId`, `project`).
- Produces, in `src/observe/run.js`:
  - `observe({ text, deps }) → Promise<{ exitCode: 0 | 1, lines: string[] }>`. `deps`:
    `{ paths, relay: { readSnapshot }, relayProcess, renderProcess, adapterFor, gitContext, lookupProjectColor, loadContext, emitTransition, lockWith, now, env }`.
    The two process providers are distinct contracts:
    - `relayProcess` (relay's `createProcessOps()`) serves only `prepareEnrichment`'s
      proof and ancestry;
    - `renderProcess` (familiar's `defaultProcessOps`) serves terminal stamping,
      emission, locks, `reap`'s `ended` liveness and the prunes.

    The CLI wires both; tests inject fakes of each separately.
  - `reconcile({ deps }) → Promise<{ sessions, awaiting: string[], lines: string[] }>`:
    a full projection with `event: null`, under the lock, with no emission.
  - `acknowledgeEnded({ paths, sessionId, seq, lockWith }) → Promise<boolean>`: under the
    presentation lock, deletes `ended[sessionId]` only if its `seq` equals `seq`.

  `observe`'s control flow (spec §1, §4, §6):
  1. `parseEnvelope`.
  2. If `event.kind === 'session-end'`:
     - under the lock: `nextSeq`, `readSnapshot`, `readSessions`, read the prior
       intent, then `projectSnapshot({ mode: 'drop-only', event: { sessionId } })`, and
       write;
     - after it: if `capture.prev` exists, `emitTransition({ prev, next: null })`;
     - call `acknowledgeEnded` only for an outcome of `ended` (the reset was written),
       `suppressed` with reason `owner-dead`, or `superseded` (session ledger or
       terminal). A `suppressed` `open` or `not-a-tty` (Task 3) keeps the evidence.
  3. Any other `event`: read the snapshot unlocked and run `prepareEnrichment`.
     - On `absent`, run step 4 with `prepared: null`, so the disappearance is
       reconciled, then return `exitCode 0` without emitting.
     - On any other `!ok`, return `{ exitCode, lines: [reason] }` without projecting or
       emitting.
  4. Under the lock: `nextSeq`, `readSnapshot`, `readSessions`, then
     `projectSnapshot({ mode: 'full', prepared, event })` with
     `resolveVisuals = visualResolver(await loadContext())`, and write `sessions`, then
     `intent`.
  5. If `stale`: one line and `exitCode 0`, no emission.
  6. Otherwise `emitTransition` with `provisional = event.kind === 'session-start'`,
     then `acknowledgeEnded` when `prev` came from `ended` and the outcome qualifies.
  7. Codex pet convergence on Codex `session-start`, as today's `hook` branch does.
  8. Ledger prune, terminal-owner prune and temp sweep.

  Faults make `exitCode 1`, with one line each. `reconcile` type envelopes call
  `reconcile`.

- [ ] **Step 1: Write failing `test/observe-run.test.js`** (temp state directories,
  `RELAY_STATE_DIR` at a private 0700 temp dir, snapshots written with relay's
  `applyEvent` under an injected `processOps` and `gitContext`, recorded `emitTransition`):
  - admit, then transition: intent is written, emission sees `prev` null then the
    record;
  - `teardown resets from stored evidence`:
    - with its own drop;
    - after another observer's projection already moved it;
    - in both cases the snapshot holds no row, and `prepareEnrichment` is never called;
  - `ended lifecycle`:
    - the entry survives capture;
    - an `emitTransition` that throws leaves it, and the next event retries;
    - `acknowledgeEnded` with a different `seq` removes nothing;
  - `a stale observer emits nothing and exits 0`;
  - `teardown keeps evidence when the reset was not written`: `emitTransition` returns
    `suppressed` `open` and then `not-a-tty`; `ended[sid]` remains, and the next event
    of that session retries it;
  - `the snapshot is read after the presentation lock`. Two `observe()` calls, X and Y,
    run over a mutable snapshot store, with `lockWith` gated by deferreds so the test
    controls who acquires first. The steps:
    - X's unlocked read sees revision 1, and X then waits at the lock;
    - the store advances to revision 2 (the session's state changes);
    - Y acquires, projects and releases;
    - X acquires.

    `sessions.registry.revision === 2` after X, and `intent.json` shows revision 2's
    state. An implementation that projected X's pre-lock read would leave revision 1;
  - `an event whose row vanished reconciles the removal and exits 0`: an admitted
    session's row is gone and a non-end event arrives. The session moves to `ended`,
    nothing is emitted, and the exit code is 0;
  - Review Focus 1, absent: no relay state directory at all → `exitCode 0`, an empty
    projection, and `sessions.json` written;
  - `a visual fault on the incoming session withdraws visuals and exits 1`;
  - `a missed observer of an admitted session is healed by another session's event`;
  - `a missed first observer leaves the session unadmitted`: a reconcile and another
    session's event do not admit it, and its next event does;
  - Review Focus 1, unsafe: an existing `RELAY_STATE_DIR` at 0755 → `exitCode 1`, one
    line containing `IO_ERROR`, nothing written;
  - Review Focus 3: a fresh host with no state directory admits;
  - Review Focus 4: a pre-written familiar `agents.json` is byte-identical afterwards;
  - Review Focus 5: empty and non-JSON text → `exitCode 1`, one `familiar: observe:`
    line, nothing written;
  - `session-end` drop-only latency: the median of 20 in-process runs is under 100 ms
    on this host. That is a regression bound leaving room for Node startup inside the
    200 ms teardown entry.
- [ ] **Step 2:** `just test-fast`. Expected: FAIL.
- [ ] **Step 3:** implement the three modules and move the helpers out of
  `bin/familiar.js`. Existing `hook` and `statusline` keep working by importing the
  moved functions.
- [ ] **Step 4:** `just test-fast`. Expected: PASS, with `test/bin-familiar.test.js`
  still green.
- [ ] **Step 5:** `just check`, then commit `feat(observe): run one projection per relay envelope`.

### Task 6: `familiar reap` over relay

**Files:**
- Modify: `bin/familiar.js` (`reap` branch), `test/bin-familiar.test.js`

**Interfaces:**
- Consumes: relay `reapRegistry`; Task 5's `reconcile`; Task 3's `pruneTerminalOwners`.
- Produces: `familiar reap` does four things in order:
  1. `reapRegistry()`;
  2. `reconcile()`;
  3. drops `ended` entries whose terminal owner `renderProcess.ownerAlive` reports not
     alive (under the presentation lock). Relay's provider serves only
     `reapRegistry()`'s own defaults;
  4. `pruneLedgers`, `pruneTerminalOwners` and `sweepTemps`.

  `--json` prints
  `{"reaped": string[], "awaiting": string[], "ended": string[], "pruned": n, "swept": n}`.
  Pretty output adds `awaiting <ids>` and `ended <ids>` lines when they are nonempty.

- [ ] **Step 0: Reseed the existing tests.** From this task on, the legacy `familiar
  hook` writer survives only until Task 8. Any existing test here that seeds state
  through `familiar hook` or familiar's `agents.json` is rewritten to seed through
  relay's `applyEvent` and then `observe()` (Task 5). Tests of `hook` itself stay
  untouched until Task 8 deletes them.
- [ ] **Step 1: Write failing `bin-familiar` tests:**
  - `reap prunes a dead relay agent and reconciles even when nothing was pruned`: a
    state change in the snapshot reaches `intent.json` with zero reaped;
  - `reap lists registry agents awaiting their first event`;
  - `reap drops ended evidence for a dead terminal owner`;
  - `reap never emits`: no terminal bytes, asserted through a recording `emitTransition`
    injected via env-free deps;
  - Review Focus 1: an existing `RELAY_STATE_DIR` at 0755 exits 1 with exactly one
    stderr line `familiar: reap: IO_ERROR: …` and leaves `sessions.json` untouched. An
    absent relay state directory reconciles to no sessions and exits 0.
- [ ] **Step 2:** `just test-fast`. Expected: FAIL.
- [ ] **Step 3:** implement. Relay errors become one stderr line, `familiar: reap:
  <code>: <message>`, and exit 1.
- [ ] **Step 4:** `just test-fast`. Expected: PASS.
- [ ] **Step 5:** `just check`, then commit `feat(reap): prune relay, then reconcile presentation`.

### Task 7: Readers: status line and niri

**Files:**
- Modify: `bin/familiar.js` (`statusline` branch, `settleStatusline`),
  `integrations/niri/window.js`, `integrations/niri/signal.js`, `bin/familiar-niri`
- Test: `test/statusline.test.js`, `test/bin-familiar.test.js`,
  `test/niri-window.test.js`, `test/niri-signal.test.js`,
  `test/bin-familiar-niri.test.js`

**Interfaces:**
- Consumes: `readSessions` (Task 2); relay `createProcessOps().ancestors`; `withTerminal`
  (Task 3).
- Produces:
  - **Status line:** it reads `readSessions(paths.sessionsPath).sessions[session_id]`.
    A `faults.has(session_id)` from `makePrepareSprites` sends it down the no-intent
    branch, with one stderr line `familiar: statusline: <fault>` written **after**
    stdout. `settleStatusline` runs inside `withTerminal({ seq: null })`.
  - **niri:** `mapSessionsToWindows(sessions, windows, { ancestors })` defaults
    `ancestors` to relay's `createProcessOps().ancestors`. The bridge reads
    `sessions.json` (`.sessions`) for `pid` and `seq` and watches `sessions.json` plus
    `intent.json`.

- [ ] **Step 0: Reseed the existing tests.** From this task on, the legacy `familiar
  hook` writer survives only until Task 8. Any existing test here that seeds state
  through `familiar hook` or familiar's `agents.json` is rewritten to seed through
  relay's `applyEvent` and then `observe()` (Task 5). Tests of `hook` itself stay
  untouched until Task 8 deletes them.
- [ ] **Step 1: Write failing tests:**
  - `statusline keeps the HUD when its session's visuals fault`;
  - `statusline keeps --with output unchanged when its session's visuals fault`;
  - both write exactly one stderr line and exit 0;
  - `statusline settles only for the recorded terminal owner`;
  - niri: `a session with no intent key gets no slot`, and
    `the bridge resyncs on a sessions.json rename`.
- [ ] **Step 2:** `just test-fast`. Expected: FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `just test-fast`. Expected: PASS.
- [ ] **Step 5:** `just check`, then commit
  `feat(readers): read presentation sessions; fault-safe status line`.

### Task 8: CLI surface cutover and removal of the extracted code

**Files:**
- **ops** (its own worktree, `.worktrees/familiar-relay-cli` in ops): `cli.toml`, the
  familiar rows.
- **Vendored copy:** `tools/cli.toml`, refreshed by `vendored adopt` after ops lands.
- **Modify:**
  - `src/commands.js`, `bin/familiar.js`, `src/install/setup.js`;
  - `src/install/opencode.js`, `bin/familiar-opencode.js`;
  - `integrations/opencode/sprite-plugin.tsx`, `src/bus/paths.js`, `src/bus/proc.js`;
  - `integrations/opencode/sprite-runtime.js` (comment only).
- **Create:** `integrations/opencode/log.js`.
- **Delete:**
  - `src/adapters/`, `src/bus/transaction.js`, `src/bus/prune.js`;
  - `integrations/opencode/{plugin,binding,window,queue,hook}.js` and their `.test.mjs`
    files;
  - `test/{transaction,prune,claude-code,codex,opencode}.test.js`, after porting any
    case still meaningful (below).
- **Test:** `test/setup.test.js`, `test/cli-surface.test.js`, `test/cli-help.test.js`,
  `test/install-opencode.test.js`, `test/install-opencode-cli.test.js`,
  `test/bin-familiar.test.js`, `test/proc.test.js`, `test/deps.test.js`.

**Interfaces:**
- Consumes: Task 5's `observe`; Task 6's `reap`.
- Produces, as `cli.toml` familiar rows (and the identical `src/commands.js` entries):
  - remove `hook` and `setup codex`;
  - add `observe`, with protocol `relay observer: reads one observer envelope on
    stdin` and summary `Project relay's registry into presentation state`;
  - add `setup relay`, with protocol `relay subscribers fragment: stdout is the JSON
    subscribers list in any mode` and summary `Print familiar's relay observer entries`;
  - change `reap`'s summary to `Prune relay's registry and reconcile presentation`.
- Produces, in `src/install/setup.js`:
  - `setupDocument('claude-code', bin)` returns `{ statusLine }` only;
  - `setupDocument('relay', bin)` returns `{ schema: 1, subscribers: [...] }`, with the
    three entries of spec §10:
    - `familiar`: harnesses `['claude-code', 'codex']`, kinds every non-end kind plus
      `reconcile`, `timeoutMs` 2000;
    - `familiar-opencode`: harness `opencode`, kinds
      `['session-start', 'activity', 'idle', 'needs-approval', 'turn-error', 'session-end']`,
      `timeoutMs` 1000;
    - `familiar-teardown`: harnesses `['claude-code', 'codex']`, kinds
      `['session-end']`, `timeoutMs` 200;
    - `argv: [<realpath of bin/familiar>, 'observe']` for all three;
  - `'codex'` throws `unknown setup target`.
- Produces, in `familiar install opencode`: it writes only `tui.json`, and retires
  familiar's legacy server-plugin registrations from `opencode.json` without depending
  on the checkout's directory name. The old installer recorded the absolute
  `<checkout>/integrations/opencode/plugin.js` of whichever clone or worktree ran it.
  - **Matching.** `legacyServerPlugin(entry, { readFile }) → 'familiar' | 'other' | 'unknown'`,
    in `src/install/opencode.js`:
    - an entry that is not an absolute path ending in `/integrations/opencode/plugin.js`
      is `'other'`;
    - for one that is, read `<entry>/../../package.json`. `name: "familiar"` is
      `'familiar'`; any other name is `'other'`. That keeps relay's own
      `…/node_modules/relay/integrations/opencode/plugin.js`, whose package is `relay`;
    - an unreadable or missing `package.json` (the checkout itself was deleted) is
      `'unknown'`.
  - **Effect.**
    - `'familiar'` entries are removed, and the output reports `removed familiar's
      legacy OpenCode server plugin <entry> from <path>`.
    - `'unknown'` entries are kept and reported: `kept <entry>: cannot tell whether it
      is familiar's (no package.json beside it); remove it by hand if so`. The command
      then exits 1 after writing `tui.json`, matching the existing manual-hand-off
      convention.
- Produces, in `src/bus/proc.js`: `ancestors` and its Darwin table-walk helpers are
  removed; `startTimeOf`, `lockHolderAlive`, `ownerAlive`, `pidExists`, `isAlive` and
  `recordOf` stay.

- [ ] **Step 1: Land the ops rows.**
  - Create an ops worktree.
  - Edit `cli.toml`'s familiar rows as above.
  - Run ops's own check, then commit `feat(cli): familiar observe and setup relay rows`.
  - **Stop and ask the user** before merging to ops's default branch and pushing, since
    the adopted-copy check reads ops's `origin/HEAD`. Resume only after it lands.
- [ ] **Step 2:** in this worktree, run ops's `bin/vendored adopt` (locate ops with `tasks root ops`) for
  `cli.toml`. `just test-fast` now FAILS `declared surface equals tools/cli.toml`.
- [ ] **Step 3: Write and update failing tests:**
  - `setup.test.js`: the three documents above. A test validates the `setup relay`
    output with relay's `validateSubscribers`, and that `checkBudget` passes for every
    mapped harness/event plus reconcile, which proves the timeouts fit relay's
    budgets.
  - `install-opencode*`:
    - `tui.json` only;
    - a legacy entry from **this** checkout is removed and reported;
    - `a renamed checkout's legacy entry is retired`: a temp clone at `.../pets-x/`
      whose `package.json` says `familiar` is removed;
    - relay's `node_modules/relay/integrations/opencode/plugin.js` entry is kept;
    - an entry whose checkout is gone is kept, reported and exits 1;
    - a run with no legacy entry leaves `opencode.json` byte-identical.
  - `bin-familiar.test.js`: `familiar observe` end to end through the CLI with a
    reconcile envelope; `familiar hook` is now an unknown-command usage error.
  - `deps.test.js` keeps passing for both launchers.
- [ ] **Step 4:** implement the surface changes, then delete the extracted modules.
  - Before deleting, `grep -rn` for each deleted module path across `src bin
    integrations tools test`: the only hits must be files deleted in this step.
  - Port these to `test/projection.test.js` or `test/observe-run.test.js`:
    - the worktree pin cases from `test/transaction.test.js:735-813`, as projection
      inputs;
    - the project-colour carry cases (`:82-200`), against `prepareEnrichment`.
  - Drop the background-task cases (`:814-850`); they return in Task 10.
  - The sprite imports `logError` from the new `integrations/opencode/log.js`. Its log
    file is unchanged: `$FAMILIAR_STATE_DIR/opencode-plugin.log`.
- [ ] **Step 5:** `just test-fast`. Expected: PASS.
- [ ] **Step 6:** `just check`, then commit
  `feat(cli)!: relay owns hooks; familiar observes`. The body names the removed
  commands.

### Task 9: End to end through relay, and the install guide

**Files:**
- Create: `test/relay-e2e.slow.test.js`, `test/fixtures/fake-harness.mjs`
- Modify: `docs/install.md`, `README.md` (any `familiar hook` or `setup codex` mention)

**Interfaces:**
- Consumes: the whole chain, through relay's real CLI
  (`node_modules/relay/bin/relay.js`).

- [ ] **Step 1: Write the failing test** `test/relay-e2e.slow.test.js`:
  - Use a temp `RELAY_STATE_DIR` (0700) and `FAMILIAR_STATE_DIR`, and a 0600
    `subscribers.json` from `familiar setup relay` output, passed with `--subscribers`.
  - **A real pseudo-terminal and a real harness ancestor.** `tty-familiar.mjs` only
    overrides `stdout.isTTY` and creates no controlling terminal, so it cannot prove
    admission or the `isatty` gate. Instead:
    - Make a temp symlink named `claude` pointing at `process.execPath`. The kernel
      names the process after the path it executed, so `comm` is `claude`.
    - It runs a new fixture, `test/fixtures/fake-harness.mjs`, which reads payload
      lines from a FIFO and runs `relay hook --harness claude-code --subscribers <file>
      <event>` for each, inheriting its stdio.
    - Launch it under util-linux `script`, the way `test/tmux-pty.slow.test.js` launches
      its client: `script -qfc '<tmp>/claude <fixture> <fifo>' <log>`. That gives the
      fake harness a real controlling pty on its fd 1, and both of relay's resolvers
      find it.
    - The terminal bytes are read from `<log>`.
    - Skip with a named reason when not on Linux, or when `script` or `mkfifo` is
      missing, as the tmux test does.
  - The file is `test/relay-e2e.slow.test.js`, in the slow partition, run by `just test`.
  - Drive `SessionStart`, `UserPromptSubmit`, `Notification:permission_prompt`, `Stop`
    and `SessionEnd` fixture payloads through `relay hook --harness claude-code`.
  - After each event, `intent.json[sessionId].current.state` is `idle`, `working`,
    `needs-approval`, `done`, and then absent.
  - The ledger ends with `ended: true`, and the terminal received a final `oscReset()`.
- [ ] **Step 2:** run `just test`. Expected: FAIL until fixtures exist, then PASS.
- [ ] **Step 3: Rewrite `docs/install.md`:**
  - the hook sections now tell you to put `familiar setup relay` output into relay's
    subscribers file and install hooks with `relay install … --retire familiar`. Link
    relay's guide, and mark the steps as the operator cutover;
  - Claude Code settings carry only the status line;
  - OpenCode: `relay install --harness opencode`, plus `familiar install opencode` for
    the sprite;
  - the reap timer and launchd units stay, with `familiar reap` described as prune plus
    reconcile even when nothing is pruned;
  - timer recovery updates files and never emits;
  - the plugin log path line points at relay's log for server-side errors.
- [ ] **Step 4:** `just check`, then `just test`. Expected: PASS.
- [ ] **Step 5:** commit `docs(install): familiar as a relay observer`.

### Task 10: Relay v0.1.1 and the background-work parity

Waits on `relay-fe38b1` (its v0.1.1 release).

**Files:**
- Modify: `package.json`, `package-lock.json`, `test/projection.test.js`

- [ ] **Step 1: Write the failing test**
  `a snapshot holding relay's background-reduced state projects to idle`. Drive relay's
  `applyEvent` with a Claude `Stop` carrying one running background task, then
  `Notification:idle_prompt`, and project. `intent[sid].current.state === 'idle'`.
- [ ] **Step 2:** `just test-fast`. Expected: FAIL on v0.1.0 (`needs-input`).
- [ ] **Step 3:** bump to `#v0.1.1` and `npm install`. Confirm the lockfile's commit is
  the tag's.
- [ ] **Step 4:** `just test-fast`. Expected: PASS.
- [ ] **Step 5:** from a clean clone of this branch with an empty npm cache and SSH
  disabled (`GIT_SSH_COMMAND=false`), run `npm ci` in a temp dir. Expected: it
  installs relay anonymously over https.
- [ ] **Step 6:** `just check`, then commit `build(deps): relay v0.1.1 (background-work reduction)`.
