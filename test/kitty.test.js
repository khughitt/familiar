import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPHICS_CAPABILITY,
  GRAPHICS_MARKERS,
  MULTIPLEXER_MARKERS,
  graphicsCapability,
} from '../src/render/term/capability.js';
import { transmit, transmitAcross } from '../src/render/term/kitty.js';
import { wrapForTmux } from '../src/render/term/tmux.js';

test('classifies terminal graphics capability explicitly', () => {
  for (const [env, expected] of [
    [{ TERM: 'xterm-kitty' }, 'kitty-animation'],
    [{ KITTY_WINDOW_ID: '12' }, 'kitty-animation'],
    [{ TERM_PROGRAM: 'ghostty' }, 'static-graphics'],
    [{ TERM_PROGRAM: 'ghostty', KITTY_WINDOW_ID: '12' }, 'static-graphics'],
    [{ GHOSTTY_RESOURCES_DIR: '/x' }, 'static-graphics'],
    [{ GHOSTTY_BIN_DIR: '/x' }, 'static-graphics'],
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

test('a multiplexer marker demands the probe result; without one it throws rather than guessing', () => {
  const everyAccept = Object.fromEntries(GRAPHICS_MARKERS.map(({ name, value }) => [name, value ?? '1']));
  for (const name of MULTIPLEXER_MARKERS) {
    const env = { ...everyAccept, [name]: '/tmp/sock,1,0' };
    assert.throws(() => graphicsCapability(env), TypeError, `${name} set, no probe: must throw`);
    assert.throws(() => graphicsCapability(env, null), TypeError, `${name} set, null probe: must throw`);
  }
});

const KITTY_CLIENT = Object.freeze({
  ok: true, passthrough: 'all', termname: 'xterm-kitty', termtype: 'kitty(0.48.2)',
  client: { tty: '/dev/pts/16', pid: 9001, created: 1758200000 },
});
const TMUX_ENV = { TERM: 'tmux-256color', TMUX: '/tmp/sock,1,0', TMUX_PANE: '%0' };

test('inside tmux, only allow-passthrough=all with a graphics-capable client renders', () => {
  assert.equal(graphicsCapability(TMUX_ENV, KITTY_CLIENT), GRAPHICS_CAPABILITY.ANIMATION);
  assert.equal(graphicsCapability(TMUX_ENV, { ...KITTY_CLIENT, termname: 'xterm-ghostty', termtype: 'ghostty 1.3.1' }), GRAPHICS_CAPABILITY.STATIC);
  assert.equal(graphicsCapability(TMUX_ENV, { ...KITTY_CLIENT, termname: 'xterm-256color', termtype: 'foot(1.0)' }), GRAPHICS_CAPABILITY.NONE);
  // `on` drops passthrough while the pane is invisible; a level-triggered cat would go stale.
  assert.equal(graphicsCapability(TMUX_ENV, { ...KITTY_CLIENT, passthrough: 'on' }), GRAPHICS_CAPABILITY.NONE);
  assert.equal(graphicsCapability(TMUX_ENV, { ...KITTY_CLIENT, passthrough: 'off' }), GRAPHICS_CAPABILITY.NONE);
  for (const reason of ['no-binary', 'timeout', 'exit', 'no-pane', 'no-client']) {
    assert.equal(graphicsCapability(TMUX_ENV, { ok: false, reason }), GRAPHICS_CAPABILITY.NONE, reason);
  }
});

test('inside tmux the inherited environment loses to the attached client', () => {
  const inherited = { ...TMUX_ENV, KITTY_WINDOW_ID: '1' };
  assert.equal(graphicsCapability(inherited, { ...KITTY_CLIENT, termname: 'xterm-256color', termtype: '' }), GRAPHICS_CAPABILITY.NONE);
});

test('outside tmux the probe result is ignored and the TERM-prefix refusal still stands', () => {
  assert.equal(graphicsCapability({ TERM: 'xterm-kitty' }, null), GRAPHICS_CAPABILITY.ANIMATION);
  assert.equal(graphicsCapability({ TERM: 'tmux-256color' }, null), GRAPHICS_CAPABILITY.NONE);
  assert.equal(graphicsCapability({ TERM: 'screen-256color', KITTY_WINDOW_ID: '1' }, null), GRAPHICS_CAPABILITY.NONE);
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

const BARE_APC = /(?<!\x1b)\x1b_G/g;
const bareApcs = (text) => (text.match(BARE_APC) ?? []).length;

test('transmit frames every APC command and leaves the layout newlines outside the framing', () => {
  const png = filler(5000);
  const plain = transmit(png, { rows: 3 });
  const wrapped = transmit(png, { rows: 3, frame: wrapForTmux });
  assert.ok(plain.endsWith('\n\n\n'));
  assert.ok(wrapped.endsWith('\x1b\\\n\n\n'), 'the DCS closes before the newlines, which are tmux layout, not payload');
  assert.equal(bareApcs(wrapped), 0, 'no bare APC');
  const commands = plain.split('\x1b\\').length - 1;
  assert.equal(wrapped.split('\x1bPtmux;').length - 1, commands, 'one DCS per command');
  assert.equal(wrapped.length, plain.length + 11 * commands);
});

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

// SIDE BY SIDE. transmit() stacks: C=1 and then `rows` newlines. A row of cells needs
// each image in its OWN column box (c= and r=, so a wrong cell-aspect guess is air
// inside the box, never drift along the row) and the cursor walked right between them
// by plain CSI -- text, which tmux passthrough must leave alone -- with the newlines
// once, at the end.
test('transmitAcross places each image in its own column box and advances by CSI between them', () => {
  const a = filler(3072);
  const b = filler(5000);
  const out = transmitAcross([{ png: a, cols: 10, advance: 14 }, { png: b, cols: 7, advance: 11 }], { rows: 6 });

  const controls = controlsOf(out);
  assert.equal(controls[0], 'a=T,f=100,q=2,c=10,r=6,C=1,m=0');
  assert.equal(controls[1], 'a=T,f=100,q=2,c=7,r=6,C=1,m=1');
  assert.equal(controls[2], 'm=0');
  assert.equal(controls.length, 3);
  const afterA = out.indexOf('\x1b\\') + 2;
  assert.ok(out.startsWith('\x1b[14C', afterA), 'the cursor walks right by the whole cell after the first image');
  assert.equal((out.match(/\x1b\[\d+C/g) ?? []).join(' '), '\x1b[14C \x1b[11C');
  assert.ok(out.endsWith('\x1b[11C' + '\n'.repeat(6)), 'newlines once, after the last cell, exactly rows');
  assert.equal(payloadOf(out), a.toString('base64') + b.toString('base64'));
});

test('transmitAcross frames the APCs for tmux and leaves the CSI advances outside', () => {
  const png = filler(3072);
  const wrapped = transmitAcross([{ png, cols: 4, advance: 8 }], { rows: 2, frame: wrapForTmux });
  assert.equal(bareApcs(wrapped), 0);
  assert.ok(wrapped.includes('\x1b\\\x1b[8C\n\n'), 'the DCS closes before the advance and the newlines');
});

test('transmitAcross refuses an empty row and an empty PNG', () => {
  assert.throws(() => transmitAcross([], { rows: 2 }), /at least one/);
  assert.throws(() => transmitAcross([{ png: Buffer.alloc(0), cols: 4, advance: 4 }], { rows: 2 }), /empty PNG/);
});
