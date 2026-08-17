import { SLOT_COUNT, assertSlot } from 'familiar-theme';

// The twelve canonical slots' colours. FROZEN, and theme-independent by design:
// a project pinned to slot 0 is a ginger tabby under `cats` and an ember under
// `elements` -- same colour, different character, no code change.
//
// ENGINE POLICY, not theme contract: a theme file never mentions a hue. Kept out
// of familiar-theme so the contract package stays "what a theme must contain".
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

// SLOT_COUNT used to be `SLOTS.length`. The split severed that derivation, so
// this is the only thing standing between the two numbers and silent drift --
// the same defect this codebase keeps deleting (ID_RE, GRAPHICS_MARKERS, FLOOR).
// It throws at import time, so a mismatch cannot reach a running familiar.
if (SLOTS.length !== SLOT_COUNT) {
  throw new Error(
    `slot-hues: ${SLOTS.length} hue rows for ${SLOT_COUNT} slots — the two must agree`
  );
}

export function slotSpec(slot) {
  return { ...SLOTS[assertSlot(slot)] };
}
