---
id: fam-b32b3d
title: Tint per-project terminal glass with the familiar identity hue
status: done
priority: 2
created: 2026-09-05T01:10:50Z
updated: 2026-09-24T18:28:22Z
completed: 2026-09-24T18:28:22Z
depends: []
tags: [integration, hue]
model: "claude-opus-5-5[1m]"
---

familiar already says identity owns HUE and paints the terminal backdrop via OSC 11. With terminal backgrounds fully transparent, the backdrop hue disappears; carry it into the glass instead (attenuation-color per window). Needs a channel from familiar to Prism/niri that identifies the window (app-id is shared by all kitty windows; title or niri IPC window id are candidates). Scope after ops goal ops-500adb's terminal seam pieces land.

## Notes

- 2026-09-05T01:57:44Z (main): Direction 2026-09-04: familiar drives glass accent and/or the focus ring (focused vs unfocused), not the base glass hue; base hue comes from Noctalia via Prism (prism-b5cb1e).
- 2026-09-06T22:27:52Z (main): 2026-09-06 revisit: besides tint, familiar state could drive light/glow on the glass (see material lighting spike material-1c5a30)
- 2026-09-13T09:57:46Z (main): prism-28e29c landed the prism side: glass.ring.colorSource=familiar emits accent "ring" in the terminal-glass response blocks, so the filament takes the signal tint live on any window and rests on glass.ring.color otherwise. What remains is familiar sending the per-window accent signal.
- 2026-09-24T18:15:39Z (main): The remaining work here (familiar sending the per-window accent signal) is now scoped as fam-e7fa72; this idea can close when it lands.
- 2026-09-24T18:28:22Z (main): done
  provenance: {"harness_session":"claude-code:043fdd81-3649-4354-a9c1-0d8726289ef8","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-09-24T18:28:22Z (main): Remaining work (familiar sending the per-window accent signal) landed as fam-e7fa72 in 188c602: familiar-niri watch sets each window's familiar slot in the identity hue, which Prism's ring colorSource=familiar draws
  provenance: {"harness_session":"claude-code:043fdd81-3649-4354-a9c1-0d8726289ef8","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
