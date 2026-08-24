# macOS terminal promotion gate — evidence

**Status:** matrix recorded before execution, per §11.6 of the macOS core support
design. No cell has run. No claim in this file is promoted until its row says `pass`.

**Provenance**

- Capture branch: `spike/macos-terminal-gate`, disposable and never merged. Pushed to
  `origin` only as transport to the test machine and deleted from the remote afterwards;
  the tester pushed nothing.
- Runbook: `docs/ref/2026-08-24-macos-terminal-gate-handoff.md` on that branch.
- Evidence per cell: one `<terminal>-<agent>.jsonl` trace plus six reap artifacts
  (`reap-session.json`, `reap-pid`, `reap-identity`, `reap-target`, `before-reap`,
  `reap`, `after-reap`).
- Host, OS, terminal, agent, and Node versions: pending.
- Terminal device (`rdev`) and asserted capability per run: pending.

## 1. Matrix

Under Node 22. A cell passes only when every state that adapter exposes was exercised
with its byte log verified and its tester observation recorded, the normal exit produced
`OSC 111`/`OSC 112`, and an abnormally terminated session was proven removed by
`familiar reap`.

| Agent | States exercised | Kitty | Ghostty |
| --- | --- | --- | --- |
| Claude Code | six | pending | pending |
| Codex | four; no `needs-input`, no `error` | pending | pending |
| OpenCode | five; no `needs-input` | pending | pending |

Node spot-check, installed Node, Claude Code / Kitty only: pending.

## 2. Capability `none` negative control

Required for any promotion (§11.3). Claude Code: pending. OpenCode: pending.

## 3. Background and daemon appendix

- Probe 1, induced background subtree: pending.
- Probe 2, headless fail-closed: pending.

## 4. Generated configuration

First live exercise of `familiar setup codex`. All six configured Codex events fired:
pending.

## 5. What this evidence does not cover

- macOS 14 with a live agent. CI runs macOS 14 without agents; this capture runs a
  later macOS. The gap §2 records stays open.
- Frame-by-frame graphics sequence. The verifier checks image identity across every
  chunk, key grammar, the `boxFor` placement box, and chunk count against the encoder;
  it deliberately does not reimplement the encoder's chunking rules, because a copy of
  the encoder is not an independent check of it.
- OpenCode graphics depth. Its renderer plans and encodes inside `sprite-runtime.js`, so
  its records carry no planned frame count or placement; its graphics are checked for
  image identity, key grammar, and placement-envelope order only.
- The event-to-state mapping, which each adapter's unit tests cover in CI. This gate
  checks that the state the emitter acted on produced the right bytes on the right device.
- tmux, Intel Macs, macOS 13, and terminals other than Kitty and Ghostty.
