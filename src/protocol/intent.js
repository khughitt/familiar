// Runtime decay and presentation policy. ENGINE, not contract: nothing a theme
// file declares depends on how long a `done` badge lingers. Split out of
// state.js so familiar-theme carries only the state vocabulary.
import { assertState } from 'familiar-theme';

export const TTL_DONE_MS = 8000;
// A failure deserves longer to be noticed than a success.
export const TTL_ERROR_MS = 30000;

const TTL = { done: TTL_DONE_MS, error: TTL_ERROR_MS };

// Identity owns color and character. State owns urgency and motion — it never
// repaints the identity hue. An erroring ginger tabby is still ginger.
const PRESENTATION = {
  idle: { urgency: 'none', motion: 'breathe' },
  working: { urgency: 'none', motion: 'pulse' },
  'needs-input': { urgency: 'demand', motion: 'pulse' },
  'needs-approval': { urgency: 'demand', motion: 'flash' },
  error: { urgency: 'demand', motion: 'flash' },
  done: { urgency: 'notice', motion: 'static' },
};

export function isTransient(state) {
  return assertState(state) in TTL;
}

export function ttlFor(state) {
  return TTL[assertState(state)] ?? null;
}

export function decayTo(state) {
  if (!isTransient(state)) throw new Error(`state is not transient: ${state}`);
  return 'idle';
}

export function presentationFor(state) {
  return { ...PRESENTATION[assertState(state)] };
}

// THE DECAY CONTRACT, in one place: render `current`; if `expiresAt` is set, arm
// a one-shot timer and, on fire, render `after`. A renderer decides WHEN to swap,
// never WHAT to swap to — the resolver already decided that.
//
// It lives in the portable core, not in a renderer, because every future surface
// (a terminal, a status bar, `familiar status`) needs it and must not re-derive
// it. Some renderer environments cannot import an ES module at all, so their
// integration carries a DELIBERATE duplicate of this logic. That is precisely
// why the contract is defined and tested here, rather than only existing
// inside one renderer's code.
export function displayedIntent(record, now) {
  if (!record) return null;
  if (record.expiresAt === null || record.expiresAt === undefined) return record.current;
  return now >= record.expiresAt ? record.after : record.current;
}
