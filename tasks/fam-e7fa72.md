---
id: fam-e7fa72
title: Push familiar intent to niri as per-window signals from familiar-niri watch
status: done
priority: 2
size: m
complexity: mid
process: direct
owner: fam-e7fa72
created: 2026-09-24T18:15:30Z
updated: 2026-09-24T18:21:35Z
started: 2026-09-24T18:16:11Z
completed: 2026-09-24T18:21:35Z
depends: []
tags: [integration, hue]
source: material-930c55
model: "claude-opus-5-5[1m]"
agent: claude-code/claude-opus-5-5
---

Why: niri-material ships per-window material signals (set/pulse/clear-window-signal, material-a54d89) and Prism's ring colorSource=familiar emits accent "ring" (prism-28e29c), but nothing in familiar calls set-window-signal, so every terminal ring rests on the same manual color (material-068639). familiar-niri watch already joins agents.json to niri windows into niri-windows.json; it is the natural single writer of the familiar slot too.

Mapping (niri-material docs/materials/2026-09-02-material-signals-design.md, section 2, "The familiar bridge ..."), per session's displayed intent:
- current.color.base -> --accent; tag "<themeId>/<identity.member>" (themeId from config.yaml, e.g. cats/tuxedo), which niri window rules match with signal-tag.
- urgency none -> quiet (active when state is working), notice -> notice, demand -> demand; motion verbatim.
- expiresAt/after -> --ttl-ms (expiresAt - now; if already past, send `after` as the slot) with --after-level/--after-motion from `after`.
- a transition into done or error -> pulse-window-signal --kind done|error, after the set (a pulse needs a slot).
- motionPolicy applied before sending: off -> static and no pulses; reduced -> flash->pulse, pulse->breathe.
- Aggregation: several sessions in one window write one `familiar` slot. The winner is the highest level, ties to the most recently updated session; motion, accent, tag, and ttl come from the winner. Pulses are per session transition, most recent last.
- A window that no longer hosts any session gets clear-window-signal. A clear for a window that has closed is expected and not an error (the slot died with the window).
- On startup, reconcile from niri's own state: clear the familiar slot on any window whose `signal.sources` includes "familiar" but which hosts no session, so a restarted bridge never leaves a stale hue.
- Only send when a window's computed slot changes (the watch already dedups niri-windows.json the same way); resync also on intent.json changes, via the existing directory watch.

Constraints: no compositor knowledge under src/ (the mapping lives in integrations/niri/, the process in bin/familiar-niri, as window.js does today). Fail loudly on a rejected set/pulse (stderr), never on a closed window's clear.

Done when: (1) unit tests in test/niri-window.test.js (or a sibling) cover the level/motion mapping, motionPolicy, aggregation, ttl/after, pulse-on-transition, clear-on-leave, and startup reconcile, with the niri call injected; (2) a live check shows two familiar sessions in two kitty windows with different ring hues via `niri msg -j windows` (signal.accent and sources include familiar), and a done transition pulses. Then note the result on material-930c55.

Where to look: bin/familiar-niri, integrations/niri/window.js, src/protocol/intent.js (displayedIntent, presentation table), src/config.js (themeId, motionPolicy), test/niri-window.test.js; niri side: `niri msg set-window-signal --help`.

## Notes

- 2026-09-24T18:16:11Z (fam-e7fa72): started
  provenance: {"harness_session":"claude-code:043fdd81-3649-4354-a9c1-0d8726289ef8","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-09-24T18:21:35Z (fam-e7fa72): done
  provenance: {"harness_session":"claude-code:043fdd81-3649-4354-a9c1-0d8726289ef8","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-09-24T18:21:35Z (fam-e7fa72): familiar-niri watch now writes one familiar signal slot per niri window (identity hue accent, urgency level, policy-adjusted motion, ttl decay, done/error pulses, clears by niri's record); 16 planner tests; live sync on niri-material showed three terminals in three distinct hues, then cleared
  provenance: {"harness_session":"claude-code:043fdd81-3649-4354-a9c1-0d8726289ef8","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
