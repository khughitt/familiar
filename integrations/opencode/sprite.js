// The pure core of the opencode sprite: escape builders, bus lookup, and sizing.
// No I/O, no rendering — every function is a value in, string/number/object out,
// so the whole of the protocol correctness is unit-tested with no terminal.
import { displayedIntent } from '../../src/protocol/intent.js';
import { GRAPHICS_CAPABILITY } from '../../src/render/term/capability.js';

const CAPABILITIES = new Set(Object.values(GRAPHICS_CAPABILITY));

// The controller compares this identity to what the frame writer successfully
// installed. It deliberately contains no bytes: manifest reload, planning, and
// encoding remain owned by frame(). JSON arrays avoid delimiter collisions.
export function programIdentityOf(record, capability) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('sprite: displayed intent must be an object');
  }
  if (!CAPABILITIES.has(capability)) {
    throw new Error(`sprite: unknown graphics capability ${JSON.stringify(capability)}`);
  }
  if (typeof record.state !== 'string' || record.state === '') {
    throw new Error('sprite: displayed intent state must be a non-empty string');
  }
  if (typeof record.sprite?.terminal !== 'string' || record.sprite.terminal === '') {
    throw new Error('sprite: displayed intent terminal sprite must be a non-empty path');
  }
  if (record.animation?.kind === 'static') {
    return JSON.stringify(['static', record.state, record.sprite.terminal, capability]);
  }
  if (record.animation?.kind === 'clips') {
    if (typeof record.motionPolicy !== 'string' || record.motionPolicy === '') {
      throw new Error('sprite: clips intent motionPolicy must be a non-empty string');
    }
    if (typeof record.animation.sha256 !== 'string' || record.animation.sha256 === '') {
      throw new Error('sprite: clips intent animation sha256 must be a non-empty string');
    }
    return JSON.stringify([
      'clips', record.state, record.motionPolicy, record.animation.sha256, capability,
    ]);
  }
  throw new Error(`sprite: unknown animation kind ${JSON.stringify(record.animation?.kind)}`);
}

// a=p: place stored image `id` at one-based (row,col), scaled to c×r cells, fixed
// placement id (re-placing replaces), C=1 (do not advance the cursor). Wrapped in
// ESC7/ESC8 so the visible cursor returns to where OpenTUI left it between frames.
export function placeAt(row, col, id, placementId, c, r) {
  return `\x1b7\x1b[${row};${col}H\x1b_Ga=p,i=${id},p=${placementId},c=${c},r=${r},q=2,C=1\x1b\\\x1b8`;
}

// a=d,d=i: delete THIS placement only, keep the stored image so the next frame can
// re-place without re-transmitting. The explicit d=i is mandatory: a bare a=d defaults
// to d=a and deletes every placement on screen, including other apps' images.
export function hidePlacement(id, placementId) {
  return `\x1b_Ga=d,d=i,i=${id},p=${placementId},q=2\x1b\\`;
}

// a=d,d=I: delete this image's placements AND free its stored data. Teardown only.
export function freeImage(id) {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

// The raw IntentRecord ({ current, expiresAt, after }) for this pid, or null.
export function recordForPid(intent, pid) {
  return intent?.[`opencode:${pid}`] ?? null;
}

// The pose to draw right now, honoring the decay contract (done/error -> after at expiry).
export function displayedForPid(intent, pid, now) {
  return displayedIntent(recordForPid(intent, pid), now);
}

// Fit a pngW×pngH image into availW×availH cells, preserving aspect. A terminal cell is
// roughly twice as tall as wide (the same CELL_ASPECT=2 that box.js's boxFor uses), so the
// image's aspect in CELL units is W / (H/2). This is boxFor's fixed-rows derivation PLUS a
// width clamp: boxFor derives cols for a fixed row count and never bounds width, but the
// sidebar float must also fit the sidebar's width, so cellBox letterboxes within BOTH avail
// dimensions. Width-bound unless that overflows the reserved height, then height-bound.
// Never returns 0.
export function cellBox(pngW, pngH, availW, availH) {
  const aspectCells = pngW / (pngH / 2); // width:height in cell units
  let c = availW;
  let r = Math.round(c / aspectCells);
  if (r > availH) {
    r = availH;
    c = Math.round(r * aspectCells);
  }
  return {
    c: Math.max(1, Math.min(c, availW)),
    r: Math.max(1, Math.min(r, availH)),
  };
}
