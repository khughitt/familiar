// Unicode placeholders: the image as TEXT.
//
// THE PROBLEM THIS SOLVES. A normal kitty placement (a=T) is anchored to the screen and
// is INDEPENDENT OF THE TEXT GRID -- it is drawn over whatever cells it covers, and it
// outlives any repaint of those cells. That is fine when we own the screen (a shell,
// where the cat lands in scrollback and output flows below it) and catastrophic when we
// do not: claude-code is a fullscreen TUI that owns and continuously repaints the
// screen, so the cat floats on top of text it never reserved, forever. Reserving cells
// from OUTSIDE the app that draws them is not possible, and no key in the graphics
// protocol changes that.
//
// The placeholder mechanism inverts the ownership. The image is transmitted and given a
// VIRTUAL placement (U=1) -- which draws nothing, occupies nothing, and is merely a
// prototype. The image only appears where a specific character is printed: U+10EEEE,
// carrying combining diacritics that encode its row and column, and a foreground colour
// that encodes the image id. Those are ORDINARY TEXT. Whoever draws the screen lays them
// out, wraps them, scrolls them and erases them like any other characters -- and the
// image follows, "even though they know nothing about the graphics protocol" (kitty's
// own words, graphics-protocol.rst).
//
// So the cat stops being an overlay and becomes a glyph. Text flows around it because
// text flows around characters. That is the entire trick.
//
// The cost: the host application must pass through the private-use codepoint, the
// combining marks, and an SGR foreground colour, and must not mangle their width.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHUNK = 4096;
export const PLACEHOLDER = '\u{10EEEE}';

// The row/column encoding is a TABLE, not an algorithm: kitty's diacritics are the
// combining marks of general category Mn, canonical combining class 230, from Unicode
// 6.0.0, minus a hand-excluded set. Index i in this list is the diacritic meaning `i`.
// We read kitty's shipped file rather than transcribing it -- a 297-entry table copied
// by hand is a table with a typo in it, and the typo would show as an image one row out.
const DIACRITICS_FILE = fileURLToPath(
  new URL('../../../vendor/rowcolumn-diacritics.txt', import.meta.url)
);

let cachedDiacritics = null;

export function diacritics(read = readFileSync) {
  if (cachedDiacritics) return cachedDiacritics;
  const text = read(DIACRITICS_FILE, 'utf8');
  const codes = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    // Lines look like `0305; COMBINING OVERLINE` -- the codepoint is the first field.
    .map((line) => String.fromCodePoint(parseInt(line.split(';')[0], 16)));

  if (codes.length < 32) {
    throw new Error(`rowcolumn-diacritics.txt yielded only ${codes.length} entries — it did not parse`);
  }
  cachedDiacritics = codes;
  return codes;
}

// Image ids are a SHARED NAMESPACE, and we do not own it.
//
// Measured: ids are scoped per kitty WINDOW, not per kitty instance -- an image transmitted
// under id 42 in one window is invisible to placeholders in another. So two agents in two
// windows cannot collide. What CAN collide is anything else the user runs *in the agent's own
// window*: icat, timg, a file-manager preview, an image plugin in their editor. Re-transmitting
// an id REPLACES whatever image already held it, and those tools pick from the bottom of the
// range -- exactly where an 8-bit id lives. Squatting on 1..255 is not a namespace, it is a
// coin flip.
//
// So the id is 24 bits, carried in an RGB foreground (`\x1b[38;2;r;g;b m`) rather than a
// 256-colour index (verified: kitty renders wide ids from an RGB foreground). We refuse ids
// below MIN_ID to stay out of the crowded low range, and derive the id from the session so it
// is stable across the hook calls that swap the sprite underneath it.
const MIN_ID = 0x1000; // leave the low range to the tools that grab it without asking
const MAX_ID = 0xffffff; // 24 bits: what an RGB foreground can carry

// A stable 24-bit id for a session. Same session -> same id, so the hook can keep replacing
// the sprite under cells the status line printed once and never touched again.
export function imageIdFor(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('placeholder: imageIdFor needs a session id — an unkeyed image id would collide with the next session');
  }
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return MIN_ID + (h % (MAX_ID - MIN_ID + 1));
}

// Transmit the image and create a VIRTUAL placement. Draws nothing by itself.
//
// q=2 is not optional here and never was. These escapes are written to the AGENT's fd 1
// -- and any reply kitty sends comes back on the agent's STDIN, i.e. gets typed into
// claude-code's prompt. transmit() in kitty.js could get away without it because it
// sends no `i=`, and kitty answers nothing when there is no id to answer about. We send
// an id, by necessity: the placeholder's foreground colour has to name it. So from here
// on q=2 is the thing standing between us and keystrokes in the user's input box.
export function transmitVirtual(png, { id, cols, rows }) {
  if (png.length === 0) throw new Error('placeholder: refusing to transmit an empty PNG — the asset has no bytes');
  assertId(id);

  const payload = Buffer.from(png).toString('base64');
  const out = [];
  for (let at = 0; at < payload.length; at += CHUNK) {
    const slice = payload.slice(at, at + CHUNK);
    const more = at + CHUNK < payload.length ? 1 : 0;
    // a=T + U=1 both transmits AND creates the virtual placement in one escape, which
    // the spec explicitly allows ("The creation of the placement need not be a separate
    // escape code, it can be combined with a=T").
    const control =
      at === 0 ? `a=T,U=1,f=100,i=${id},c=${cols},r=${rows},q=2,m=${more}` : `m=${more}`;
    out.push(`\x1b_G${control};${slice}\x1b\\`);
  }
  return out.join('');
}

function assertId(id) {
  if (!Number.isInteger(id) || id < MIN_ID || id > MAX_ID) {
    throw new Error(
      `placeholder: image id must be ${MIN_ID}..${MAX_ID} (24 bits, carried in an RGB foreground; ` +
        `the low range belongs to icat and friends), got ${id} — use imageIdFor(sessionId)`
    );
  }
}

// tmux drops any escape it does not understand, so an unwrapped transmit vanishes and the cat
// silently never appears. Wrapping it in tmux's DCS passthrough (every ESC inside doubled) gets
// it through -- MEASURED: 38/38 graphics escapes survive wrapped, 0/38 unwrapped, and the cat
// renders inside a tmux pane.
//
// The caller decides whether it is in tmux. This module does not sniff the environment: a pure
// function that reads process.env is a function you cannot test.
export function wrapForTmux(escapes) {
  return `\x1bPtmux;${escapes.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

// The image, as printable text. One string per screen row.
//
// Returned as an ARRAY OF LINES rather than one blob, because the caller has to interleave
// them with whatever else is on those rows -- that is the whole point of the exercise. A
// single `\n`-joined string can only ever be a block that owns its lines, which is what we
// already have and are trying to stop doing.
export function placeholderLines({ id, cols, rows }) {
  const d = diacritics();
  assertId(id);
  if (rows > d.length || cols > d.length) {
    throw new Error(`placeholder: ${cols}x${rows} exceeds the ${d.length} encodable rows/columns`);
  }

  // The id rides in a 24-bit RGB foreground. A 256-colour index (`38;5;N`) would cap the id at
  // 255 -- and, worse, would not *fail* above that: it emits `38;5;10597059`, which is not an
  // error, just an SGR nobody honours and a cat that never appears.
  const red = (id >> 16) & 0xff;
  const green = (id >> 8) & 0xff;
  const blue = id & 0xff;

  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = `\x1b[38;2;${red};${green};${blue}m`;
    for (let c = 0; c < cols; c++) line += PLACEHOLDER + d[r] + d[c];
    lines.push(line + '\x1b[39m');
  }
  return lines;
}
