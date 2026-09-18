# Rendering inside tmux

**Status:** draft, revised once under review (§8), awaiting review.
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
        termname: string, termtype: string, clientTty: string }
      { ok: false, reason: 'no-binary' | 'timeout' | 'exit' | 'no-pane' | 'no-client' }

The probe runs `tmux -S <socket> display-message -p -t <pane> '<format>'` with
the socket from the first comma-separated field of `$TMUX`, the pane from
`$TMUX_PANE`, and a format joining `#{allow-passthrough}`, `#{client_termname}`,
`#{client_termtype}` and `#{client_tty}` with tabs. `clientTty` identifies *which*
outer terminal is attached; §3.6 keys the transmission ledger on it, because
the same `xterm-kitty` name from a different Kitty window is a terminal that
holds no image. A missing
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

### 3.6 The transmission ledger

Lifecycle evidence changes source. Today `emit()` decides `create` versus
`update` from `priorIntent`, the bus's previous intent for the session, which
records what familiar *meant* to show, not what any terminal received. The
ledger records the latter.

`emit()` returns, alongside the bytes written, what it transmitted:
`{ id, lifecycle, capability, transport, intent }`, or `null` when no graphics
went out (capability `NONE`, `transmitSprite` off, the tty gate, a failed open).
`transport` is `direct` outside tmux and `tmux:<clientTty>` inside it. The hook
persists that under the bus lock in `transmissions.json` (a new path beside
`intent.json` in `src/bus/paths.js`), keyed by session and stamped with the
agent's `pid` and `starttime`; a `null` result removes the session's entry, and
SessionEnd removes it too. Dead-process entries are pruned the way `agents.json`
is. The write is a second, short lock acquisition after `emit()` returns, with
no process spawn inside it, so the transaction's rule against holding the lock
across a spawn stands.

The transaction reads the ledger in the same locked section that reads the
prior intent today and hands `emit()` `priorTransmission` in place of
`priorIntent`. `emit()`'s binding evidence becomes: the ledger entry exists, its
`pid`/`starttime` match `prev`, and its `transport` equals the transport the
current probe result implies. Only then is `update` possible; any other case is
`create`. The intent comparison that decides whether a transition is graphical
at all runs against the ledger entry's `intent`, which is the intent the terminal
actually holds.

This closes the reproduced failure by construction: a suppressed emission
leaves no entry, so the first transition after an attach is a `create`; a fresh
Kitty window changes `clientTty`, so the transport differs and the next
transition is a `create`. It also closes a latent pre-existing case outside
tmux — an unreadable `/proc/<pid>/environ` on one hook (capability `NONE`, tint
only) followed by a readable one — that could already send `update` first.

What it does not do: an attach with no further transition stays blank, because
no hook fires. The cat appears at the next transition. This is a documented
limit (§7.3); a tmux `client-attached` hook driving a repaint is a follow-up,
fam-8d0b82, not part of this change.

### 3.7 The slow partition gets entry points

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

### 3.8 Documentation

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
- The ledger is written only from a successful `writeAllSync`; a partial write
  throws before the ledger records anything, so the next transition is a
  `create`, which is the safe direction. A ledger write that fails leaves the
  previous entry or none — again `create` next time.

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
  tmux probe → `create`. `emit()` returns `null` transmission when the tty gate
  fails and a populated one after a successful write.
- `test/kitty.test.js` (transmitter): `frame` wraps every APC and the trailing
  newlines stay outside the framing.
- `test/bin-familiar.test.js`: the spawned CLI under a fake `tmux` placed first
  on `PATH` that prints a canned probe line. With `all` and kitty fields,
  `preview` emits one wrapped APC group per state and no bare APC; with `on`,
  `theme show` prints the reason on stderr and no APC. This is the CLI-side
  proof that a classifier change did not open a bare-APC path.
- Transaction and hook: the ledger round-trips — written after a successful
  emit, read under the lock on the next event, removed on SessionEnd and for a
  dead pid.
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

- 2026-09-18, review 1: added the transmission ledger (§3.6) after the reviewer
  reproduced `update` without `create` across a detach/attach; added wrapping in
  the CLI transmitter (§3.4) since the verbs bypass the encoder; added the slow
  partition's entry points (§3.7); corrected the wrapping overhead from "<1.01×"
  to `11 × commands` (§3.3) against a measured 3,911 → 5,352 bytes.
