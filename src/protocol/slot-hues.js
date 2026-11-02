import { assertHexColor, hexToHsl, oklchChroma } from './color.js';

// The number of canonical slots. ENGINE POLICY since theme spec-version 2: a theme
// declares roles, never slots, so the slot count and its hues both live here. A slot
// decides a project's colour; which member draws it is the theme's roles and the
// project's pin (src/bus/resolve.js).
export const SLOT_COUNT = 12;

export function assertSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new Error(`slot out of range: ${slot}`);
  }
  return slot;
}

// The twelve canonical slots' colours. FROZEN, and theme-independent by design:
// changing a row changes the colour of every project that hashes or pins to it.
//
// ENGINE POLICY, not theme contract: a theme file never mentions a hue.
export const SLOTS = [
  { slot: 0, hue: 22, sat: 62 },
  { slot: 1, hue: 40, sat: 58 },
  { slot: 2, hue: 55, sat: 42 },
  { slot: 3, hue: 95, sat: 38 },
  { slot: 4, hue: 135, sat: 45 },
  { slot: 5, hue: 172, sat: 48 },
  { slot: 6, hue: 212, sat: 55 },
  { slot: 7, hue: 248, sat: 45 },
  { slot: 8, hue: 272, sat: 45 },
  { slot: 9, hue: 305, sat: 45 },
  { slot: 10, hue: 350, sat: 38 },
  { slot: 11, hue: 0, sat: 6 },
];

// SLOT_COUNT is a written number, not `SLOTS.length`: assertSlot and autoSlot read it
// before any row does. This guard is all that stands between the two and silent
// drift -- the same defect this codebase keeps deleting (ID_RE, GRAPHICS_MARKERS,
// FLOOR). It throws at import time, so a mismatch cannot reach a running familiar.
if (SLOTS.length !== SLOT_COUNT) {
  throw new Error(
    `slot-hues: ${SLOTS.length} hue rows for ${SLOT_COUNT} slots — the two must agree`
  );
}

export function slotSpec(slot) {
  return { ...SLOTS[assertSlot(slot)] };
}

// The grey cutoff and hue boundaries are frozen with the table: changing either reassigns pets.
export const GREY_CHROMA = 0.05;
export const GREY_SLOT = 11;

export function nearestSlotForHue(hue) {
  let nearest = 0;
  let distance = Infinity;
  for (const spec of SLOTS) {
    if (spec.slot === GREY_SLOT) continue;
    const difference = Math.abs(hue - spec.hue) % 360;
    const circular = Math.min(difference, 360 - difference);
    if (circular < distance) {
      nearest = spec.slot;
      distance = circular;
    }
  }
  return nearest;
}

export function slotForColor(hex) {
  assertHexColor(hex);
  return oklchChroma(hex) < GREY_CHROMA
    ? GREY_SLOT
    : nearestSlotForHue(hexToHsl(hex).h);
}
