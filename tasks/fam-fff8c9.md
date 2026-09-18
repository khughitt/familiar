---
id: fam-fff8c9
title: "Render inside tmux: relax the passthrough refusal and wrap the animation program"
status: todo
priority: 2
size: m
complexity: mid
process: planned
created: 2026-09-18T11:05:35Z
updated: 2026-09-18T15:35:06Z
depends: []
tags: [tmux, terminal]
agent: "claude-code/claude-opus-5[1m]"
spec: docs/specs/2026-09-18-tmux-rendering-design.md
---

## Why

familiar refuses tmux by design (src/render/term/capability.js: MULTIPLEXER_MARKERS and the
screen|tmux TERM prefix → NONE) on a premise that is false, so people who run Claude Code in a
tmux pane inside kitty get no cat although the transport works when the escapes are wrapped.

## Done when

- Capability detection asks tmux instead of refusing it: with `$TMUX` set, the outer terminal
  comes from `tmux display -p -t <pane> '#{client_termname}' / '#{client_termtype}'` (the inner
  `TERM=tmux-256color` hides it) and the pane's `#{allow-passthrough}` decides whether graphics
  are sent at all. The pure classifier stays testable: the tmux probe is a separate step whose
  result is data the classifier consumes, never a hidden subprocess inside `graphicsCapability`.
- Every APC chunk of the animation program (encodeKittyProgram → apc()) is wrapped in DCS
  passthrough when the target is a tmux pane; the wrapped size counts against, or is explicitly
  exempted from, ENCODED_BYTES_MAX, and the spec says which.
- `allow-passthrough all` is the documented requirement; the spec settles whether `on` is
  accepted with a warning or refused (`on` drops escapes while the pane is invisible, so a
  level-triggered hook firing in a background window leaves kitty holding a stale image).
- Tests drive a real tmux pty (skipped, not faked, when `tmux` is absent) and prove: bare APC is
  dropped, wrapped APC reaches the outer pty; a pane with passthrough off yields NONE; the probe
  failing (no tmux binary, timeout) yields NONE, never a hang in the hook.
- docs/surfaces.md, docs/ref/kitty-graphics-protocol.md and docs/install.md replace "the hook
  cannot verify passthrough" with the real requirement and list blockers 2 and 3 below as known
  limits; the emit.js "one-line change" comment goes.

## Where to look

- src/render/term/capability.js — the refusal; src/render/term/target.js — where the agent's env
  (and so `$TMUX`, `$TMUX_PANE`) comes from via /proc.
- src/render/term/emit.js — `emit()` calls `renderTransition` with capability NONE, so
  `transmitPose()`/`wrapForTmux()` never run for live graphics; the bytes that matter come from
  `encode(...)` at the bottom of `emit()`.
- src/render/term/kitty-animation.js — `apc()` and `payloadCommands()` build the chunks.
- src/render/term/placeholder.js — `wrapForTmux()` (string in, string out; the encoder emits
  Buffers).
- bin/familiar.js — three CLI call sites (`preview`, `theme show`, sheet) classify
  `process.env`; they need the same probe.
- test/kitty.test.js, test/emit.test.js, test/bin-familiar.test.js — pin the current refusal and
  the marker lists; they change with it.

## Investigation (2026-09-18, kitty 0.48.2 → tmux 3.7c, live probes in a real pane)

Three independent blockers stand between familiar and tmux; only the first is ours.

1. familiar refuses tmux by design (src/render/term/capability.js: MULTIPLEXER_MARKERS and the
   screen|tmux TERM prefix → NONE). The documented reason — "a hook cannot verify that the user's
   tmux server permits passthrough" (docs/surfaces.md, docs/ref/kitty-graphics-protocol.md) —
   is false: `tmux display -p -t <pane> '#{allow-passthrough}'` answers from inside the hook via
   $TMUX, and `#{client_termname}`/`#{client_termtype}` give the OUTER terminal (xterm-kitty,
   kitty(0.48.2)) that the inner TERM=tmux-256color hides. The emit.js comment that relaxing the
   refusal is "a one-line change" is also wrong: the live graphics path is encodeKittyProgram()
   (kitty-animation.js apc()), which emits bare APC; wrapForTmux() is only reachable from
   transmitPose(), which emit() never runs (renderTransition is called with capability NONE).
   Every APC chunk of the animation program must be wrapped in DCS passthrough.
   Measured: bare APC → dropped by tmux; wrapped → reaches kitty and the image is registered.
   Recommend `allow-passthrough all`, not `on`: `on` drops escapes while the pane is invisible
   (tty_client_ready / TTY_CTX_INVISIBLE_PANES), so a level-triggered hook firing in a
   background window would leave kitty holding a stale image.

2. tmux 3.7c bug (upstream, not ours): in a pane with x-offset > 0, screen_write_combine()
   merges a combining character into the grid but the follow-up tty write of the combined cell
   never happens; at x-offset 0 it does (`\b` + combined cell). Kitty therefore receives bare
   U+10EEEE placeholders with no row/column diacritic → row 0 of the image in every row (the
   "ears" pattern). A full redraw (refresh-client, resize) emits complete graphemes and the cat
   appears. Reproduces with plain text: printf 'e\xcc\x81' in a right-hand pane shows "e"
   until refresh. Evidence: SIGUSR2 server log, tmux-server-*.log — combine at 24,17 (right
   pane) has no write after it; combine at 24,9 (full-width pane) is followed by
   `/dev/pts/13: e\314\201`. Report upstream with that repro; until fixed, tmux rendering only
   works in full-width panes.

3. Claude Code downgrades the status line to 256 colours under tmux: `familiar statusline`
   emits 38;2;R;G;B but the pane grid holds 38;5;141 for every placeholder run (80/80 repaints),
   with COLORTERM=truecolor set in Claude Code's own environment. Kitty would read image id 141.
   Not familiar's code; untested workaround: FORCE_COLOR=3 in the tmux environment.

Scope: blocker 1 only. Blockers 2 and 3 gate the support claim and belong in the docs as known
limits, not in this change.

## Notes

- 2026-09-18T11:11:01Z (main): scope: scoped; todo p2 size m complexity mid process planned — investigation is complete and bounded to blocker 1, but the probe design (effectful tmux query feeding a pure classifier), wrap placement vs ENCODED_BYTES_MAX, and on-vs-all acceptance need a reviewed spec
- 2026-09-18T11:15:48Z (tmux-render): Design spec drafted at docs/specs/2026-09-18-tmux-rendering-design.md (commit 8faddc9 on branch tmux-render, worktree .worktrees/tmux-render); follow-ups fam-70271a (upstream tmux bug) and fam-9a7a69 (FORCE_COLOR=3) filed as ideas
- 2026-09-18T11:15:48Z (tmux-render): parked (waiting on user, review): Review the design spec; on approval run writing-plans against it in .worktrees/tmux-render
  provenance: {"harness_session":"claude-code:4034d5b3-2c73-46fd-a1e9-7e05d71a212d","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-09-18T11:32:45Z (tmux-render): Spec revised after review 1 (5afab87): transmission ledger replaces priorIntent as lifecycle evidence, CLI transmit() wraps too, slow partition gets npm/just/CI entry points, overhead corrected to 11 x commands; follow-up fam-8d0b82 (repaint on client-attached)
- 2026-09-18T15:28:52Z (tmux-render): Spec revision 2 (c58f3a7): ledger publication and terminal write share one per-session critical section ordered by a bus-assigned seq; write-ahead nulls evidence before the first terminal byte; unchanged hooks preserve held; SessionEnd tombstone supersedes stragglers
- 2026-09-18T15:35:06Z (tmux-render): Spec revision 3 (9644f86): bus-wide events.seq counter, staleMs Infinity on the transmit lock, update only under ANIMATION (Ghostty rule kept), transport keyed on client tty+pid+created, ledgerName() for safe filenames
