---
id: fam-b32b3d
title: Tint per-project terminal glass with the familiar identity hue
status: idea
priority: 2
created: 2026-09-05T01:10:50Z
updated: 2026-09-13T09:57:46Z
depends: []
tags: [integration, hue]
---

familiar already says identity owns HUE and paints the terminal backdrop via OSC 11. With terminal backgrounds fully transparent, the backdrop hue disappears; carry it into the glass instead (attenuation-color per window). Needs a channel from familiar to Prism/niri that identifies the window (app-id is shared by all kitty windows; title or niri IPC window id are candidates). Scope after ops goal ops-500adb's terminal seam pieces land.

## Notes

- 2026-09-05T01:57:44Z (main): Direction 2026-09-04: familiar drives glass accent and/or the focus ring (focused vs unfocused), not the base glass hue; base hue comes from Noctalia via Prism (prism-b5cb1e).
- 2026-09-06T22:27:52Z (main): 2026-09-06 revisit: besides tint, familiar state could drive light/glow on the glass (see material lighting spike material-1c5a30)
- 2026-09-13T09:57:46Z (main): prism-28e29c landed the prism side: glass.ring.colorSource=familiar emits accent "ring" in the terminal-glass response blocks, so the filament takes the signal tint live on any window and rests on glass.ring.color otherwise. What remains is familiar sending the per-window accent signal.
