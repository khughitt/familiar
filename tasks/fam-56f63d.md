---
id: fam-56f63d
title: Fix fitFrame's partial-alpha colour corruption in the Codex reducer
status: done
priority: 1
size: s
owner: main
created: 2026-09-02T00:59:00Z
updated: 2026-09-02T01:01:05Z
depends: []
tags: [codex, render]
---

Outcome: `fitFrame` reduces partially transparent source art to its true colour, so a Codex spritesheet built from native-RGBA masters no longer shows invented hues (orange art reducing to green).

Acceptance evidence: A unit test builds a source block mixing opaque and partial-alpha samples of a single hue and asserts the reduced pixel keeps that hue; it fails on the current reducer and passes after the fix. Fully opaque input reduces byte-identically to today, proven by the existing suite. Repository gate green.

Cause: `fitFrame` sums STRAIGHT (un-premultiplied) colour over every non-transparent sample but divides by `covered = alpha/255`, an alpha-weighted denominator. When mean alpha < 255 the quotient exceeds the true channel value; `out` is a `Uint8Array`, so the assignment wraps modulo 256 instead of clamping. The largest channel wraps first, which is why pure orange (255,140,0) emerges green.

Evidence: familiar-forge `elements-v1-native-alpha/round-02` `ember__s0__explicit` is pure orange with zero green pixels at any alpha in both the raw candidate and the compiled master, yet its 192x208 reduction is 2.80% green; binarizing the same art alpha first drops it to 0.00%. Recorded in familiar-forge `docs/art/lessons.md`.

## Notes

- 2026-09-02T01:00:54Z (fix-fitframe-partial-alpha): fitFrame now averages colour alpha-weighted (premultiplied numerator over the alpha sum) instead of dividing straight colour by an alpha-weighted denominator. Fully opaque input is byte-identical: both forms reduce to the plain mean. Two unit tests added in test/codex-pets.test.js; the first reproduced the reported artifact exactly, reducing pure orange (255,140,0) to (84,186,0) before the fix. npm test: 854 pass, 0 fail, 5 skipped.
- 2026-09-02T01:01:05Z (fix-fitframe-partial-alpha): fitFrame averages colour alpha-weighted; pure orange no longer reduces to green
