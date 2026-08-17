import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPHICS_CAPABILITY,
  GRAPHICS_MARKERS,
  MULTIPLEXER_MARKERS,
  graphicsCapability,
} from '../src/render/term/capability.js';
import { transmit } from '../src/render/term/kitty.js';

test('classifies terminal graphics capability explicitly', () => {
  for (const [env, expected] of [
    [{ TERM: 'xterm-kitty' }, 'kitty-animation'],
    [{ KITTY_WINDOW_ID: '12' }, 'kitty-animation'],
    [{ TERM_PROGRAM: 'ghostty' }, 'static-graphics'],
    [{ TERM_PROGRAM: 'ghostty', KITTY_WINDOW_ID: '12' }, 'static-graphics'],
    [{ GHOSTTY_RESOURCES_DIR: '/x' }, 'static-graphics'],
    [{ GHOSTTY_BIN_DIR: '/x' }, 'static-graphics'],
    [{ TERM: 'xterm-kitty', TMUX: '/tmp/tmux' }, 'none'],
    [{ TERM: 'screen-256color', KITTY_WINDOW_ID: '12' }, 'none'],
    [{ TERM: 'xterm-256color' }, 'none'],
  ]) assert.equal(graphicsCapability(env), expected);
});

// NO DEFAULT ENVIRONMENT. The whole point of the Step 0 spike is that the environment
// which decides this question belongs to the AGENT, not to whoever is asking -- so a
// caller that supplies none is a bug, and must be one loudly.
//
// KILLS: `graphicsCapability(env = process.env)`, which under a developer's kitty
// silently answers `true` for a process it was never shown.
test('a caller that names no environment is an error, not an ambient guess', () => {
  assert.throws(() => graphicsCapability(), TypeError);
});

// THE EXPORTED LISTS ARE THE CONTRACT, so they are tested AS lists — driven from the
// arrays themselves rather than from a hand-copy of them. GRAPHICS_MARKERS has a second
// reader (test/bin-familiar.test.js's negative preview fixture, which must scrub every
// accept condition or it stops being negative on a kitty desktop). Exporting the list
// gave that reader one source of truth; these two tests are what stop the source of
// truth from lying.
//
// KILLS: a marker added to the array but not honoured by graphicsCapability(); a marker
// left in the array after the code stopped honouring it (a dead entry the negative
// fixture would then scrub for no reason, and a future reader would trust). Neither is
// caught by the four hand-written cases above, which name only kitty and ghostty.
test('every GRAPHICS_MARKER actually enables graphics, one at a time', () => {
  for (const { name, value } of GRAPHICS_MARKERS) {
    const env = { [name]: value ?? '1' };
    assert.notEqual(
      graphicsCapability(env),
      GRAPHICS_CAPABILITY.NONE,
      `${name} is in GRAPHICS_MARKERS but does not enable graphics`,
    );
  }
});

test('every MULTIPLEXER_MARKER rejects, even beside every accept condition at once', () => {
  // Not one marker against an empty env — one marker against EVERY positive signal
  // simultaneously. That is the real shape of the bug: tmux inherits the outer
  // terminal's whole environment, so a multiplexer arrives carrying all of these.
  const everyAccept = Object.fromEntries(GRAPHICS_MARKERS.map(({ name, value }) => [name, value ?? '1']));
  for (const name of MULTIPLEXER_MARKERS) {
    assert.equal(
      graphicsCapability({ ...everyAccept, [name]: '/tmp/sock,1,0' }), GRAPHICS_CAPABILITY.NONE,
      `${name} is in MULTIPLEXER_MARKERS but does not reject — it accepted before it rejected`,
    );
  }
});

// transmit() never decodes its argument -- kitty's f=100 takes PNG BYTES, so these
// tests feed it plain filler. That is not a shortcut; it is the point. The runtime
// decodes nothing, which is why the indexed codec gets DELETED rather than replaced.
const controlsOf = (out) => [...out.matchAll(/\x1b_G([^;]*);/g)].map((m) => m[1]);

// AND THE PAYLOAD. An earlier draft of these tests checked the CONTROL strings and the
// trailing newlines and NOTHING ELSE -- nothing reassembled the base64, so a transmit()
// that emitted `payload.slice(0, CHUNK)` on every iteration (the same first 4096 chars
// over and over: a corrupt image) passed all five kitty tests, and so did
// `.toString('base64url')`. The test named "transmits a PNG as chunked base64" did not
// test the base64. The bytes on the wire are the only thing this module is FOR.
//
// Base64 contains no \x1b, so the payload of each escape is everything between its `;`
// and its ST -- and joining them in order is the image kitty will reassemble.
const payloadOf = (out) =>
  [...out.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map((m) => m[1]).join('');

// THE STRING ON THE WIRE, NOT THE DECODED BYTES -- and the distinction is the whole
// assertion. The first draft of these tests asserted
// `Buffer.from(payloadOf(out), 'base64').equals(png)` and claimed in a comment that it
// killed `base64url`. IT DOES NOT, AND NO FIXTURE COULD MAKE IT: Node's base64 decoder
// ACCEPTS the URL alphabet and unpadded input, so `Buffer.from(x.toString('base64url'),
// 'base64').equals(x)` is true for every buffer there is, `+`/`/` content or not. The
// mutation `toString('base64') -> toString('base64url')` shipped GREEN (pass 7, fail 0)
// past an assertion whose comment named it. Kitty, unlike Node, does not accept that
// alphabet: it would render nothing, silently, everywhere.
//
// Comparing the reassembled STRING to `png.toString('base64')` is what the module
// actually promises, and it decides the alphabet, the chunk order and the slice bounds
// in one line. Everything below asserts the string.
const wireIsExactly = (out, png) =>
  assert.equal(payloadOf(out), png.toString('base64'), 'the bytes on the wire are the PNG that went in');

// AND AN ADVERSARIAL FIXTURE, because `Buffer.alloc(n, 7)` was not one either: its
// base64 is all `A`s and `c`s -- no `+`, no `/` -- so the standard and URL alphabets
// produced near-identical strings and differed only in `=` padding. The two failures
// compounded. These bytes encode to `+/+/+/...`: every 3 bytes yield two `+` and two
// `/`, which are exactly the two characters base64url renames.
const filler = (n) => Buffer.from(Array.from({ length: n }, (_, i) => [0xfb, 0xff, 0xbf][i % 3]));

test('the transmit fixtures can actually tell the two base64 alphabets apart', () => {
  // The guard on the guard. If a future edit swaps `filler` back for flat bytes, the two
  // tests below quietly lose their ability to see an alphabet change -- and would say so
  // nowhere. `+` and `/` are the only characters base64url renames (to `-` and `_`).
  for (const n of [5000, 3072]) {
    const b64 = filler(n).toString('base64');
    assert.ok(b64.includes('+') && b64.includes('/'), `the ${n}-byte fixture encodes without + or / — it cannot see base64url`);
  }
});

test('transmits a PNG as chunked base64, every chunk marked, the last one m=0', () => {
  const png = filler(5000);                   // base64: 6668 chars -> 4096 + 2572
  const out = transmit(png, { rows: 12 });

  const controls = controlsOf(out);
  // EXACTLY two. `>= 2` was the old bound, and it is the bound under which a spurious
  // extra terminator is invisible -- which is precisely the bug that lived here.
  assert.equal(controls.length, 2, 'a 5000-byte payload is two chunks');
  // display; PNG; SILENT (q=2 -- kitty replies on the AGENT's stdin, see kitty.js); rows;
  // cursor stays; more follows.
  assert.equal(controls[0], 'a=T,f=100,q=2,r=12,C=1,m=1');
  assert.equal(controls[1], 'm=0');            // and the last one says it is last -- and carries no q: the protocol
                                               // allows only m (and optionally q) on a continuation chunk
  assert.ok(out.endsWith('\n'.repeat(12)), 'the cursor is advanced by hand, exactly rows times');

  // KILLS: a chunk loop that re-sends the first slice; `toString('base64url')`; an
  // off-by-one in the slice bounds that drops or duplicates a byte at every seam. All
  // three, in one string comparison -- see wireIsExactly above for why the decode-first
  // form could kill only the first of them.
  wireIsExactly(out, png);
});

// THE EXACT BOUNDARY. 3072 raw bytes base64-encode to exactly 4096 chars: one full
// chunk, zero remainder. This is the input on which the deleted `% CHUNK === 0`
// terminator fired, emitting a second m=0 -- an empty second image, drawn over the
// cat. Nothing else in the suite has a payload that divides evenly, so nothing else
// would ever have caught it.
test('a payload landing exactly on the chunk boundary sends ONE final chunk', () => {
  const png = filler(3072);
  const out = transmit(png, { rows: 6 });

  const controls = controlsOf(out);
  assert.equal(controls.length, 1, 'a 4096-char payload is one chunk, not one plus a terminator');
  assert.equal(controls[0], 'a=T,f=100,q=2,r=6,C=1,m=0');
  // The boundary case needs the payload check just as much: a spurious terminator that
  // carried an EMPTY payload would leave the reassembled bytes correct, but a loop that
  // sliced `at + CHUNK - 1` would not. Both tests assert the string; only together do
  // they pin the seam.
  wireIsExactly(out, png);
});

test('an empty PNG is REFUSED, not silently transmitted as nothing', () => {
  // `for (let at = 0; at < payload.length; at += CHUNK)` never runs on an empty buffer,
  // so transmit(Buffer.alloc(0)) returns bare newlines and no escape at all -- a silent
  // fallback, in a project whose Global Constraints forbid them. assetsFor() checks that
  // a sprite EXISTS, never that it has bytes: a zero-length <state>.png on disk (an
  // interrupted write, a bad checkout) would reach here and print an empty gap where the
  // cat should be, with nothing anywhere saying so.
  //
  // KILLS: removal of the length guard at the top of transmit().
  assert.throws(() => transmit(Buffer.alloc(0), { rows: 12 }), /empty/i);
});
