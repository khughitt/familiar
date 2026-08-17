// THE BOX. How many character cells the cat occupies.
//
// Two processes have to agree on this number and they never speak to each other: the HOOK
// creates the virtual placement (`c=`, `r=`), and the STATUS LINE prints the placeholder cells.
// If they disagree the cat is cropped, or floats in a field of empty cells. So neither of them
// gets to decide -- they both call this.
//
// The height is the THEME's (rows: in theme.yaml, carried on intent.sprite.rows) — the caller
// passes it and this file no longer owns a default. The WIDTH is derived from the sprite,
// because the sprite's aspect ratio is not ours to choose and every member has its own.
import { ROW_MIN, ROW_MAX, pngSize } from 'familiar-theme';

export { pngSize };

// A terminal cell is about twice as tall as it is wide. This is an approximation and it is
// allowed to be one: kitty scales the image to FIT the box preserving aspect, so an imperfect
// cell aspect costs a column of air beside the cat, never a cropped cat. Getting it roughly
// right is what makes the cat fill its box; getting it exactly right is not possible without a
// round trip to a terminal we cannot read from (emit() writes to another process's fd 1).
const CELL_ASPECT = 2;

// PNG dimensions from the IHDR, after validating the container without decoding its pixels.

// The cell box for a sprite. `rows` comes from the caller (the theme's number); `cols` follows
// the sprite's aspect.
//
// All six poses of a member share ONE canvas (the art compiler bottom-anchors them onto it), so
// this returns the same box for every state of a member -- which is exactly what makes the pose
// swappable underneath cells that were printed once and never touched again. If the poses ever
// stop sharing a canvas, this silently starts returning a different box per state, the printed
// cells stop matching the placement, and the cat gets cropped. The art compiler's canvas test is
// what keeps that from happening.
export function boxFor(png, rows) {
  // NO DEFAULT, ON PURPOSE. A default here is how the height nobody chose became the height
  // everybody saw: the emitter called boxFor(png) and silently got 4 while the theme said 12.
  // The height belongs to the theme and the caller passes it; an omission is a bug to
  // surface, not a number to invent. Validated against pack.js's OWN bounds because an
  // out-of-range rows would reach kitty as a broken r=, and Math.round((undefined*2*w)/h) is
  // NaN, not a throw — the silent path this refuses.
  if (!Number.isInteger(rows)) {
    throw new Error(`box: rows must be a whole number, got ${JSON.stringify(rows)}`);
  }
  if (rows < ROW_MIN || rows > ROW_MAX) {
    throw new Error(`box: rows must be between ${ROW_MIN} and ${ROW_MAX} inclusive, got ${rows}`);
  }
  const { w, h } = pngSize(png);
  const cols = Math.max(1, Math.round((rows * CELL_ASPECT * w) / h));
  return { cols, rows };
}
