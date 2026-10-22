---
id: fam-b55f34
title: "Themes with any number of members: drop the fixed twelve-slot requirement"
status: idea
priority: 2
created: 2026-10-22T23:58:01Z
updated: 2026-10-22T23:58:01Z
depends: []
tags: []
source: "forge-0e720e brainstorm, 2026-10-22"
agent: claude-code
---

Why: the owner wants themes with more members than twelve (plan for about 50 long-term; about 35 projects are active today, so twelve pets means many projects share one) and also fewer (a finished theme of 5). Raised while designing forge's new theme-creation flow (forge-0e720e), whose target character count the user can set; tracked here because the limit lives in the theme contract and the engine, not in forge.

Where twelve is fixed today:
- familiar-theme src/protocol/slots.js: SLOT_COUNT = 12, a contract constant; theme/pack.js refuses a pack that leaves any of the twelve slots without a member, because any project can hash to any slot.
- familiar src/protocol/slot-hues.js: twelve frozen hue rows that must equal SLOT_COUNT; nearestSlotForHue and slotForColor map a project colour onto them.
- familiar src/bus/identity.js autoSlot: fnv1a32(projectKey) % SLOT_COUNT; src/bus/resolve.js picks slot from project colour, a pin, or that hash.
- Consumers that assume twelve: fam-053b0d (project colour as the single source, mapped to the nearest of twelve slot hues), the lookout dashboard and fam-10b09d's identity feed.

To decide: whether hue and member decouple (a member chosen per project from a theme of N, hue from the project colour) or slots become per-theme; how an existing project keeps its pet when a theme grows or shrinks; and the contract version change for familiar-theme and the packs (cats, elements).
