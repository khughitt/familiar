# Rendering inside tmux

**Status:** draft, revised three times under review (§8), awaiting review.
**Date:** 2026-09-18
**Task:** fam-fff8c9

Familiar refuses to draw inside tmux. The refusal rests on a claim that a hook
cannot know whether the tmux server permits passthrough. The claim is false, and
the comment that says lifting the refusal is a one-line change is also false.
This spec replaces the refusal with a probe and wraps the animation program so
that it survives tmux.

## 1. What was measured

Kitty 0.48.2 hosting tmux 3.7c, live probes in a real pane, 2026-09-18
(the full record is on fam-fff8c9):

- `tmux display -p -t <pane> '#{allow-passthrough}'` answers from inside a hook,
  using only the socket and pane that `$TMUX` and `$TMUX_PANE` name.
  `#{client_termname}` and `#{client_termtype}` name the outer terminal
  (`xterm-kitty`, `kitty(0.48.2)`), which the inner `TERM=tmux-256color` hides.
- Bare APC (`ESC _ G … ESC \`) is dropped by tmux. The same bytes inside DCS
  passthrough (`ESC P tmux; … ESC \`, inner `ESC` doubled) reach kitty, and the
  image is registered.
- The live graphics path is `encodeKittyProgram()` (`src/render/term/kitty-animation.js`),
  which emits bare APC per chunk. `wrapForTmux()` (`src/render/term/placeholder.js`)
  is reachable only from `transmitPose()`, which `emit()` never runs for graphics:
  `emit()` calls `renderTransition` with capability `NONE` and takes its bytes from
  `encode(...)` instead (`src/render/term/emit.js`).
- A detached server (no client) answers the probe with empty client fields.
- Review reproduced a lifecycle failure the first draft missed: `emit()` takes
  the previous *intent* record as evidence that the terminal holds the image,
  but that record is written by the transaction whether or not `emit()` wrote
  anything. A transition suppressed while the server had no client, followed by
  an attach and a further transition, sends an `update` (`a=a`, `a=f`) for an image
  the terminal never received; the protocol requires an existing image for
  every animation command. Attaching from a fresh Kitty window reproduces the
  same lifecycle against a terminal that has never seen the id.
- The three CLI verbs (`preview`, `theme show`, `theme sheet`) emit through
  `transmit()` in `src/render/term/kitty.js`, not through the encoder or
  `renderTransition`; each APC there is followed by the layout newlines that
  reserve the sprite's rows.
- Wrapping overhead is 11 bytes per command (9 of DCS framing, 2 doubled `ESC`s),
  independent of payload size. A valid static update measured 3,911 bytes
  unwrapped and 5,352 wrapped (131 commands, +37%): the encoding is
  command-heavy, mostly short frame deletions.
- Two further blockers are not familiar's (§7): a tmux 3.7c combining-character
  redraw bug that limits placeholders to full-width panes, and Claude Code
  downgrading the status line to 256 colours under tmux.

## 2. Scope

In: capability detection that asks tmux; wrapping of every APC command the
encoder and the CLI transmitter produce; the three CLI verbs that classify
their own environment; a transmission ledger so lifecycle evidence describes
what a terminal received rather than what the bus intended; the slow test
partition's entry points; the documentation claims. Out: the two upstream blockers (documented as
known limits, follow-ups filed), GNU screen (still refused), Zellij, and any
change to how tint and bell reach tmux (they are sent today under capability
`NONE` and keep being sent; whatever tmux does with them is unchanged by this
work).

## 3. Design

### 3.1 The probe: `src/render/term/tmux.js`

One function, `tmuxFacts(env, { exec = execFileSync } = {})`, returns:

- `null` when `env.TMUX` is unset — the environment is not a tmux pane and the
  classifier proceeds as today.
- Otherwise a frozen record, never a throw:

      { ok: true,  passthrough: 'off' | 'on' | 'all',
        termname: string, termtype: string,
        client: { tty: string, pid: number, created: number } }
      { ok: false, reason: 'no-binary' | 'timeout' | 'exit' | 'no-pane' | 'no-client' }

The probe runs `tmux -S <socket> display-message -p -t <pane> '<format>'` with
the socket from the first comma-separated field of `$TMUX`, the pane from
`$TMUX_PANE`, and a format joining `#{allow-passthrough}`, `#{client_termname}`,
`#{client_termtype}`, `#{client_tty}`, `#{client_pid}` and `#{client_created}`
with tabs. The three `client` fields together identify *which* outer terminal
incarnation is attached, and §3.5 keys the transmission ledger on all three: the
same `xterm-kitty` name from a different Kitty window is a terminal that holds
no image, and the tty pathname alone is not enough — review allocated two
successive ptys and both were `/dev/pts/16`, so a closed and reopened Kitty can
present the same path with an empty image store. `client_pid` is the attaching
`tmux` client process, new per attach, and `client_created` guards that pid
against reuse. A missing
`$TMUX_PANE` is `no-pane`; empty `termname` is `no-client` (a detached server has
nothing to draw on). `ENOENT` is `no-binary`, the timeout is `timeout`, and any
other failure is `exit`. The timeout constant is `TMUX_PROBE_TIMEOUT_MS = 1000`,
its own name for its own deadline, following the convention explained at the top
of `src/render/term/statusfields.js`. The process runs with `stdio`
`['ignore', 'pipe', 'ignore']` so a broken server can never write into the hook's
own output.

The probe is the only place in familiar that talks to tmux. It takes `exec` as a
parameter so unit tests drive it with a fake and never spawn anything.

`wrapForTmux` moves here from `placeholder.js`. It accepts a `Buffer` or a
string and returns the same type; the encoder's commands are ASCII (control
fields and base64), so the conversion is lossless. `placeholder.js` re-exports
nothing; its callers import from `tmux.js`.

### 3.2 The classifier: `graphicsCapability(env, tmux)`

`graphicsCapability` stays pure and keeps its string return. It gains a second
argument, the probe's result, with the same discipline the first already has:

- `env.TMUX` set and `tmux === undefined` throws a `TypeError` — the caller forgot
  the probe. The current test that pins "no default env" gets a sibling.
- `env.TMUX` unset: `tmux` is ignored and the current rules apply, including the
  `screen|tmux` `TERM` prefix refusal (a remote shell inside tmux, or GNU screen,
  has no passthrough story).
- `tmux.ok === false` → `NONE`.
- `tmux.passthrough !== 'all'` → `NONE`. `on` is refused, not degraded: `on` drops
  passthrough while the pane is invisible, so a level-triggered hook firing in a
  background window would leave kitty holding the previous state's image — a cat
  that shows "working" when the session is waiting for approval. Familiar's rule
  since the virtual-placement change is that the cat is never stale; a terminal
  that cannot honour that gets no cat, the same rule that gives a plain `TERM`
  nothing rather than a substitute.
- Otherwise the outer terminal is classified from the client fields, not from the
  inherited environment: `termname === 'xterm-kitty'` or `termtype` starting with
  `kitty` → `ANIMATION`; `termname === 'xterm-ghostty'` or `termtype` starting
  with `ghostty` → `STATIC`; anything else → `NONE`. The inherited environment is
  wrong evidence here: a tmux server's environment is the one its first client
  started with, and the client attached now may be a different terminal.

`MULTIPLEXER_MARKERS` stays exported with its current single member; its meaning
becomes "variables that require the probe" rather than "variables that refuse".
The environment-scrubbing fixtures in `test/bin-familiar.test.js` keep reading it.

### 3.3 Wrapping: an encoder option

`encodeKittyProgram(program, { id, placement, lifecycle, readFrame, frame })`
gains `frame`, a function applied to every command buffer before concatenation,
defaulting to identity. `emit()` passes `wrapForTmux` when the terminal's probe
result is `ok`. Wrapping is per command, not around the whole program: tmux
discards a DCS whose body exceeds its input buffer limit (1 MiB in `input.c`),
and a program is up to 8 MiB.

`ENCODED_BYTES_MAX` and the `encodedBytes` metric describe the unwrapped
program. They are properties of the theme pack, checked by
`preflightKittyPrograms` at install time with no terminal in sight, and a limit
that changes with the transport would make preflight lie. The wrapped stream is
`encodedBytes + 11 × commands` for the current APC encoding (nine bytes of DCS
framing per command plus the two doubled `ESC`s; base64 payloads contain none),
and `commands` is already a reported metric. That overhead is not small for
small programs — a 131-command static update grows 37% — but it is exact and
computable from the metrics, so preflight can state the wrapped size without
knowing the transport. The spec records this so nobody later "fixes" the metric
to count wrapped bytes.

### 3.4 Where the probe runs

- Hook path: `terminalTarget()` (`src/render/term/target.js`) already produces
  `{ path, env }` per platform. It gains `tmux: tmuxFacts(env, { exec })` on both
  platforms, with `exec` injectable, and `emit()` reads `terminal.tmux`. On Darwin
  the hook's own environment stands in for the agent's, as it does for `env`
  today; `$TMUX` and `$TMUX_PANE` are inherited down the same chain.
- CLI verbs (`preview`, `theme show`, `theme sheet` in `bin/familiar.js`): each
  currently calls `graphicsCapability(process.env)`; each becomes
  `graphicsCapability(process.env, tmuxFacts(process.env))`. `theme show` already
  explains a `NONE` on stderr; when the probe result is present it appends it —
  `tmux allow-passthrough=on, needs all` or `tmux probe: no-client` — so a person
  with the wrong setting learns the setting, not just "none".
- The CLI transmitter, `transmit(png, { rows, frame })` in `kitty.js`, gains the
  same `frame` option as the encoder, applied to each APC command and never to
  the `rows` newlines that follow them: those newlines are layout for tmux's own
  grid and must stay outside passthrough. The three verbs pass `wrapForTmux`
  when the probe result is `ok`. Without this, relaxing the classifier would
  turn the verbs' output from "no art, with a warning" into bare APC that tmux
  drops, with the warning gone.
- `renderTransition` gains `tmux` beside `env` and `transmitPose` keys its wrap
  branch on `tmux?.ok` (`env.TMUX` alone is no longer sufficient evidence); the
  comment claiming the refusal is a one-line change goes.

### 3.5 The transmission ledger and the emission critical section

Lifecycle evidence changes source. Today `emit()` decides `create` versus
`update` from `priorIntent`, the bus's previous intent for the session, which
records what familiar *meant* to show, not what any terminal received. The
ledger records the latter, and the rules below make it impossible for the
ledger and the terminal to disagree in a direction that skips a render.

**Sequence.** The bus transaction, under the bus lock, stamps every event it
processes with the next value of one counter for the whole bus,
`stateDir/events.seq`, read and rewritten atomically inside the locked section
and returned to the hook — for SessionEnd too, whose `next` is `null` but whose
`seq` is real. The counter is deliberately not derived from the agent record:
eviction (`commit()` evicts and later readmits live sessions) and SessionEnd
followed by a resume both remove the record while the ledger below survives,
and a restarted per-session counter would sit below the ledger's `seq` and
suppress every event until it caught up. A bus-wide counter is never removed,
and because it is monotonic across all sessions, comparing two events of one
session by it is still "which is newer". If the counter file is missing (a
wiped state directory with ledgers left behind, or first run), the transaction
seeds it from the highest `seq` found in `stateDir/transmit/*.json`, else `0`,
so a ledger can never outrank the counter. The agent record also carries the
`seq` of its latest event, for diagnostics only. Commit order is therefore
total, and every later decision is "which event is newer", never "which hook
ran first".

**Per-session critical section.** The hook, after the transaction returns and
after the tmux probe (a spawn, so outside every lock), acquires
`stateDir/transmit/<name>.lock` with the existing `withLock` and holds it
across the whole of: read the ledger, decide, write the terminal, publish. The
bus lock is never held at the same time (the transaction has returned), so the
two cannot deadlock, and sessions do not wait on each other's pty writes. This
also ends an existing defect: two hooks of one session writing the same pty
concurrently interleave their escape bytes today. `emit()` becomes async for the
lock; `emitHookTransition` and `main` already are.

The lock is taken with `staleMs: Infinity`. `withLock`'s default reclaims a lock
whose mtime is ten seconds old *even when the holder is alive* — sized for the
bus transaction's few hundred `stat()`s, and wrong for a section that contains a
pty write of up to 8 MiB to a terminal that may be slow to drain. Review
reproduced a second holder entering while the first was still inside. Dead-holder
recovery (`isAlive` on the token's pid and starttime) stays, so a hook killed
mid-write releases the section. The retry budget is sized to wait 30 seconds
(`retries: 1500` at the default 20 ms), inside Claude Code's 60-second hook
budget; a waiter that exhausts it throws, the transaction having already
committed, and the next event repairs the terminal — the design is
level-triggered, so a lost render costs one transition, never a wrong state.

`<name>` is `ledgerName(sessionId)`: the id with every character outside
`[A-Za-z0-9_-]` replaced by `_`, truncated to 40 characters, then `-` and the
first 16 hex digits of the id's SHA-256. `parsePayload` accepts any non-empty
string as a session id, so `../agents` is a valid id today and would resolve a
naive `stateDir/transmit/<sessionId>.json` to `stateDir/agents.json` — a hook
overwriting the bus. The sanitised prefix keeps the file readable to a person;
the hash keeps distinct ids distinct after sanitising; and the function asserts
its result contains no path separator and resolves inside `transmit/`. Both the
ledger file and the lock file use it.

**Ledger entry.** One file per session, `stateDir/transmit/<name>.json`,
written with `writeJsonAtomic`:

    { seq, pid, starttime,
      held: null | { transport, capability, id, intent },
      ended: boolean }

`seq` is the newest event this section has processed for the session. `held`
is what the terminal holds, or `null` when nothing is known to be held.
`ended` is the SessionEnd tombstone. A missing file is `{ seq: 0, held: null }`.

**Protocol**, for an event with sequence `S`, agent `next` (or `null`), and the
transport `T` the probe implies (`direct`, or
`tmux:<client.tty>:<client.pid>:<client.created>`):

1. Read the entry `E`. If `E.seq >= S`, return `superseded` and touch nothing:
   a newer event already owns the terminal, whether it ran before this hook
   acquired the lock or this hook is an old one arriving after SessionEnd.
2. SessionEnd: write `{ seq: S, held: null, ended: true }`, then write
   `oscReset()` to the terminal. The reset needs no evidence; if it fails the
   tombstone is already down, which is the correct state. Return `ended`.
3. Decide graphics. Evidence is valid when `E.held` is not `null`,
   `E.pid`/`E.starttime` equal `next`'s, and `E.held.transport === T`.
   `lifecycle` is `update` only when the evidence is valid **and** the
   capability is `ANIMATION`; it is `create` otherwise, including for every
   `STATIC` transition with valid evidence. That preserves the rule the current
   `emit()` encodes: the update encoder emits animation and frame-composition
   commands, which a static-only terminal such as Ghostty does not accept, so
   Ghostty always receives a fresh `create`. A graphical transmission is needed
   when the capability is not `NONE`, motion policy is not `off`, and either the
   evidence is invalid or `E.held.intent` differs from the current intent in the
   fields `emit()` compares today. Presentation bytes (tint, bell) are computed
   exactly as now.
4. No graphics needed: write `{ ...E, seq: S }` — `held` is preserved, this is
   the **unchanged** case, and three identical hooks in a row leave `held`
   intact and send zero graphics bytes — then write the presentation bytes, if
   any. Return `unchanged`. Capability `NONE` (detached, probe failed, plain
   `TERM`) and `transmitSprite: false` take this path too: nothing on any
   terminal changed, so the evidence stands; when the same client re-attaches
   the image it holds is still the one the ledger describes.
5. Graphics needed: open the fd and apply the tty gate first; on failure write
   `{ ...E, seq: S }` and return `suppressed` (no byte reached a terminal, the
   evidence stands). Then **write-ahead**: `{ seq: S, pid, starttime, held: null }`.
   If that write fails, throw before any terminal byte. Then write the bytes.
   Then **publish** `{ seq: S, pid, starttime, held: { transport: T, capability,
   id, intent } }`. Return `transmitted`.

**Why this is safe.** Between write-ahead and publish the entry says nothing is
held; a partial terminal write, a crash, or a failed publish all leave that
state, and the next event does a `create`, which under Kitty replaces whatever
the id currently holds. The reviewer's case — ledger says `working`, terminal
receives `needs-input`, persistence fails, next `working` hook — now ends with
`held: null` at the failure and a `create` at the next hook, not a skip. The
"A emits, B emits, B records, A records" interleaving cannot occur: terminal
write and publish are in one critical section, and if the older event reaches
the lock second it is `superseded` by `seq` and writes nothing. An outstanding
hook after SessionEnd meets the tombstone's higher `seq` and writes nothing.

**Pruning.** Ledger files whose session has no agent record and whose
`pid`/`starttime` is dead are removed wherever agent records are pruned today
(the transaction's `pruneDead` pass and `familiar reap`). Tombstones live until
then.

`priorIntent` leaves the transaction's result and `emit()`'s signature; the
comment in `transaction.js` that says lifecycle evidence must come from the
serialized transaction is replaced by one pointing here: evidence comes from the
one section that touches the terminal.

This closes the reproduced failure by construction: a suppressed emission
leaves `held` untouched but never claims a transmission that did not happen,
and a fresh Kitty window — or a closed and reopened one on the same pty path —
changes the client incarnation, so the transport differs and the next
transition is a `create`. It also closes a latent pre-existing case
outside tmux — an unreadable `/proc/<pid>/environ` on one hook followed by a
readable one — that could already send `update` first.

What it does not do: an attach with no further transition stays blank, because
no hook fires. The cat appears at the next transition. This is a documented
limit (§7.3); a tmux `client-attached` hook driving a repaint is a follow-up,
fam-8d0b82, not part of this change.

### 3.6 The slow partition gets entry points

`tools/test-runner.mjs` already partitions on `*.slow.test.js`, but nothing runs
the slow half: `npm test`, `just test`, the push gate and CI all run `fast`.
This change adds `"test:slow": "node tools/test-runner.mjs slow"` to
`package.json`, makes the justfile's `test_cmd` run both modes in turn (its
own comment promised exactly this when slow tests appeared; `fast_cmd` stays
fast), and has `.github/workflows/test.yml` install `tmux` and run the slow
partition after the fast one. The pty test skips with a printed reason when
`tmux` or `script` is absent, except under `CI=true`, where absence is a
failure: a skipped transport test on the one machine that exists to run it
would be the silent fallback this spec is deleting.

### 3.7 Documentation

- `docs/surfaces.md`: replace "passthrough is a user setting the hook cannot
  verify" with the requirement (`set -g allow-passthrough all`, the pane's outer
  terminal must be Kitty or Ghostty) and the known limits of §7.
- `docs/ref/kitty-graphics-protocol.md`: same correction in the Claude Code
  notes; add the probe format and the per-command DCS rule to the protocol notes.
- `docs/install.md`: the terminal claim paragraph names tmux as supported with
  the §7 limits; the checklist for unclaimed combinations drops "inside tmux"
  and gains a one-line tmux checklist (`allow-passthrough all`, full-width
  pane, verify colour depth of the status line, expect the cat at the first
  transition after attaching).

## 4. Error handling

Nothing in this change can strand bytes on the agent's terminal or block a hook:

- The probe is bounded by its timeout and never throws for an operational
  failure; every failure is a `NONE` with a reason, and tint and bell still go
  out exactly as they do today for an unreadable `/proc` environment.
- A programming error (probe result missing when `$TMUX` is set) throws before
  any fd is opened, in keeping with `emit()`'s "byte plan complete before the fd"
  rule.
- Wrapping happens inside `encode()`, before `emit()` opens the fd, so a program
  that fails limits fails unwrapped and unwritten as it does now.
- Evidence is nulled before the first terminal byte and restored only after the
  last; every failure between the two leaves `held: null`, and the next event
  does a `create`. A failed write-ahead throws before any terminal byte. A
  failed publish after a complete terminal write costs one redundant `create`
  later, never a skipped render.
- A hook that dies holding the session lock is released by `withLock`'s holder
  liveness check, as the bus lock is today.

## 5. Testing

- `test/tmux.test.js` (fast): the probe with a fake `exec` — argument shape
  (`-S`, `-t`, format), each `ok: false` reason, the `null` case; `wrapForTmux`
  on Buffer and string, ESC doubling, type preservation.
- `test/kitty.test.js`: the classifier's new rules — throw without probe result
  under `$TMUX`; `off`/`on`/failed → `NONE`; `all` + kitty fields → `ANIMATION`;
  `all` + ghostty fields → `STATIC`; `all` + unknown outer terminal → `NONE`;
  inherited `KITTY_WINDOW_ID` under `$TMUX` with a non-kitty client → `NONE`
  (the inherited environment loses).
- `test/kitty-animation.test.js`: `frame` applied to every command;
  `encodedBytes` unchanged by `frame`.
- `test/emit.test.js`: with a terminal whose probe result is `ok`, every APC in
  the written bytes is inside DCS passthrough and none is bare; with `ok: false`,
  no graphics bytes and tint still written. The lifecycle regression: a
  consistent `prev`/intent with no ledger entry → `create`, never `update`; a
  ledger entry with `transport: 'tmux:/dev/pts/5'` and a probe now reporting
  `/dev/pts/9` → `create`; the same transport → `update`; a `direct` entry and a
  tmux probe → `create`.
- `test/emit.test.js`, the critical section, with injected `lock`, ledger
  `read`/`write`, and terminal ops that record every call in order:
  - Ordering: a graphical event produces exactly read → open → isatty →
    write-ahead (`held: null`) → terminal writes → publish → close, and the
    write-ahead precedes the first terminal byte.
  - Forced interleavings: events `S=1` (`working`) and `S=2` (`needs-input`) for
    one session, run in both lock orders under a fake lock that hands out the
    section in the order the test dictates. Both orders end with `held.intent`
    at `needs-input` and the last graphics on the terminal at `needs-input`; in
    the "2 then 1" order event 1 returns `superseded` and writes nothing.
  - Tombstone: SessionEnd at `S=3`, then an outstanding `S=2` → `superseded`,
    tombstone intact, no bytes.
  - Unchanged: after a `create`, three identical hooks (`S=2,3,4`) each return
    `unchanged`, `held` is byte-identical to the published one, `seq` advances,
    zero graphics bytes.
  - Failure with an existing entry: `held.intent.state === 'working'`; the
    `needs-input` terminal write throws mid-stream → entry is
    `{ seq, held: null }`; the next `working` hook → `create`, not `unchanged`.
  - Publish failure after a complete terminal write → entry has `held: null`;
    the next hook → `create`.
  - Suppressed: tty gate fails → `held` preserved, `seq` advanced, no bytes.
  - Real lock: two `emit()` calls for one session started concurrently in one
    process against the real `withLock` on a temporary state dir both complete,
    and the ledger and the fake terminal agree.
  - Long write: with an injected clock advanced past ten seconds while the first
    holder is alive inside the section, a second acquirer does not enter
    (`staleMs: Infinity`); with `isAlive` reporting the holder dead, it does.
  - Static terminal: two successive transitions under `STATIC` with a populated,
    valid ledger entry both encode `create`; the same two under `ANIMATION`
    encode `create` then `update`.
  - Pathname reuse: `held.transport` is `tmux:/dev/pts/16:4242:1758200000` and
    the probe now reports `/dev/pts/16` with a different `client.pid` → `create`;
    identical three fields → `update`.
- `test/transmit-ledger.test.js` (or beside the ledger module): `ledgerName`
  on `../agents`, `/etc/passwd`, an id with a `\0`, a 300-character id, and two
  ids differing only in a character the sanitiser replaces: every result is a
  single path component inside `transmit/`, the two near-duplicates differ, and
  the traversal ids never resolve to `agents.json`, `intent.json`, or anything
  outside `transmit/`.
- `test/kitty.test.js` (transmitter): `frame` wraps every APC and the trailing
  newlines stay outside the framing.
- `test/bin-familiar.test.js`: the spawned CLI under a fake `tmux` placed first
  on `PATH` that prints a canned probe line. With `all` and kitty fields,
  `preview` emits one wrapped APC group per state and no bare APC; with `on`,
  `theme show` prints the reason on stderr and no APC. This is the CLI-side
  proof that a classifier change did not open a bare-APC path.
- Transaction: `seq` comes from `events.seq`, increments per event under the
  bus lock across sessions, and is returned for SessionEnd. Eviction followed by
  readmission of the same session, and SessionEnd followed by a resume, both
  continue above the ledger's `seq` and are not `superseded`. A missing counter
  with ledgers present is seeded above their highest `seq`. Reap and the prune
  pass remove a ledger file whose session is gone and whose pid is dead, and
  leave one whose agent is alive.
- `test/tmux-pty.slow.test.js`: a real tmux server on a temporary socket
  (`-f /dev/null`, `allow-passthrough all`), attached through a pty provider
  (`script`), a pane running a command that copies a fifo to its stdout. Three
  assertions: bare APC written to the fifo does not appear in the client stream;
  wrapped APC appears with the passthrough framing removed; with
  `allow-passthrough off` the wrapped APC does not appear. A fourth run puts
  `familiar preview --state idle` in the pane with the fixture theme and asserts
  the client stream holds the image's APC unframed. Skips, with the reason
  printed, when `tmux` or `script` is absent, and fails instead under `CI=true`.
  This is the test that would have caught the "one-line change" comment.
- `test/bin-familiar.test.js`: `theme show` under a fake `$TMUX` with an injected
  probe result prints the tmux reason.

## 6. Alternatives rejected

- **Probe inside `graphicsCapability`.** Hides a subprocess in a function every
  test calls as pure; the `env = process.env` default was deleted for the same
  reason.
- **Accept `allow-passthrough on`.** Works while the pane is visible and silently
  serves a stale state otherwise. See §3.2.
- **Wrap in `emit()` over the encoder's `bytes`.** The command boundaries are
  gone by then; wrapping the whole program in one DCS exceeds tmux's input limit.
- **Count wrapped bytes against `ENCODED_BYTES_MAX`.** Makes a pack limit depend
  on the transport and preflight unable to check it. See §3.3.
- **Classify from the inherited environment under tmux.** The server's
  environment describes its first client, not the attached one.
- **Always `create` under tmux instead of a ledger.** Avoids the ledger but
  retransmits every frame on every transition, and leaves the pre-existing
  `update`-without-`create` case outside tmux in place. The ledger is the same
  amount of state, kept truthfully.
- **Keep `priorIntent` and add a "transmitted" flag to it.** The intent file
  belongs to `commit()`, which resolves what to show; a flag written by a
  different process at a different time would make one file carry two truths
  with two writers.
- **Publish the ledger under the bus lock after `emit()`.** Review found the
  hole: two lock acquisitions let a terminal write and its publication
  interleave with another hook's, so the ledger can name A while the terminal
  holds B. Locking the JSON is not locking the terminal.
- **Hold the bus lock across the terminal write.** Correct, but serializes every
  session on the machine behind one pty write of up to 8 MiB. The per-session
  lock gives the same guarantee for the only writers that share a terminal.
- **One shared ledger file.** Needs the global lock for every update; one file
  per session lives entirely under that session's lock.
- **Wall-clock ordering (`updatedAt`) instead of `seq`.** Two hooks committed
  within the same millisecond are unordered; a counter under the bus lock is
  not.
- **A per-session counter on the agent record.** Review found it restarts at
  `1` after eviction or SessionEnd while the ledger keeps counting; a hundred
  events would be suppressed. The bus-wide counter survives record removal.
- **The default `withLock` staleness.** Reclaims a live holder after ten
  seconds; a pty write can take longer. `staleMs: Infinity` with dead-holder
  recovery is the existing option built for exactly this.
- **The raw session id as a filename.** `parsePayload` accepts `../agents`.

## 7. Known limits (documented, not fixed here)

1. tmux 3.7c does not redraw a combining character written into a pane whose
   x-offset is greater than 0 until a full refresh (`screen_write_combine()` merges
   it into the grid; the follow-up tty write never happens). Kitty then receives
   placeholders without their row/column diacritics and paints row 0 of the image
   in every row. Rendering therefore works only in full-width panes until tmux
   fixes it. Plain-text repro: `printf 'e\xcc\x81'` in a right-hand pane shows `e`
   until refresh. Follow-up: fam-70271a (report upstream with the repro).
2. Claude Code emits the status line at 256 colours under tmux even with
   `COLORTERM=truecolor`; the placeholder foreground `38;2;R;G;B` arrives as
   `38;5;141`, and Kitty would read image id 141. Untested workaround:
   `FORCE_COLOR=3` in the tmux environment. Follow-up: fam-9a7a69 (verify the
   workaround and document it).
3. Attaching a client (or a new Kitty window) with no transition afterwards
   shows nothing until the next transition: no hook fires on attach. Follow-up:
   fam-8d0b82 (a tmux `client-attached` hook driving a repaint verb).
4. Several clients attached to one session with different outer terminals: the
   probe reports whichever client tmux picks for the target pane; the ledger
   keys on that client's tty. Not addressed.

## 8. Revision history

- 2026-09-18, review 1: added the transmission ledger (§3.5) after the reviewer
  reproduced `update` without `create` across a detach/attach; added wrapping in
  the CLI transmitter (§3.4) since the verbs bypass the encoder; added the slow
  partition's entry points (§3.6); corrected the wrapping overhead from "<1.01×"
  to `11 × commands` (§3.3) against a measured 3,911 → 5,352 bytes.
- 2026-09-18, review 3: the sequence is a bus-wide counter that survives
  eviction and SessionEnd; the transmission lock disables age-based
  reclamation; `update` requires `ANIMATION` capability, preserving the Ghostty
  rule; the transport identity carries `client_pid` and `client_created`, not
  the tty path alone; ledger and lock filenames go through `ledgerName`, which
  cannot escape `transmit/`.
- 2026-09-18, review 2: rewrote §3.5. The ledger's publication moved into one
  per-session critical section with the terminal write, ordered by a `seq` the
  bus transaction assigns; evidence is nulled by a write-ahead before the first
  terminal byte; an unchanged hook preserves `held` instead of deleting it;
  SessionEnd leaves a tombstone that supersedes outstanding hooks. Forced-
  interleaving tests added to §5.
