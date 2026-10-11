---
id: fam-10b09d
title: "Expose the identity feed for remote clients: hue, colour ramp, member art and animation per agent, readable over the tailnet"
status: todo
priority: 2
size: s
complexity: mid
process: planned
created: 2026-10-11T17:52:46Z
updated: 2026-10-11T17:52:46Z
depends: []
tags: [identity]
agent: claude-code/claude-fable-5-1
---

Piece of ops-cb50a8 (typed exchanges; phone inbox). The phone inbox colours each entry by the asking agent's familiar hue and shows its character; it runs on another tailnet host and cannot read ~/.local/state/familiar or ~/.config/familiar/themes directly.

What exists: intent.json already carries, per agent, identity (projectKey, project, slot, member, label), state, urgency, and resolved hex colours (shadow, base, light, highlight, backdrop) plus sprite and animation; slot hues are fixed in src/protocol/slot-hues.js, the ramp in src/theme/ramp.js, members and pose PNGs in each theme's theme.yaml, and the theme contract in the familiar-theme package.

Design questions, small: which of these a remote client needs (colours and member id at least; art as URLs or as the familiar-theme package the client installs); one read-only contract (a JSON document plus asset paths) a tailnet service can serve, or a package export the inbox service imports; how an agent in the inbox that familiar has not seen gets a hue (autoSlot from projectKey is deterministic, so the client can compute it); whether the relay migration (fam-6e8321) changes the feed's source. Nothing here decides the inbox's own styling; forge holds the art idea.

Done: a reviewed short spec naming the contract, a reviewed plan, children per step; the feed serves at least colours, member, label and state for every live agent, from one command or export.
