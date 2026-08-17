// COLOUR ESCAPES, PRINTABLE WIDTH, AND THE UNTRUSTED-STRING BOUNDARY.
//
// This is the codebase's first SGR emitter. placeholder.js writes escapes too, but those are
// GRAPHICS escapes -- a different protocol with a different failure mode -- so nothing there
// is reusable here.
//
// WHY width() IS PESSIMISTIC. The HUD's 60-column budget is a correctness bound, not
// tidiness: a line that wraps pushes the cat's placeholder cells onto a row the transmitted
// image does not cover, and the image breaks. We cannot ask the terminal how it renders an
// Ambiguous-width glyph -- kitty.js:20-30 explains why no round trip is possible. External
// fields may contain ANY printable Unicode, so a hand-picked table of only Familiar's glyph
// blocks cannot be a hard bound: Ω is Ambiguous and sits outside them. ASCII therefore counts
// as one and every non-ASCII scalar as two. That overcounts narrow and combining Unicode, but
// it cannot undercount a value that would wrap the line.
//
// WHY sanitize() LIVES HERE. Same reason, one layer down. The HUD draws strings that came
// from the filesystem, and a terminal reads some of those bytes as INSTRUCTIONS. width() and
// sanitize() are two halves of one question -- how wide does this land, and what does it do
// on the way -- and separating them would let a caller ask the first without the second.
const ESC = '\x1b';

export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;

export function fg(hex) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(hex));
  if (!match) {
    throw new Error(`sgr: fg expects #rrggbb, got ${JSON.stringify(hex)}`);
  }
  const n = parseInt(match[1], 16);
  return `${ESC}[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

const SGR = /\x1b\[[0-9;]*m/g;

export const strip = (s) => String(s).replace(SGR, '');

// ONE SAFE PRINTABLE LINE. Applied to every external field without exception.
//
// The newline rule comes FIRST and is a truncation, not a replacement: a name containing a
// newline is a name whose remainder we have no row for. Keeping only the first line is the
// only answer that preserves the four-slot invariant (hud.js) -- replacing the newline with
// a dot would silently splice two unrelated path components into one label.
//
// Everything else in C0, DEL, and C1 becomes a single visible question mark. That deliberately
// includes TAB: a tab is a cursor movement, and this line's width is load-bearing.
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;
// ASCII, DELIBERATELY: one hostile byte becomes exactly one visible, one-column character.
const REPLACEMENT = '?';

export function sanitize(value) {
  if (value === null || value === undefined) return '';
  const [first = ''] = String(value).split(/\r\n|\r|\n/);
  return first.replace(CONTROLS, REPLACEMENT);
}

export function width(s) {
  let n = 0;
  for (const ch of strip(s)) n += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  return n;
}
