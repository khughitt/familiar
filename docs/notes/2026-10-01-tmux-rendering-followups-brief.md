# tmux rendering follow-ups

Scoping handoff, 2026-10-01. Goal: fam-361178. Members:
fam-70271a, fam-9a7a69, fam-8d0b82. This is a brief, not an approved design.

## Problem

Make the existing tmux rendering path usable without misleading placeholder
colours or waiting for a state transition after attaching a fresh client.
Resolve the three known limits independently; one workaround does not prove
the others are fixed.

## Current behaviour and evidence

- fam-fff8c9 is done. Commit 88504c7 records completion; the implemented
  `docs/specs/2026-09-18-tmux-rendering-design.md` section 7 lists all three limits.
  `docs/install.md` and `docs/surfaces.md` still describe them.
- The historical tmux 3.7c measurement shows a combining mark redraw failure
  only at pane x-offset >0. A plain text reproduction isolates tmux from graphics.
  Its current-version and upstream-issue status remain unverified.
- The historical Claude status-line capture showed RGB placeholders reduced
  to indexed colour 141. `FORCE_COLOR=3` remains explicitly untested.
- Commit b1df1e1 added startup settling. In `bin/familiar.js`,
  `settleStatusline` reads the ledger and returns before probing unless
  `held.provisional` is set. In `src/render/term/emit.js`, `settle` refuses
  changed transport identity. This repair does not handle an ordinary ledger
  belonging to the old attached client.
- `src/render/term/tmux.js` probes the target pane and names the client by
  tty/pid/creation time. `test/emit.test.js` covers changed-client creates and
  settling; `test/tmux-pty.slow.test.js` provides isolated capture/cleanup patterns.

## Constraints

Preserve owner liveness, per-session transmission locking, write-ahead
invalidation, and ordering against transitions and SessionEnd. Do not simulate
an agent state event merely to repaint or replay a bell. Current support is for
a single attached client, with `allow-passthrough all`; multi-client targeting
is unresolved and outside this pass. Use isolated test sockets/processes rather
than repointing host configuration. Upstream posting needs explicit user
instruction after a report is ready.

## Alternatives

1. A targeted `client-attached` hook and small repaint verb can restore the
   image immediately. This is the current lean for fam-8d0b82, subject to a
   design proving pane selection and safe interaction with ledger ordering.
2. Extend the status-line repair to changed transports. It reuses a working
   path, but needs fresh probing and a refresh after attach; the common path
   currently avoids that spawn. It may miss surfaces without placeholder output.
3. Keep next-transition recovery and document the delay. This requires no
   code, but leaves the stated attach outcome unsatisfied.

Do not build a second emitter; the design should reuse the existing locked
graphics/ledger path wherever its semantics hold.

## Unanswered questions

- Does the combining-mark failure persist on a current version, or already
  have an upstream issue/fix? fam-70271a answers with a minimal repro and search.
- Does inherited `FORCE_COLOR=3` preserve the complete image id through Claude
  and tmux? fam-9a7a69 answers with a baseline/treatment capture.
- How does an attach target the correct pane/client without racing end or a
  newer intent? fam-2b371b decides this before implementation.
- Will human review prefer immediate hook-driven recovery or refresh-driven
  repair once these tradeoffs are concrete? The design review settles it.

## Proposed decomposition

- fam-70271a: scoped, P3/s/mid/direct. Recheck the text repro and upstream status;
  prepare a report or record an existing fix/issue.
- fam-9a7a69: scoped, P3/s/mid/direct. Bounded colour experiment and documentation;
  a supported negative result also completes the investigation.
- fam-8d0b82: briefed, remains idea. fam-2b371b is its
  P3/m/high/planned design follow-up; completion notes wake this idea.
- Goal fam-361178 owns these records. No implementation, live experiment,
  host hook installation, or upstream post was performed during scoping.

