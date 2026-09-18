# Rendering inside tmux

**Status:** draft, awaiting review.
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
- Two further blockers are not familiar's (§7): a tmux 3.7c combining-character
  redraw bug that limits placeholders to full-width panes, and Claude Code
  downgrading the status line to 256 colours under tmux.

## 2. Scope

In: capability detection that asks tmux; wrapping of every APC command the
encoder produces; the three CLI verbs that classify their own environment;
tests; the documentation claims. Out: the two upstream blockers (documented as
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

      { ok: true,  passthrough: 'off' | 'on' | 'all', termname: string, termtype: string }
      { ok: false, reason: 'no-binary' | 'timeout' | 'exit' | 'no-pane' | 'no-client' }

The probe runs `tmux -S <socket> display-message -p -t <pane> '<format>'` with
the socket from the first comma-separated field of `$TMUX`, the pane from
`$TMUX_PANE`, and a format joining the three fields with a tab. A missing
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
that changes with the transport would make preflight lie. Wrapping adds a
bounded overhead — nine bytes of framing per command plus one byte per `ESC`,
and base64 payloads contain none — so the wrapped stream is under 1.01× the
checked size. The spec records this so nobody later "fixes" the metric.

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
- `renderTransition` gains `tmux` beside `env` and `transmitPose` keys its wrap
  branch on `tmux?.ok` (`env.TMUX` alone is no longer sufficient evidence); the
  comment claiming the refusal is a one-line change goes.

### 3.5 Documentation

- `docs/surfaces.md`: replace "passthrough is a user setting the hook cannot
  verify" with the requirement (`set -g allow-passthrough all`, the pane's outer
  terminal must be Kitty or Ghostty) and the known limits of §7.
- `docs/ref/kitty-graphics-protocol.md`: same correction in the Claude Code
  notes; add the probe format and the per-command DCS rule to the protocol notes.
- `docs/install.md`: the terminal claim paragraph names tmux as supported with
  the §7 limits; the checklist for unclaimed combinations drops "inside tmux"
  and gains a one-line tmux checklist (`allow-passthrough all`, full-width
  pane, verify colour depth of the status line).

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
  no graphics bytes and tint still written.
- `test/tmux-pty.slow.test.js`: a real tmux server on a temporary socket
  (`-f /dev/null`, `allow-passthrough all`), attached through a pty provider
  (`script`), a pane running a command that copies a fifo to its stdout. Three
  assertions: bare APC written to the fifo does not appear in the client stream;
  wrapped APC appears with the passthrough framing removed; with
  `allow-passthrough off` the wrapped APC does not appear. Skips, with the reason
  printed, when `tmux` or `script` is absent. This is the test that would have
  caught the "one-line change" comment.
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
3. Several clients attached to one session with different outer terminals: the
   probe reports whichever client tmux picks for the target pane. Not addressed.
