# Familiar as a relay consumer

Draft for review, 2026-10-19. Task: `fam-6e8321`. Addendum to the approved parent
design, ops `docs/specs/2026-09-16-relay-design.md` §3 and §6 (Familiar), which stays
authoritative wherever this document is silent. Target: relay `v0.1.0` (tag object
9362dde, commit 0f59660), whose `docs/api.md` is the contract cited below. Engine
baseline: `3ec35ee`.

## Why an addendum

The parent design was approved on 2026-09-16, against familiar `70ae8ed`. Since then
relay and familiar have both moved, and six contracts the migration depends on are no
longer settled by either document:

1. **Background work.** `0a9e0d7` (2026-10-07) made familiar reduce Claude Code's
   `idle_prompt` to `idle` while the last `Stop` reported running background tasks.
   Relay's Claude reducer is the identity, and neither its `Event` nor its `Agent`
   carries `background_tasks`, so an observer cannot recover the count.
2. **Project identity.** `7c6db07` keys familiar's slot hash on
   `remote ?? repositoryRoot ?? cwd`, where `repositoryRoot` is the main worktree.
   Relay keys `Agent.projectKey` on `remote ?? repoRoot ?? cwd`, the worktree's own
   toplevel. For a worktree of a remote-less repository the two keys differ, and
   adopting relay's would give the worktree a different cat from its checkout. The
   pins added by worktree pin inheritance also need `repositoryRoot`.
3. **Codex worker rows.** Relay now publishes `scope: "worker"` rows with a `root`
   (relay `docs/specs/2026-10-15-codex-worker-rows.md`). Today a worker's events
   carry its root's `session_id` and update the root's record.
4. **Terminal versus session process.** Schema 2 publishes the *session* process as
   `Agent.process` (relay `docs/specs/2026-09-23-session-process-handle.md`).
   Familiar paints the *terminal* process, which relay publishes nowhere.
5. **Emission order.** Familiar's emitter compares each event's place in a bus-wide
   counter (`src/bus/seq.js`) with the per-session ledger. Relay's `revision` restarts
   at 1 with each new generation, so it cannot be that counter.
6. **Modules relay does not export.** Relay's package exports only its root and
   `relay/opencode`. Its lock, store and git helpers are internal, and its lock has
   different semantics. The parent design's "extract, then delete" has to be decided
   module by module.

## Decisions

### 1. The observer projects the whole snapshot under familiar's lock

`familiar observe` reads one relay observer envelope on stdin (api.md, Observer and
reconciliation protocol) and runs one projection:

1. Validate the envelope: `schema: 1`, `type` `event` or `reconcile`, and an `event`
   that is present exactly when `type` is `event`. Anything else is an error.
2. For an `event`: resolve that session's terminal and git context **outside** the
   lock (§4, §5).
3. Under `presentation.lock` (familiar's `withLock`, in familiar's state directory):
   - take the next value of familiar's own counter (`events.seq`);
   - read the **newest** snapshot with relay's `readSnapshot()`;
   - read the prior `sessions.json`;
   - project, resolve visuals, and write `sessions.json`, then `intent.json`.

   The snapshot is read after the lock is taken, so a slow, older invocation can never
   overwrite a newer projection. The observer never takes relay's writer lock.
4. After the lock is released: run the terminal emission for an `event` only (§6),
   then the ledger prune and temp sweep, as `familiar hook` does today.

Every invocation projects every agent. A missed or skipped observer is therefore
healed by the next invocation for **any** session, or by `familiar reap`, with no
replay. `REGISTRY_SUPERSEDED`, `CORRUPT_STATE` and `INVALID_SCHEMA` from
`readSnapshot` are errors: nothing is written, and the next invocation retries. A
missing snapshot (`null`) projects to no sessions.

The `seq` taken in step 3 orders emission exactly as it does today. Relay's
`generation` and `revision` are recorded in `sessions.json` for diagnostics only;
they are never compared with ledger evidence. A generation reset needs no special
case: sessions missing from the new snapshot leave the projection, and the counter
keeps rising.

### 2. Familiar keeps its own presentation state, under a new name

`sessions.json` (familiar state directory) replaces familiar's `agents.json`:

```ts
type Sessions = {
  schema: 1;
  registry: { generation: string; revision: number } | null; // snapshot projected
  sessions: Record<string, Session>; // keyed by Agent.sessionId (§7)
};
type Session = {
  sessionId: string; agentId: string; harness: Harness;
  cwd: string; projectKey: string; project: string;
  remote: string | null; repoRoot: string | null; repositoryRoot: string | null;
  projectColor: string | null;
  pid: number; starttime: number; // the terminal process (§4)
  seq: number;                    // the counter value at which this record last changed
  state: State; updatedAt: number;
  backgroundTasks?: number;
};
```

The fields keep today's meanings, so the resolver, status line, niri bridge and ledger
prune change only what they read and where. It gets a new name, not `agents.json`, for
two reasons:
- At cutover, the old hook-written `agents.json` must neither be read as prior
  presentation state nor overwritten. The parent design keeps old state untouched
  until the cutover is verified.
- Relay's registry file has the same basename.

Familiar no longer writes `agents.json` or `agents.lock`, and never deletes them; the
cutover's cleanup step removes them.

### 3. Presentation faults omit visuals; they never remove agents

A session whose identity or assets do not resolve (a pin contradicting its slot, a
member missing from the theme, a deleted sprite) keeps its `sessions.json` record and
is left out of `intent.json`. The observer exits 1 with one stderr line naming the
session and the fault, every time, including for the event's own session. Renderers
already treat an absent intent key as "no cat". The incoming-record abort and the
eviction of `commit()` go away with the registry they protected.

### 4. The terminal is found by the event's own observer

Relay runs observers as children of `relay hook`, which descends from the harness
(relay session-process spec, Terminal process). For an `event`, the observer calls
relay's `adapterFor(harness).resolveTerminalPid({ startPid: process.pid })` and stamps
the terminal's start time with familiar's `startTimeOf`. The result is stored on the
session's record, refreshed by each of its events.

A session enters the projection only through one of its own events: a `reconcile` has
no harness ancestry and no session environment, so it cannot find a terminal. A
registry agent without a familiar record is not projected, and `familiar reap` lists
it as "awaiting first event". When `resolveTerminalPid` returns null (a headless or
daemon-hosted session), that session's event is not admitted and the observer exits 1
naming why. This keeps today's behaviour, including the Codex `--no-daemon` hint from
`6eb99ca`. The session process in `Agent.process` is never painted.

### 5. Visual identity stays familiar's

Familiar's `gitContext` runs on `Agent.cwd` for the event's session, outside the lock,
and its project key, label, remote, roots and project colour decide slots, pins and
hues exactly as today. Relay's `projectKey`, `project` and `remote` are not read for
visuals. A session's context is reused from its prior record while `cwd` is unchanged,
and the project colour is reused while `repoRoot` is unchanged (`carriedProjectColor`
today). A reconcile reuses each record's stored context and runs no git.

Rejected: adopting relay's key. That re-hashes every remote-less worktree away from its
checkout, which is the regression worktree pin inheritance fixed. Whether relay's
`projectKey` should anchor to the main worktree is relay's question, filed as a relay
idea. Until then the two keys may differ, and nothing compares them.

### 6. Emission runs for events only

For an `event`, the observer emits for the event's session. Before the lock it picks
`prev` (that session's prior record) and after it `next` (its new record, or null when
the projection dropped it), then calls today's `emitHookTransition` with the new
`seq`. The `provisional` flag is set on `SessionStart` as now.
- **A reconcile never emits.** It cannot know the session's terminal environment, and
  must not replay bells using its own (parent design §6).
- **A session's terminal that missed an emission** is brought up to date by that
  session's next event. Emission is level-triggered against the ledger, so the next
  event draws the current state.
- **Codex pet convergence** stays on Codex `SessionStart` events, unchanged.

### 7. Keys, workers and OpenCode

- **Intent and session keys are `Agent.sessionId`**, the renderers' existing
  convention (parent design §6). OpenCode's is `opencode:<pid>`, which the TUI sprite
  already looks up. Two projected agents with the same `sessionId` (possible only
  across harnesses) is a collision: neither is projected, and the observer exits 1
  naming both ids.
- **Codex worker rows fold into their root.** Rows with `scope: "worker"` are never
  projected under their own key. The root's projected `state` and `updatedAt` come from
  whichever of the root and its workers has the latest `updatedAt`. That is today's
  behaviour, where a worker's event overwrote its root's record. A worker event emits
  for its root's session. A worker whose root row is absent is not projected. Grouping
  workers visually (one cat per worker) is future work and is not proposed here.

### 8. Background work: relay owns the reduction

The rule from `0a9e0d7` is state reduction, which the parent design's ownership table
gives to relay, and every registry consumer wants it, not only the cat. A
`needs-input` for an agent waiting on its own shell is wrong for a notification too. So:
- **Relay.** File a relay task: carry `background_tasks` from Claude Code's `Stop` (and
  `SubagentStop`) as an optional additive `Agent.backgroundTasks`, carried forward
  across events. Reduce `needs-input` to `idle` while it is above zero, and release it
  as `v0.1.1`. Additive optional fields keep schema 2 (parent design §4).
- **Familiar.** Familiar drops its own reducer and pins the release that carries the
  rule. It keeps a parity test: a snapshot holding the reduced state projects to
  `idle`.

Rejected:
- Familiar re-deriving the count. The observer envelope has no raw payload, and adding
  one would broadcast tool input to renderers, which the parent design forbids.
- Landing on `v0.1.0` with the regression and a follow-up task. That ships a known
  wrong state to the operator cutover.

The familiar implementation proceeds against `v0.1.0`. Only its last step, the pin bump
plus the parity test, waits on the relay release.

### 9. Module disposition

| Familiar module | Outcome |
| --- | --- |
| `src/adapters/{index,payload,claude-code,codex,opencode}.js` | Deleted. `printsPlaceholderCells` and the terminal-hint text move to a presentation table, `src/render/harness.js`, keyed by harness. |
| `src/bus/transaction.js` | Becomes `src/bus/projection.js`: snapshot plus prior sessions in; sessions and intent out. No pruning, no git. |
| `src/bus/prune.js` | Deleted: relay prunes. |
| `src/bus/{lock,store,seq,temp-sweep,paths}.js` | Kept as familiar's own. `paths.js` drops `agentsPath`/`lockPath` and adds `sessionsPath`/`presentationLockPath`. `store.js` remains the intentional local atomic writer for config, receipts, ledgers and scheme. |
| `src/bus/proc.js` | Kept, minus `ancestors`. It holds only the liveness familiar's own locks and ledgers use (`startTimeOf`, `lockHolderAlive`, `ownerAlive`, `pidExists`, `recordOf` for the tty). Agent discovery goes through relay. |
| `src/bus/{identity,resolve,pins,project-color}.js` | Kept (§5). |
| `integrations/niri/window.js` | Walks ancestors with relay's `createProcessOps().ancestors`, from the session record's terminal `pid`. |
| `integrations/opencode/{plugin,binding,window,queue,hook}.js` and their tests | Deleted: relay's `relay/opencode` plugin replaces them. The sprite gets a local `log.js` for what it imported from `binding.js`. |

Relay's lock is not adopted. It needs 0700 parents, which would reject the theme and
`transmit/` directories, and its errors are coded where callers match familiar's text.
Familiar's renderer and presentation locks are presentation infrastructure (parent
design §3).

### 10. Command surface

| Command | After |
| --- | --- |
| `familiar hook` | Removed. Relay owns hooks. |
| `familiar observe` | New. Protocol: one relay observer envelope on stdin. Exit 0 on success; exit 1 with stderr lines on a fault (§3, §4, §7). Relay turns those into `SUBSCRIBER_FAILED` diagnostics and never changes the hook's reply. |
| `familiar reap` | Relay's `reapRegistry()`, then a reconcile projection (§1) even when nothing was pruned, then ledger prune and temp sweep. JSON adds `awaiting`. The existing systemd and launchd units keep working unchanged. |
| `familiar setup claude-code` | Prints only the `statusLine` entry. |
| `familiar setup codex` | Removed. Familiar owns nothing in Codex's hooks. |
| `familiar setup relay` | New. Prints familiar's observer entries for relay's `subscribers.json`: `familiar` (Claude Code and Codex, every non-end kind plus `reconcile`, 2000 ms), `familiar-opencode` (1000 ms) and `familiar-teardown` (`session-end`, 200 ms), with this checkout's absolute launcher. They match api.md's example and fit its budgets. It writes nothing. |
| `familiar install opencode` | Registers only the TUI sprite in `tui.json`. When `opencode.json` still lists familiar's old server plugin, it removes that entry and says so, because relay's installer does not retire it. |

Removing a session (`session-end`) skips the theme load: it only drops the record and
resets the terminal, inside the 200 ms teardown entry. A latency test holds it there.

Familiar's error policy for the status line is unchanged: cosmetic, one stderr line,
exit 0. `observe` deliberately exits 1, so a failure reaches relay's diagnostics rather
than vanishing.

## Out of scope

- Any live configuration: harness settings, `~/.codex/hooks.json`, `subscribers.json`,
  systemd/launchd units and removal of old state. These belong to `hq-539508`. Nothing
  in this task installs a hook or writes outside a test's temporary directories.
- The Mac rollout, which waits on `relay-848c0f`.
- Visual grouping of Codex workers, and moving renderer keys to relay ids.
- OpenCode observer failures are invisible: relay's plugin discards stderr, and observer
  exits never change its hook's exit. Filed as relay feedback, not worked around here.

## Verification

- **Projection tests** (`test/projection.test.js`, replacing `test/transaction.test.js`):
  - overlapping observers cannot regress intent;
  - generation reset;
  - a missed observer healed by another session's event and by `reap`;
  - `session-end` removal and reset;
  - no-prune reconcile;
  - a bad theme omits visuals but keeps the session;
  - collision refusal;
  - worker fold;
  - a schema-1 / superseded snapshot is an error.
- **Parity:** relay's `STATES` equals familiar-theme's vocabulary, and every state
  resolves assets in the bundled theme.
- **Extended suites:** `test/{resolve,state,terminal-target,emit,statusline,
  bin-familiar,bin-familiar-niri,bin-familiar-noctalia}.test.js`, with `bin-familiar`
  covering `observe`, `reap` and `setup relay`. The OpenCode sprite, terminal-cleanup
  and emit-section concurrency tests stay green.
- **End to end:** `relay hook` with a temporary `subscribers.json` naming `familiar
  observe`, run against fixture payloads, produces the expected `intent.json` and
  ledger. The fake harness ancestor follows relay's ancestry fixtures.
- **Install guarantee:** a clean `npm ci` resolves relay from the public tag without
  credentials (already shown for `v0.1.0` in relay's release record; repeated for the
  bumped pin).
