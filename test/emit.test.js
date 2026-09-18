import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderTransition, emit } from '../src/render/term/emit.js';
import { memoryLedger, stamp, EMPTY_ENTRY } from '../src/render/term/ledger.js';
import { GRAPHICS_CAPABILITY } from '../src/render/term/capability.js';
import { identityColors } from '../src/theme/ramp.js';
import { imageIdFor } from '../src/render/term/placeholder.js';
import { encodeRgba } from 'familiar-theme';
import { parseThemePack, assetsFor } from 'familiar-theme';

// REAL ramp output for slot 6 dark, not invented hexes. A fixture in the file
// whose job is to lock the color model must not contain numbers the color model
// would never produce.
const COLOR = identityColors(6, { mode: 'dark', satScale: 1 });   // base #5990cf, backdrop #15191e

const intentAt = (state) => ({
  sessionId: 's1',
  pid: 4242,
  identity: { projectKey: 'k', project: 'api', slot: 6, member: 'schrodingers-cat', label: "Schrodinger's Cat" },
  state,
  urgency: state === 'needs-input' ? 'demand' : 'none',
  motion: 'pulse',
  motionPolicy: 'full',
  animation: { kind: 'static' },
  color: COLOR,
  // `rows` is on the sprite because assetsFor put it there — see assets.test.js. It is
  // 8 here, a number no theme in this repo uses, so that the row-count test below can
  // only be satisfied by numbers that came from ITS theme and never from this fixture.
  sprite: { terminal: '/c/x.png', rows: 8 },
});

// THE SPRITE MARKER IS THE KITTY OPENING CHUNK, NOT A STRING IN THE FILE.
//
// This file used to gate the sprite on the literal 'CAT', from `readArt = () => 'CAT\n'`.
// Under the terminal-sprite contract the sprite is base64 inside a graphics escape, and
// 'CAT' can never appear in the output again — which would have left the FIVE NEGATIVE
// assertions below (`!out.includes('CAT')`) asserting the absence of an impossible
// string. Tests that cannot fail. It was executed: deleting the ATTENTION_STATES gate
// from emit.js entirely, so that every transition prints a sprite, left all five green.
//
// `a=T` rides on the OPENING chunk only, so it is present exactly when a sprite was
// transmitted, absent exactly when it was not, and appears exactly once per image.
const SPRITE = '\x1b_Ga=T';

// A REAL PNG, not three bytes spelling "PNG" or a header-only stub.
//
// The old renderer never looked inside the sprite -- it base64'd the bytes and let kitty pin the
// height from the theme's `rows:`. So the fixture could be anything, and was. The new one asks
// the sprite how WIDE it is after validating the PNG container (the cell box's width follows the
// sprite's aspect, because every member's canvas is its own). A fixture that cannot pass the
// production validation boundary cannot answer the question under test.
//
// 200x400 -> a tall cat -> 4 rows x 4 cols (rows * 2 * 200/400).
// Encode once: every test reuses the same immutable fixture bytes.
const FAKE_PNG = encodeRgba({
  w: 200,
  h: 400,
  buf: new Uint8Array(200 * 400 * 4),
});
const readSprite = () => FAKE_PNG;

const ANIMATION = GRAPHICS_CAPABILITY.ANIMATION;
const NO_GRAPHICS = GRAPHICS_CAPABILITY.NONE;
const KITTY_TERMINAL = {
  path: '/proc/4242/fd/1',
  env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' },
};

const TMUX_KITTY = Object.freeze({
  ok: true, passthrough: 'all', termname: 'xterm-kitty', termtype: 'kitty(0.48.2)',
  client: Object.freeze({ tty: '/dev/pts/16', pid: 9001, created: 1758200000 }),
});
const TMUX_TERMINAL = {
  path: '/proc/4242/fd/1',
  env: { TERM: 'tmux-256color', TMUX: '/tmp/s,1,0', TMUX_PANE: '%0' },
  tmux: TMUX_KITTY,
};
const OWNER = { pid: 4242, starttime: 987654 };
const BARE_APC = /(?<!\x1b)\x1b_G/g;
const bareApcs = (text) => (text.match(BARE_APC) ?? []).length;
const directHeld = (state = 'working') => ({
  transport: 'direct', capability: ANIMATION, id: imageIdFor('s1'),
  intent: { state, motionPolicy: 'full', animation: { kind: 'clips', manifest: '/themes/cats/sprites/ginger/animation.yaml', sha256: 'a'.repeat(64) }, sprite: { terminal: '/c/x.png', rows: 8 } },
});
// The section's required collaborators, with the most permissive fakes. Every test that
// cares about one of them overrides it.
const section = (overrides = {}) => ({
  seq: 1,
  ledger: memoryLedger(),
  lock: (fn) => fn(),
  ownerAlive: () => true,
  ...overrides,
});

const agentAt = (state, { pid = 4242, starttime = 987654 } = {}) => ({
  sessionId: 's1', state, pid, starttime,
});

const clipsSet = Object.freeze({
  kind: 'clips',
  clips: new Map([
    ['working-loop', Object.freeze({
      state: 'working',
      playback: 'loop',
      frames: Object.freeze([
        Object.freeze({ ref: 'root', path: '/c/x.png', durationMs: 100, decodedBytes: 320000 }),
        Object.freeze({ ref: 'bat', path: '/c/bat.png', durationMs: 100, decodedBytes: 320000 }),
        Object.freeze({ ref: 'root', path: '/c/x.png', durationMs: 100, decodedBytes: 320000 }),
      ]),
    })],
  ]),
});

const clipsIntent = (state = 'working', policy = 'full') => ({
  ...intentAt(state),
  motionPolicy: policy,
  animation: { kind: 'clips', manifest: '/themes/cats/sprites/ginger/animation.yaml', sha256: 'a'.repeat(64) },
});

async function captureEmission(overrides = {}) {
  const writes = [];
  const opens = [];
  const result = await emit({
    prev: null,
    next: agentAt('working'),
    intent: clipsIntent(),
    terminal: KITTY_TERMINAL,
    loadAnimation: () => clipsSet,
    readFrame: () => FAKE_PNG,
    open: (path) => { opens.push(path); return 7; },
    write: (fd, bytes, offset, length) => {
      writes.push({ fd, bytes: Buffer.from(bytes.subarray(offset, offset + length)) });
      return length;
    },
    close: () => {},
    checkTty: () => true,
    ...section(),
    ...overrides,
  });
  return { result, writes, opens, bytes: Buffer.concat(writes.map((entry) => entry.bytes)) };
}

test('a transition emits graphics and tint without taking ownership of the title', () => {
  const out = renderTransition({
    prev: 'working', next: 'needs-input', intent: intentAt('needs-input'), readSprite, capability: ANIMATION,
  });
  assert.ok(out.includes(SPRITE));
  assert.ok(out.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`), 'background tinted to the identity backdrop');
  assert.ok(out.includes(`\x1b]12;${COLOR.base}\x1b\\`), 'cursor tinted to the identity base');
  assert.doesNotMatch(out, /\x1b\]2;/);
});

test('a repeated hook in the same state emits nothing', () => {
  for (const state of ['idle', 'working', 'needs-input', 'needs-approval', 'error', 'done']) {
    assert.equal(renderTransition({
      prev: state, next: state, intent: intentAt(state), readSprite,
      capability: ANIMATION,
    }), '');
  }
});

test('session end restores terminal colours without replacing the title', () => {
  const out = renderTransition({
    prev: 'working', next: null, intent: intentAt('working'), readSprite,
    capability: NO_GRAPHICS,
  });
  assert.equal(out, '\x1b]111\x1b\\\x1b]112\x1b\\');
  assert.doesNotMatch(out, /\x1b\]2;/);
});

test('the first sighting of a session is a transition', () => {
  assert.notEqual(
    renderTransition({ prev: null, next: 'idle', intent: intentAt('idle'), readSprite, capability: ANIMATION }),
    '',
  );
});

test('BEL rings on entering the three states worth interrupting you for — and only those', () => {
  // This test is the reason OSC terminates with ST (D9). If OSC ended in BEL,
  // every one of these outputs would contain \x07 and the negative half below
  // could never pass — while the positive half would pass with RINGS empty.
  for (const state of ['needs-input', 'needs-approval', 'error']) {
    const out = renderTransition({ prev: 'working', next: state, intent: intentAt(state), readSprite, capability: ANIMATION });
    assert.ok(out.includes('\x07'), `${state} should ring`);
  }
  for (const state of ['idle', 'working', 'done']) {
    const out = renderTransition({ prev: 'working', next: state, intent: intentAt(state), readSprite, capability: ANIMATION });
    assert.ok(!out.includes('\x07'), `${state} should not ring`);
  }
});

// Table-driven over the protocol's own STATES list, with an explicit count
// assertion — so a seventh state added to familiar-theme makes this test
// fail rather than silently continuing to check only six. A "rings" set that
// happened to be empty would still pass a hand-written enumeration; it cannot
// pass this one, because every state is asserted one way or the other.
test('BEL table, over STATES: exactly needs-input/needs-approval/error ring', async () => {
  const { STATES } = await import('familiar-theme');
  const RINGS = new Set(['needs-input', 'needs-approval', 'error']);
  assert.equal(STATES.length, 6, 'a seventh state needs a decision here, not a silent pass');
  for (const state of STATES) {
    const out = renderTransition({ prev: 'working', next: state, intent: intentAt(state), readSprite, capability: ANIMATION });
    assert.equal(out.includes('\x07'), RINGS.has(state), `state "${state}"`);
  }
});

// --- The sprite is gated on ATTENTION, a DIFFERENT set from RINGS -----------
//
// The sprite is ten or twelve terminal rows (the theme says which, per state — see the
// row-count section below), and every transition used to print one into scrollback —
// 50-60 per busy session. It is now punctuation, not narration: it
// prints only on entry to a state worth looking up for,
// `needs-input`/`needs-approval`/`error`/`done`. The tint is unaffected, so only
// the terminal (the one renderer that is a log) needs to be quieted.
//
// ATTENTION_STATES overlaps RINGS but is not equal to it: `done` gets a sprite
// but never rings (it is not urgent, just worth a glance), so the two gates must
// stay independent rather than riding along inside one branch.

test('a transition into "working" transmits the pose too — the cat is level-triggered, not punctuation', () => {
  // THE CONTRACT INVERTED HERE, and it is the point of the whole rewrite.
  //
  // The sprite used to be gated to four ATTENTION_STATES because the terminal was a LOG: every
  // transition printed ten rows into scrollback, a busy session transitions 50-60 times, and
  // printing rarely was the only defence. A virtual placement DRAWS NOTHING -- it replaces the
  // image sitting under the status line's cells -- so there is no scrollback to protect. The cat
  // now always shows the CURRENT state instead of the last state interesting enough to print.
  // `working` is a state; the cat shows it.
  const out = renderTransition({ prev: 'idle', next: 'working', intent: intentAt('working'), readSprite, capability: ANIMATION });
  assert.ok(out.includes(SPRITE), 'working must transmit its pose');
  assert.ok(!out.includes('\x07'), 'no bell — working is not worth interrupting you for');
  assert.ok(out.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`), 'tint still written');
});

test('a transition into "done" emits sprite and tint — but no BEL', () => {
  const out = renderTransition({ prev: 'working', next: 'done', intent: intentAt('done'), readSprite, capability: ANIMATION });
  assert.ok(out.includes(SPRITE));
  assert.ok(out.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`), 'tint written');
  assert.ok(!out.includes('\x07'), '"done" is worth a glance, not an interruption — RINGS excludes it');
});

test('a transition into "needs-approval" emits sprite, tint, and BEL', () => {
  const out = renderTransition({
    prev: 'working', next: 'needs-approval', intent: intentAt('needs-approval'), readSprite, capability: ANIMATION,
  });
  assert.ok(out.includes(SPRITE));
  assert.ok(out.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`), 'tint written');
  assert.ok(out.includes('\x07'), 'BEL rings — needs-approval is in RINGS');
});

// Table-driven over the protocol's own STATES list, same discipline as the BEL
// table above: a seventh state must force a decision here, not a silent pass.
test('EVERY state transmits its pose — there is no longer a state the cat does not show', async () => {
  const { STATES } = await import('familiar-theme');
  assert.equal(STATES.length, 6, 'a seventh state needs a decision here, not a silent pass');
  for (const state of STATES) {
    // The previous state must DIFFER from the one under test, or the hook is a steady-state
    // re-assertion and correctly transmits nothing. A fixed `prev` silently turned one row of
    // this table into a test of the opposite behaviour.
    const prev = state === 'idle' ? 'working' : 'idle';
    const out = renderTransition({ prev, next: state, intent: intentAt(state), readSprite, capability: ANIMATION });
    assert.ok(out.includes(SPRITE), `state "${state}" did not transmit its pose`);
  }
});

test('the first hook of a session GREETS — a cat, even though it lands on idle', () => {
  // SessionStart maps to `idle`, which is on the never-print list. The greeting
  // is the one exception, and it is keyed on `prev === null`: the bus holds a
  // state for every live session, so no previous state can only mean this
  // session has never fired a hook before. That is the project introducing
  // itself, and it is the whole point of the thing.
  const out = renderTransition({ prev: null, next: 'idle', intent: intentAt('idle'), readSprite, capability: ANIMATION });
  assert.ok(out.includes(SPRITE), 'the first sighting prints the cat');
  assert.ok(out.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`), 'and the identity tint');
  assert.ok(!out.includes('\x07'), 'but never rings — idle is not urgent');
});

test('idle reached LATER in the session shows the idle pose — the cat curls back up', () => {
  // This used to assert SILENCE: idle was not an attention state, so returning to it printed
  // nothing and the terminal kept showing whatever cat was last worth printing. That is the
  // definition of a stale renderer, and it was the design. Level-triggered means the cat is
  // never stale: come back to idle and the cat goes back to sleep, on screen, where you can see
  // it.
  const out = renderTransition({ prev: 'working', next: 'idle', intent: intentAt('idle'), readSprite, capability: ANIMATION });
  assert.ok(out.includes(SPRITE), 'returning to idle transmits the idle pose — the cat curls back up');
  assert.ok(out.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`), 'the tint is still written on the transition');
});

test('the identity tint is written on every transition but never varies with state', () => {
  const working = renderTransition({ prev: 'idle', next: 'working', intent: intentAt('working'), readSprite, capability: ANIMATION });
  const erroring = renderTransition({ prev: 'working', next: 'error', intent: intentAt('error'), readSprite, capability: ANIMATION });
  // State owns urgency and motion. It never repaints the identity hue.
  assert.ok(working.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`));
  assert.ok(erroring.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`));
});

test('emit takes an Intent, NOT an IntentRecord — the shape bin/familiar actually has', () => {
  // intent.json is keyed to { current, expiresAt, after }. Hand THAT to the
  // emitter and every field it wants — identity, sprite, color, pid — is
  // undefined, and every hook event in every project throws on the first line.
  // A unit test with a hand-built flat fixture would never catch it, so assert
  // the caller's mistake directly.
  const record = { current: intentAt('working'), expiresAt: null, after: null };
  assert.throws(
    () => renderTransition({ prev: 'idle', next: 'working', intent: record, readSprite, capability: ANIMATION }),
    /intent\.identity is undefined — did you pass an IntentRecord/
  );
});

// --- The height is the STATE's, and it comes from the theme ------------------
//
// Kitty's r= pins the image's HEIGHT and lets its WIDTH follow the aspect ratio. The
// compiler crops each master to the cat's own bounding box and the six archetypes are
// deliberately different masses, so their aspects span 4x (working 2.25, needs-input
// 0.57) — and at one global row count `working` rendered about FOUR TIMES as wide as
// `needs-input`. That is the bug this section exists to keep dead.
//
// Built from a REAL theme, parsed and resolved through the real assetsFor, because the claim
// is not "renderTransition passes a number through" — it is "the number the human wrote in
// theme.yaml is the number kitty is told". Every link or none. rows is a theme-level scalar
// now (surface-truth); 20 is deliberately NOT the default 12, so a later assertion that the
// cat stands at 20 can only pass on a number that came from THIS theme.
const THEME_YAML = `
spec-version: 1
id: cats
label: Cats
rows: 20
members:
  - id: ginger-tabby
    asset-root: sprites/ginger-tabby
    label: Ginger Tabby
    slots: [6, 0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11]
    persona: The Enthusiast. Boundless energy, zero impulse control.
    animation: { kind: static }
    poses:
      idle: curled tight into a loaf
      working: frantic batting, blurred paws
      needs-input: sitting far too close, unblinking stare
      needs-approval: one paw on your arm, insistent
      error: all four paws airborne, comic startle
      done: proud, sitting tall
`;
const proveParsedFixture = (pack) => {
  for (const member of pack.members.values()) member.assetDirProof = 'filesystem';
  return pack;
};
const fileStat = Object.freeze({ isFile: () => true, isSymbolicLink: () => false });
const proofOptions = { lstat: () => fileStat, realpath: (p) => p };
const THEMED = assetsFor(
  proveParsedFixture(parseThemePack(THEME_YAML, '/themes/cats')),
  'ginger-tabby',
  'dark',
  proofOptions,
);
const themedIntent = (state) => ({ ...intentAt(state), sprite: THEMED[state] });

// A theme at an arbitrary height, for asserting the emitter tracks whatever the theme says.
const themeYamlRows = (n) => THEME_YAML.replace('rows: 20', `rows: ${n}`);
const themedAt = (n, state) =>
  ({
    ...intentAt(state),
    sprite: assetsFor(
      proveParsedFixture(parseThemePack(themeYamlRows(n), '/themes/cats')),
      'ginger-tabby',
      'dark',
      proofOptions,
    )[state],
  });

// Only the OPENING chunk carries the control keys. It is a VIRTUAL placement now (U=1), so it
// also carries the image id and the COLUMN count -- the two facts the status line has to agree
// with, in another process, later.
const placementOf = (out) => {
  const m = out.match(/\x1b_Ga=T,U=1,f=100,i=(\d+),c=(\d+),r=(\d+),q=2,/);
  assert.ok(m, 'no opening VIRTUAL graphics chunk — nothing transmitted a pose');
  return { id: Number(m[1]), cols: Number(m[2]), rows: Number(m[3]) };
};

// THE ROW COUNT COMES FROM THE THEME AGAIN, and uniformly. Every pose of a member shares ONE
// canvas (the art compiler bottom-anchors them onto it), and rows is now one number for the
// whole theme (surface-truth) — so the box is the same height for every state, and a width
// derived from that shared canvas. Two things must hold, and they are two assertions: the box
// is the SAME for every state (or the status line, which prints the cells ONCE and swaps the
// pose underneath, crops the cat on the states nobody screenshots), AND that shared height is
// the THEME's number, not a constant the emitter kept.
test('the placement is the SAME box for every state, at the THEME\'s height', () => {
  const boxes = new Set();
  const rows = new Set();
  for (const state of ['idle', 'working', 'needs-input', 'needs-approval', 'error', 'done']) {
    const prev = state === 'idle' ? 'working' : 'idle';   // never a steady-state hook
    const out = renderTransition({ prev, next: state, intent: themedIntent(state), readSprite, capability: ANIMATION });
    const placement = placementOf(out);
    boxes.add(`${placement.cols}x${placement.rows}`);
    rows.add(placement.rows);
  }
  assert.equal(boxes.size, 1, `the box changes with the state — ${[...boxes].join(', ')}`);
  assert.deepEqual([...rows], [20], 'the shared height is not the theme\'s 20 — the emitter kept a constant');
});

test('the emitter renders at the THEME\'s height — two themes, two heights, neither the default', () => {
  // KILLS a constant hardcoded into the emitter: 11 and 33 are neither the default 12, the
  // fixture 8, nor the invariant theme 20. Only reading intent.sprite.rows passes both.
  for (const n of [11, 33]) {
    const out = renderTransition({ prev: 'idle', next: 'working', intent: themedAt(n, 'working'), readSprite, capability: ANIMATION });
    assert.equal(placementOf(out).rows, n, `the emitter ignored the theme's rows=${n}`);
  }
});

test('the placement names an id derived from the SESSION — the status line finds the same image', () => {
  // The status line is a different process, started later, that never speaks to this one. The
  // ONLY thing joining them is this number. Stop deriving it from the session and the status
  // line prints cells pointing at an image nobody transmitted: empty cells, no error, no cat.
  const out = renderTransition({ prev: 'idle', next: 'working', intent: intentAt('working'), readSprite, capability: ANIMATION });
  assert.equal(placementOf(out).id, imageIdFor('s1'), "the image id is not the session's");
});

test('THE CAT OCCUPIES NO SCROLLBACK — the placement is virtual and not one newline follows it', () => {
  // The whole bug, in one assertion.
  //
  // The old renderer sent a real placement and then advanced the cursor by `rows` newlines to
  // reserve space for it. In a shell that works. Against claude-code — a fullscreen TUI that
  // owns and continuously repaints the screen — the reservation is meaningless and the image
  // floats on top of text it never reserved. Measured: the cat covered the "Yes, always allow
  // access to tmp/" option of the very permission dialog it was announcing.
  //
  // A virtual placement (U=1) draws NOTHING and occupies NOTHING; the image appears only where
  // the status line prints its placeholder cells. If a newline ever comes back, so has the bug.
  const out = renderTransition({ prev: null, next: 'working', intent: themedIntent('working'), readSprite, capability: ANIMATION });
  assert.ok(out.includes('U=1'), 'the placement is not virtual — it will draw on top of the TUI');
  assert.ok(!out.includes('\n'), 'a newline crept back in — the cat is reserving scrollback again');
});

// --- The graphics gate ------------------------------------------------------

test('a terminal without graphics support gets no sprite — and no escape garbage', () => {
  const out = renderTransition({
    prev: 'idle', next: 'error', intent: intentAt('error'),
    readSprite, capability: NO_GRAPHICS,
  });
  assert.ok(!out.includes('\x1b_G'), 'no graphics escape may reach a terminal that cannot parse it');
  assert.ok(out.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`), 'the background tint still goes out');
  assert.ok(out.includes(`\x1b]12;${COLOR.base}\x1b\\`), 'the cursor tint still goes out');
  assert.doesNotMatch(out, /\x1b\]2;/);
  assert.ok(out.includes('\x07'), 'the bell still rings');
});

// KILLS: `capability = NONE` as the default (no cat renders anywhere, silently), and
// `capability = ANIMATION` (escapes fired into a terminal that cannot parse them). Both of
// those pass every other test in this file, because every other test injects
// `capability` explicitly. This is the ONLY test in which the environment decides.
test('with no capability argument, the environment decides', () => {
  const on  = renderTransition({ prev: 'idle', next: 'error', intent: intentAt('error'),
                                 readSprite, env: { TERM: 'xterm-kitty' } });
  const off = renderTransition({ prev: 'idle', next: 'error', intent: intentAt('error'),
                                 readSprite, env: { TERM: 'xterm-256color' } });
  assert.ok(on.includes(SPRITE), 'a recognised terminal gets the sprite');
  assert.ok(!off.includes('\x1b_G'), 'an unrecognised one gets no escape at all');
});

// KILLS: `env = process.env`. graphicsCapability() REFUSES a default env on purpose —
// "an invitation to ask the wrong process, silently" — and renderTransition used to
// hand it exactly that default one layer up, where the answer becomes escape bytes on
// somebody else's fd. Asked neither which env nor which answer, it must CRASH, not
// quietly interrogate the hook subprocess it happens to be running in.
//
// This is the only assertion that can see the default at all: every other caller in
// src/, bin/ and this file passes `capability` or `env` outright, which is what let the
// default sit there unexercised.
test('renderTransition given neither env nor capability throws — it does not ask process.env', () => {
  assert.throws(
    () => renderTransition({ prev: 'idle', next: 'error', intent: intentAt('error'), readSprite }),
    TypeError,
  );
});

// --- emit(): the tty gate (spike Finding A) ---------------------------------
//
// The spike found /dev/tty is ENXIO from a hook subprocess in 1507 of 1507
// samples, and that /proc/<agentPid>/fd/1 opening successfully is NOT evidence
// it is a terminal — 370 of 1507 samples opened onto a daemon's pipe or log
// file. emit() must call isatty() on the opened fd and stay silent when it is
// false. These tests inject open/write/close/checkTty so nothing here ever
// touches a real fd.

test('emit opens the explicit terminal path', async () => {
  const opened = [];
  await emit({
    ...section(),
    prev: agentAt('working'), next: agentAt('needs-input'), intent: intentAt('needs-input'),
    readSprite, terminal: { ...KITTY_TERMINAL, path: '/dev/ttys003' },
    open: (path) => { opened.push(path); return 7; },
    write: (_fd, _bytes, _offset, length) => length,
    close: () => {},
    checkTty: () => true,
  });
  assert.deepEqual(opened, ['/dev/ttys003']);
});

test('emit requires an explicit terminal target', async () => {
  await assert.rejects(emit({
    ...section(),
    prev: agentAt('working'), next: agentAt('needs-input'), intent: intentAt('needs-input'),
    readSprite,
    open: () => 7,
    write: (_fd, _bytes, _offset, length) => length,
    close: () => {},
    checkTty: () => true,
  }), /emit requires terminal/);
});

test('a non-tty fd produces no output at all — open() succeeding is not evidence of a terminal', async () => {
  let wrote = false;
  let closed = false;
  const result = await emit({
    ...section(),
    prev: agentAt('working'), next: agentAt('needs-input'), intent: intentAt('needs-input'),
    readSprite, terminal: KITTY_TERMINAL,
    open: () => 99,
    write: () => { wrote = true; },
    close: (fd) => { assert.equal(fd, 99); closed = true; },
    checkTty: (fd) => { assert.equal(fd, 99); return false; },
  });
  assert.equal(wrote, false, 'wrote to a fd that isatty() said was not a terminal');
  assert.equal(closed, true, 'a non-tty fd must still be closed, not leaked');
  assert.equal(result.kind, 'suppressed');
  assert.equal(result.reason, 'not-a-tty');
});

test('a tty fd receives the complete update and presentation bytes, then is closed', async () => {
  let written = null;
  let closed = false;
  const result = await emit({
    ...section({ seq: 2, ledger: memoryLedger(stamp({ held: { ...directHeld(), intent: { ...directHeld().intent, animation: { kind: 'static' } } } }, { seq: 1, owner: OWNER })) }),
    prev: agentAt('working'), next: agentAt('needs-input'), intent: intentAt('needs-input'),
    readSprite, terminal: KITTY_TERMINAL,
    open: () => 7,
    write: (fd, bytes, _offset, length) => { written = { fd, bytes }; return length; },
    close: (fd) => { assert.equal(fd, 7); closed = true; },
    checkTty: () => true,
  });
  assert.ok(written);
  assert.equal(written.fd, 7);
  const out = written.bytes.toString();
  assert.match(out, /a=a,i=\d+,s=1,q=2/);
  assert.match(out, /a=c,i=\d+,r=2,c=1,C=1,q=2/);
  assert.ok(out.endsWith(renderTransition({
    prev: 'working', next: 'needs-input', intent: intentAt('needs-input'), readSprite, capability: NO_GRAPHICS,
  })));
  assert.equal(closed, true);
  assert.equal(result.kind, 'transmitted');
});

test('no transition leaves the terminal fd unopened', async () => {
  let opened = false;
  const result = await emit({
    ...section({ seq: 2, ledger: memoryLedger(stamp({ held: { ...directHeld(), intent: { ...directHeld().intent, animation: { kind: 'static' } } } }, { seq: 1, owner: OWNER })) }),
    prev: agentAt('working'), next: agentAt('working'), intent: intentAt('working'),
    readSprite, terminal: KITTY_TERMINAL,
    open: () => { opened = true; return 7; },
    write: () => { throw new Error('must not write'); },
    close: () => {},
    checkTty: () => true,
  });
  assert.equal(opened, false);
  assert.equal(result.kind, 'unchanged');
});

test('a failure to open the fd (no such process, no controlling terminal) is silent, not thrown', async () => {
  const result = await emit({
    ...section(),
    prev: agentAt('working'), next: agentAt('needs-input'), intent: intentAt('needs-input'),
    readSprite, terminal: KITTY_TERMINAL,
    open: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    write: () => { throw new Error('must not be called'); },
    close: () => {},
    checkTty: () => true,
  });
  assert.equal(result.kind, 'suppressed');
  assert.equal(result.reason, 'open');
});

test('emit defaults isatty to the real node:tty.isatty, and stays silent against a real non-tty fd', async () => {
  // No injected checkTty at all: this exercises the REAL default, against a
  // real fd that is provably not a terminal (an ordinary regular file), so the
  // isatty() gate is proven against the actual Node API, not a stand-in for it.
  const path = join(tmpdir(), `familiar-emit-test-${process.pid}-${Date.now()}`);
  writeFileSync(path, '');
  let wrote = false;
  try {
    await emit({
      ...section(),
      prev: agentAt('working'), next: agentAt('needs-input'), intent: intentAt('needs-input'),
      readSprite, terminal: KITTY_TERMINAL,
      open: () => openSync(path, 'a'),
      write: () => { wrote = true; },
      // checkTty and close are NOT injected here: real node:tty.isatty and
      // real closeSync run, against the real fd opened above.
    });
  } finally {
    unlinkSync(path);
  }
  assert.equal(wrote, false, 'a real, ordinary file fd is not a tty, and isatty() must have said so');
});

// --- emit(): the capability check reads the AGENT, not the hook --------------
//
// emit() receives the path and environment as one target, so capability cannot be
// computed from a different process than the fd that receives the bytes.

test('graphics capability is read from the explicit terminal environment', async () => {
  const written = [];
  await emit({
    ...section(),
    prev: agentAt('idle'), next: agentAt('error'), intent: intentAt('error'),
    readSprite,
    terminal: { path: '/proc/4242/fd/1', env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '3' } },
    open: () => 7, write: (_fd, b, _offset, length) => { written.push(b); return length; }, close: () => {}, checkTty: () => true,
  });

  assert.ok(written[0].includes('\x1b_G'), 'a recognised terminal must actually get graphics');
  assert.ok(written[0].includes('a=T'), 'no ledger evidence means a fresh graphical binding');
});

test('an unavailable terminal environment degrades to no sprite, not to no output', async () => {
  const written = [];
  await emit({
    ...section(),
    prev: agentAt('idle'), next: agentAt('error'), intent: intentAt('error'),
    readSprite,
    terminal: { path: '/proc/4242/fd/1', env: undefined },
    open: () => 7, write: (_fd, b, _offset, length) => { written.push(b); return length; }, close: () => {}, checkTty: () => true,
  });
  assert.ok(!written[0].includes('\x1b_G'), 'no graphics escape without a known terminal');
  assert.match(written[0].toString(), /\x1b\]11;/, 'the background tint still goes out');
  assert.doesNotMatch(written[0].toString(), /\x1b\]2;/);
  assert.ok(written[0].includes('\x07'), 'the bell still rings');
});

// KILLS: `graphics = !!terminal.env` — a truthy environ OBJECT,
// with graphicsCapability() bypassed entirely. That mutation passes both tests above:
// the recognised environ is truthy (sprite fires) and the throwing one is caught
// (no sprite). Only a READABLE environ describing a terminal we do NOT support can
// tell the difference between "we asked graphicsCapability()" and "we asked whether a
// file was readable". The positive direction alone never proves a gate; it proves a
// pipe.
test('a readable environ for a terminal we do NOT support suppresses the sprite', async () => {
  const written = [];
  await emit({
    ...section(),
    prev: agentAt('idle'), next: agentAt('error'), intent: intentAt('error'),
    readSprite,
    terminal: { path: '/proc/4242/fd/1', env: { TERM: 'xterm-256color' } },
    open: () => 7, write: (_fd, b, _offset, length) => { written.push(b); return length; }, close: () => {}, checkTty: () => true,
  });
  assert.ok(!written[0].includes('\x1b_G'), 'the environ was read, and it said no');
  assert.match(written[0].toString(), /\x1b\]11;/, 'and the tint still goes out');
  assert.doesNotMatch(written[0].toString(), /\x1b\]2;/);
});

// --- emit(): complete animation programs and ledger-derived lifecycle -------

test('first full Kitty clips transition creates one complete root/program/start write', async () => {
  const { writes, bytes } = await captureEmission();
  assert.equal(writes.length, 1, 'the fully validated transition must reach the fd as one write-all call');
  assert.match(bytes.toString(), /a=T,U=1/);
  assert.match(bytes.toString(), /a=f,f=100/);
  assert.match(bytes.toString(), /a=a,i=\d+,s=3,v=1,q=2/);
});

test('later full Kitty transition updates in place under the same image id', async () => {
  const { writes, bytes } = await captureEmission({
    prev: agentAt('idle'),
    next: agentAt('working'),
    ...section({ seq: 2, ledger: memoryLedger(stamp({ held: directHeld('idle') }, { seq: 1, owner: OWNER })) }),
  });
  const out = bytes.toString();
  assert.equal(writes.length, 1);
  assert.doesNotMatch(out, /a=T/);
  assert.match(out, /a=a,i=\d+,s=1,q=2/);
  assert.match(out, /a=d,d=f/);
  assert.match(out, /a=c,i=\d+,r=2,c=1,C=1,q=2/);
  assert.match(out, /a=a,i=\d+,s=3,v=1,q=2/);
  assert.ok(out.includes(`i=${imageIdFor('s1')}`));
});

test('reduced Kitty creates a root first and uses staged root composition later', async () => {
  const first = (await captureEmission({ intent: clipsIntent('working', 'reduced') })).bytes.toString();
  assert.match(first, /a=T,U=1/);
  assert.doesNotMatch(first, /a=f/);
  assert.doesNotMatch(first, /a=a/);

  const later = (await captureEmission({
    prev: agentAt('idle'), next: agentAt('working'),
    ...section({ seq: 2, ledger: memoryLedger(stamp({ held: { ...directHeld('idle'), intent: { ...directHeld('idle').intent, motionPolicy: 'reduced' } } }, { seq: 1, owner: OWNER })) }),
    intent: clipsIntent('working', 'reduced'),
  })).bytes.toString();
  assert.doesNotMatch(later, /a=T/);
  assert.match(later, /a=a,i=\d+,s=1,q=2/);
  assert.match(later, /a=c,i=\d+,r=2,c=1,C=1,q=2/);
  assert.doesNotMatch(later, /a=a,i=\d+,s=3/);
});

test('full Ghostty emits only a static root and never animation frame controls', async () => {
  const { bytes } = await captureEmission({
    terminal: { path: '/proc/4242/fd/1', env: { TERM_PROGRAM: 'ghostty' } },
  });
  const out = bytes.toString();
  assert.match(out, /a=T,U=1/);
  assert.doesNotMatch(out, /a=f/);
  assert.doesNotMatch(out, /a=a/);
});

test('later Ghostty transitions send a fresh static root, never Kitty update controls', async () => {
  const { bytes } = await captureEmission({
    prev: agentAt('idle'),
    next: agentAt('working'),
    ...section({ seq: 2, ledger: memoryLedger(stamp({ held: { ...directHeld('idle'), capability: GRAPHICS_CAPABILITY.STATIC } }, { seq: 1, owner: OWNER })) }),
    terminal: { path: '/proc/4242/fd/1', env: { TERM_PROGRAM: 'ghostty' } },
  });
  const out = bytes.toString();
  assert.match(out, /a=T,U=1/);
  assert.doesNotMatch(out, /a=f/);
  assert.doesNotMatch(out, /a=a/);
});

test('off and no-graphics load no animation and preserve independent OSC output', async () => {
  for (const [label, intent, terminal] of [
    ['off', clipsIntent('working', 'off'), KITTY_TERMINAL],
    ['none', clipsIntent('working', 'full'), { path: '/proc/4242/fd/1', env: { TERM: 'xterm-256color' } }],
  ]) {
    let loads = 0;
    const { bytes } = await captureEmission({
      intent,
      terminal,
      loadAnimation: () => { loads += 1; throw new Error('must not load'); },
    });
    const out = bytes.toString();
    assert.equal(loads, 0, `${label} loaded animation bytes`);
    assert.doesNotMatch(out, /\x1b_G/, `${label} emitted graphics commands`);
    assert.match(out, /\x1b\]11;/, `${label} lost the tint`);
    assert.doesNotMatch(out, /\x1b\]2;/, `${label} replaced the title`);
  }
});

test('absent evidence and changed agent processes select create; an ordinary successor updates', async () => {
  const cases = [
    ['empty ledger', agentAt('idle'), EMPTY_ENTRY, agentAt('working'), 'create'],
    ['first hook', null, EMPTY_ENTRY, agentAt('working'), 'create'],
    ['no graphical evidence after off', agentAt('idle'), stamp({}, { seq: 1, owner: OWNER }), agentAt('working'), 'create'],
    ['new pid', agentAt('idle'), stamp({ held: directHeld('idle') }, { seq: 1, owner: OWNER }), agentAt('working', { pid: 5000, starttime: 22 }), 'create'],
    ['same pid but new starttime', agentAt('idle'), stamp({ held: directHeld('idle') }, { seq: 1, owner: OWNER }), agentAt('working', { pid: 4242, starttime: 22 }), 'create'],
    ['same process with held evidence', agentAt('idle'), stamp({ held: directHeld('idle') }, { seq: 1, owner: OWNER }), agentAt('working'), 'update'],
  ];
  for (const [label, prev, entry, next, expected] of cases) {
    const out = (await captureEmission({ prev, next, ...section({ seq: 2, ledger: memoryLedger(entry) }) })).bytes.toString();
    assert.equal(out.includes('a=T,U=1'), expected === 'create', label);
  }
});

test('bus record mismatches cannot substitute for terminal evidence', async () => {
  for (const [label, mismatch] of [['session id', { sessionId: 'other-session' }], ['pid', { pid: 9999 }], ['state', { state: 'working' }]]) {
    const out = (await captureEmission({
      prev: { ...agentAt('idle'), ...mismatch },
      next: agentAt('working'),
    })).bytes.toString();
    assert.match(out, /a=T,U=1/, `${label} mismatch reused an unproven binding`);
    assert.doesNotMatch(out, /a=a,i=\d+,s=1/, `${label} mismatch selected update`);
  }
});

test('same-state sprite identity changes update the graphical binding', async () => {
  const held = directHeld('working');
  held.intent.sprite = { terminal: '/c/old.png', rows: 7 };
  const out = (await captureEmission({
    prev: agentAt('working'),
    next: agentAt('working'),
    ...section({ seq: 2, ledger: memoryLedger(stamp({ held }, { seq: 1, owner: OWNER })) }),
  })).bytes.toString();
  assert.doesNotMatch(out, /a=T/);
  assert.match(out, /a=c,i=\d+,r=2,c=1,C=1,q=2/);
});

test('a stale animation reference fails before the tty is opened or any byte is emitted', async () => {
  let opened = false;
  let wrote = false;
  await assert.rejects(
    captureEmission({
      loadAnimation: () => { throw new Error('animation reference sha256 changed for member "ginger"'); },
      open: () => { opened = true; return 7; },
      write: () => { wrote = true; return 1; },
    }),
    /animation reference sha256 changed/,
  );
  assert.equal(opened, false);
  assert.equal(wrote, false);
});

test('emit drains short writes and does not retry a mid-write failure', async () => {
  const accepted = [];
  const first = await captureEmission({
    write: (_fd, bytes, offset, length) => {
      const n = Math.min(17, length);
      accepted.push(bytes.subarray(offset, offset + n));
      return n;
    },
  });
  assert.ok(accepted.length > 1);
  assert.equal(first.result.kind, 'transmitted');
  assert.equal(Buffer.concat(accepted).length, first.result.bytes);

  let calls = 0;
  await assert.rejects(
    captureEmission({
      write: () => {
        calls += 1;
        if (calls === 1) return 10;
        throw Object.assign(new Error('tty write failed'), { code: 'EIO' });
      },
    }),
    /tty write failed/,
  );
  assert.equal(calls, 2);
});

// --- the critical section: what the terminal received, not what the bus intended ------

test('the section refuses to run without its evidence, lock, liveness, or order', async () => {
  const base = { prev: null, next: agentAt('working'), intent: clipsIntent(), terminal: KITTY_TERMINAL };
  await assert.rejects(emit({ ...base, ...section({ seq: undefined }) }), /seq/);
  await assert.rejects(emit({ ...base, ...section({ ledger: undefined }) }), /ledger/);
  await assert.rejects(emit({ ...base, ...section({ lock: undefined }) }), /lock/);
  await assert.rejects(emit({ ...base, ...section({ ownerAlive: undefined }) }), /ownerAlive/);
});

test('with no ledger entry a consistent prev/intent is still a CREATE — the bus is not evidence', async () => {
  const { bytes, result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 5 }) });
  assert.equal(result.kind, 'transmitted');
  assert.equal(result.lifecycle, 'create');
  assert.match(bytes.toString('latin1'), /a=T,|a=t,/);
  assert.doesNotMatch(bytes.toString('latin1'), /a=a,i=\d+,s=1/);
});

test('a same-transport, same-owner entry with a changed intent is an UPDATE under Kitty', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld('idle') }, { seq: 1, owner: OWNER }));
  const { bytes, result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 2, ledger }) });
  assert.equal(result.lifecycle, 'update');
  assert.match(bytes.toString('latin1'), /a=a,i=\d+,s=1,q=2/);
  assert.equal(ledger.entry.held.intent.state, 'working');
  assert.equal(ledger.entry.seq, 2);
});

test('a different transport is a CREATE: another client, the same tty path reused, or direct vs tmux', async () => {
  for (const [held, terminal, label] of [
    [{ ...directHeld('idle'), transport: 'tmux:/dev/pts/5:1:1' }, TMUX_TERMINAL, 'another client tty'],
    [{ ...directHeld('idle'), transport: 'tmux:/dev/pts/16:8000:1758100000' }, TMUX_TERMINAL, 'same tty path, new client incarnation'],
    [directHeld('idle'), TMUX_TERMINAL, 'direct evidence, tmux now'],
    [{ ...directHeld('idle'), transport: 'tmux:/dev/pts/16:9001:1758200000' }, KITTY_TERMINAL, 'tmux evidence, direct now'],
  ]) {
    const ledger = memoryLedger(stamp({ held }, { seq: 1, owner: OWNER }));
    const { result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), terminal, ...section({ seq: 2, ledger }) });
    assert.equal(result.lifecycle, 'create', label);
  }
  const same = memoryLedger(stamp({ held: { ...directHeld('idle'), transport: 'tmux:/dev/pts/16:9001:1758200000' } }, { seq: 1, owner: OWNER }));
  const { result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), terminal: TMUX_TERMINAL, ...section({ seq: 2, ledger: same }) });
  assert.equal(result.lifecycle, 'update', 'identical incarnation');
});

test('STATIC capability is always a CREATE, even with valid evidence', async () => {
  const ghostty = { path: '/proc/4242/fd/1', env: { TERM_PROGRAM: 'ghostty' }, tmux: null };
  const ledger = memoryLedger(stamp({ held: { ...directHeld('idle'), capability: GRAPHICS_CAPABILITY.STATIC } }, { seq: 1, owner: OWNER }));
  const first = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), terminal: ghostty, ...section({ seq: 2, ledger }) });
  assert.equal(first.result.lifecycle, 'create');
  const second = await captureEmission({ prev: agentAt('working'), next: agentAt('needs-input'), intent: clipsIntent('needs-input'), terminal: ghostty, ...section({ seq: 3, ledger }) });
  assert.equal(second.result.lifecycle, 'create');
  assert.doesNotMatch(second.bytes.toString('latin1'), /a=a,|a=f,/);
});

test('inside tmux every APC is inside DCS passthrough and none is bare', async () => {
  const { bytes } = await captureEmission({ terminal: TMUX_TERMINAL });
  const text = bytes.toString('latin1');
  assert.equal(bareApcs(text), 0, 'no bare APC');
  assert.ok(text.split('\x1bPtmux;').length > 1);
  // The presentation (tint) is NOT wrapped: tmux handles OSC itself.
  assert.ok(text.includes(`\x1b]11;${COLOR.backdrop}\x1b\\`));
});

test('a refused tmux pane sends tint but no graphics, and leaves the evidence alone', async () => {
  const ledger = memoryLedger(stamp({ held: { ...directHeld('idle'), transport: 'tmux:/dev/pts/16:9001:1758200000' } }, { seq: 1, owner: OWNER }));
  const { bytes, result } = await captureEmission({
    prev: agentAt('idle'), next: agentAt('working'),
    terminal: { ...TMUX_TERMINAL, tmux: { ok: false, reason: 'no-client' } },
    ...section({ seq: 2, ledger }),
  });
  assert.equal(result.kind, 'unchanged');
  assert.doesNotMatch(bytes.toString('latin1'), /_G/);
  assert.ok(bytes.toString('latin1').includes(`\x1b]11;`));
  assert.deepEqual(ledger.entry.held, { ...directHeld('idle'), transport: 'tmux:/dev/pts/16:9001:1758200000' }, 'held preserved: nothing on that client changed');
  assert.equal(ledger.entry.seq, 2);
});

test('three identical hooks after a create send zero graphics bytes and keep held byte-identical', async () => {
  const ledger = memoryLedger();
  await captureEmission({ ...section({ seq: 1, ledger }) });
  const published = JSON.stringify(ledger.entry.held);
  for (const seq of [2, 3, 4]) {
    const { bytes, result } = await captureEmission({ prev: agentAt('working'), next: agentAt('working'), ...section({ seq, ledger }) });
    assert.equal(result.kind, 'unchanged');
    assert.equal(bytes.length, 0);
    assert.equal(JSON.stringify(ledger.entry.held), published);
    assert.equal(ledger.entry.seq, seq);
  }
});

test('an older event arriving after a newer one is SUPERSEDED and writes nothing', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld('needs-input') }, { seq: 2, owner: OWNER }));
  const { bytes, result, opens } = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 1, ledger }) });
  assert.equal(result.kind, 'superseded');
  assert.equal(bytes.length, 0);
  assert.deepEqual(opens, []);
  assert.deepEqual(ledger.writes, []);
});

test('SessionEnd writes a tombstone with prev\'s identity, then the reset; a straggler meets the tombstone', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld() }, { seq: 2, owner: OWNER }));
  const trace = [];
  const end = await captureEmission({
    prev: agentAt('working'), next: null, intent: { identity: { project: 'api' }, pid: 4242, sessionId: 's1' },
    ...section({ seq: 3, ledger: {
      read: ledger.read,
      write: async (entry) => { await ledger.write(entry); trace.push('tombstone'); },
    } }),
    write: (_fd, bytes, offset, length) => {
      assert.equal(ledger.entry.ended, true);
      trace.push(bytes.subarray(offset, offset + length).toString('latin1'));
      return length;
    },
  });
  assert.equal(end.result.kind, 'ended');
  assert.deepEqual(ledger.entry, { seq: 3, pid: 4242, starttime: 987654, held: null, ended: true });
  assert.deepEqual(trace, ['tombstone', '\x1b]111\x1b\\\x1b]112\x1b\\']);
  const straggler = await captureEmission({ prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 2, ledger }) });
  assert.equal(straggler.result.kind, 'superseded');
  assert.equal(straggler.bytes.length, 0);
  assert.deepEqual(straggler.opens, []);
  assert.equal(ledger.writes.length, 1, 'the straggler must not overwrite the tombstone');
  assert.equal(ledger.entry.ended, true);
});

test('the ownership gate withholds EVERY byte from a dead owner: graphics, tint, bell, reset', async () => {
  const dead = { ownerAlive: () => false };
  const shapes = [
    ['graphical', {}],
    ['NONE capability', { terminal: { path: '/proc/4242/fd/1', env: { TERM: 'dumb' }, tmux: null } }],
    ['motion off', { intent: clipsIntent('working', 'off') }],
    ['no sprite', { transmitSprite: false }],
  ];
  for (const [label, overrides] of shapes) {
    const ledger = memoryLedger();
    const { bytes, opens, result } = await captureEmission({ prev: agentAt('idle'), next: agentAt('needs-input'), intent: clipsIntent('needs-input'), ...overrides, ...section({ seq: 2, ledger, ...dead }) });
    assert.equal(result.kind, 'suppressed', label);
    assert.equal(result.reason, 'owner-dead', label);
    assert.equal(bytes.length, 0, label);
    assert.deepEqual(opens, [], label);
    assert.deepEqual(ledger.entry, { seq: 2, pid: 4242, starttime: 987654, held: null, ended: false }, `${label}: identity stamped, nothing held`);
  }
  const ledger = memoryLedger();
  const end = await captureEmission({ prev: agentAt('working'), next: null, intent: { identity: { project: 'api' }, pid: 4242, sessionId: 's1' }, ...section({ seq: 3, ledger, ...dead }) });
  assert.equal(end.result.kind, 'suppressed');
  assert.equal(end.bytes.length, 0);
  assert.equal(ledger.entry.ended, true, 'the tombstone is ordering evidence and is still written');
});

test('the first write under a new owner drops the old owner\'s evidence; the next graphical hook CREATES', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld('working') }, { seq: 5, owner: OWNER }));
  const B = { pid: 5150, starttime: 111 };
  const suppressedShapes = [
    ['NONE capability', { terminal: { path: '/proc/5150/fd/1', env: { TERM: 'dumb' }, tmux: null } }],
    ['tty gate', { checkTty: () => false }],
  ];
  for (const [label, overrides] of suppressedShapes) {
    ledger.write(stamp({ held: directHeld('working') }, { seq: 5, owner: OWNER }));
    const first = await captureEmission({ prev: agentAt('working'), next: agentAt('working', B), ...overrides, ...section({ seq: 6, ledger }) });
    assert.notEqual(first.result.kind, 'transmitted', label);
    assert.deepEqual([ledger.entry.pid, ledger.entry.starttime, ledger.entry.held], [5150, 111, null], `${label}: identity B, nothing inherited`);
    const identical = await captureEmission({ prev: agentAt('working', B), next: agentAt('working', B), ...section({ seq: 7, ledger }) });
    assert.equal(identical.result.kind, 'transmitted', `${label}: identical intent is not 'unchanged' under a new owner`);
    assert.equal(identical.result.lifecycle, 'create');
    const changed = await captureEmission({ prev: agentAt('working', B), next: agentAt('needs-input', B), intent: clipsIntent('needs-input'), ...section({ seq: 8, ledger }) });
    assert.equal(changed.result.lifecycle, 'update', `${label}: after B's own create, B's evidence is valid`);
  }
});

test('a first event that is suppressed or fails the tty gate still stamps its identity', async () => {
  for (const overrides of [{ terminal: { path: '/proc/4242/fd/1', env: { TERM: 'dumb' }, tmux: null } }, { checkTty: () => false }, { open: () => { throw new Error('ENOENT'); } }]) {
    const ledger = memoryLedger();
    await captureEmission({ ...overrides, ...section({ seq: 1, ledger }) });
    assert.deepEqual([ledger.entry.pid, ledger.entry.starttime, ledger.entry.seq], [4242, 987654, 1]);
  }
});

test('renderTransition wraps a static pose only when the probe says tmux is ok', () => {
  const plain = renderTransition({ prev: 'idle', next: 'working', intent: intentAt('working'), readSprite, capability: ANIMATION, tmux: null });
  const wrapped = renderTransition({ prev: 'idle', next: 'working', intent: intentAt('working'), readSprite, capability: ANIMATION, tmux: TMUX_KITTY });
  assert.ok(plain.includes(SPRITE));
  assert.equal(bareApcs(wrapped), 0, 'SPRITE still occurs inside the doubled-ESC form; only an unpreceded ESC _ G is bare');
  assert.ok(wrapped.includes('\x1bPtmux;\x1b\x1b_Ga=T'));
});

// --- ordering inside the section -------------------------------------------

test('a graphical event does read → open → isatty → write-ahead → terminal → publish → close', async () => {
  const trace = [];
  const ledger = {
    read: async () => { trace.push('read'); return EMPTY_ENTRY; },
    write: async (entry) => { trace.push(entry.held === null ? 'write-ahead' : 'publish'); },
  };
  await captureEmission({
    ...section({ ledger }),
    open: () => { trace.push('open'); return 7; },
    checkTty: () => { trace.push('isatty'); return true; },
    write: (_fd, _bytes, _offset, length) => { trace.push('terminal'); return length; },
    close: () => { trace.push('close'); },
  });
  assert.deepEqual(trace, ['read', 'open', 'isatty', 'write-ahead', 'terminal', 'publish', 'close']);
});

// Acquisitions follow the test's call order, independently of filesystem scheduling.
function scriptedLock() {
  const waiting = [];
  let busy = false;
  return async (fn) => {
    if (busy) await new Promise((resolve) => waiting.push(resolve));
    busy = true;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next(); else busy = false;
    }
  };
}

test('both interleavings of S=1 (working) and S=2 (needs-input) end with needs-input on the terminal and in the ledger', async () => {
  for (const order of [[1, 2], [2, 1]]) {
    const ledger = memoryLedger();
    const lock = scriptedLock();
    const writes = [];
    const run = (seq) => captureEmission({
      prev: agentAt('idle'),
      next: agentAt(seq === 1 ? 'working' : 'needs-input'),
      intent: clipsIntent(seq === 1 ? 'working' : 'needs-input'),
      ...section({ seq, ledger, lock }),
      write: (_fd, bytes, offset, length) => {
        writes.push({ seq, bytes: Buffer.from(bytes.subarray(offset, offset + length)) });
        return length;
      },
    });
    const results = await Promise.all(order.map(run));
    const bySeq = Object.fromEntries(order.map((seq, i) => [seq, results[i].result]));
    assert.equal(ledger.entry.held.intent.state, 'needs-input', `order ${order}`);
    assert.equal(ledger.entry.seq, 2, `order ${order}`);
    assert.equal(writes.filter((w) => w.bytes.includes('_G')).at(-1).seq, 2, `order ${order}: the newest event painted last`);
    assert.equal(bySeq[2].kind, 'transmitted');
    if (order[0] === 2) {
      assert.equal(bySeq[1].kind, 'superseded');
      assert.equal(writes.filter((w) => w.seq === 1).length, 0);
      assert.deepEqual(results[1].opens, []);
    } else {
      assert.equal(bySeq[1].kind, 'transmitted');
    }
  }
});

// --- failures with an existing entry ---------------------------------------

test('a terminal write that fails mid-stream leaves held: null, and the next hook CREATES — not unchanged', async () => {
  const ledger = memoryLedger(stamp({ held: directHeld('working') }, { seq: 1, owner: OWNER }));
  let calls = 0;
  let closed = false;
  await assert.rejects(captureEmission({
    prev: agentAt('working'), next: agentAt('needs-input'), intent: clipsIntent('needs-input'),
    ...section({ seq: 2, ledger }),
    write: (_fd, _bytes, _offset, length) => {
      assert.equal(ledger.entry.held, null, 'evidence cleared before every terminal write');
      calls += 1;
      if (calls === 2) throw new Error('EIO');
      assert.ok(length > 1, 'the first write must leave bytes outstanding');
      return 1;
    },
    close: () => { closed = true; },
  }), /EIO/);
  assert.equal(calls, 2);
  assert.equal(closed, true);
  assert.deepEqual([ledger.entry.seq, ledger.entry.held], [2, null]);
  const next = await captureEmission({ prev: agentAt('needs-input'), next: agentAt('working'), ...section({ seq: 3, ledger }) });
  assert.equal(next.result.kind, 'transmitted');
  assert.equal(next.result.lifecycle, 'create');
  assert.match(next.bytes.toString('latin1'), /a=T,U=1/);
});

test('a publish that fails after a complete terminal write leaves held: null; the next hook CREATES', async () => {
  const backing = memoryLedger(stamp({ held: directHeld('working') }, { seq: 1, owner: OWNER }));
  let writesSeen = 0;
  let terminalWritten = false;
  let closed = false;
  const ledger = {
    read: backing.read,
    write: async (entry) => {
      writesSeen += 1;
      if (writesSeen === 2) {
        assert.equal(terminalWritten, true);
        throw new Error('ENOSPC');
      }
      return backing.write(entry);
    },
  };
  await assert.rejects(captureEmission({
    prev: agentAt('working'), next: agentAt('needs-input'), intent: clipsIntent('needs-input'),
    ...section({ seq: 2, ledger }),
    write: (_fd, bytes, offset, length) => {
      assert.equal(offset, 0);
      assert.equal(length, bytes.length);
      terminalWritten = true;
      return length;
    },
    close: () => { closed = true; },
  }), /ENOSPC/);
  assert.equal(closed, true);
  assert.deepEqual([backing.entry.seq, backing.entry.held], [2, null]);
  const next = await captureEmission({ prev: agentAt('needs-input'), next: agentAt('working'), ...section({ seq: 3, ledger: backing }) });
  assert.equal(next.result.kind, 'transmitted');
  assert.equal(next.result.lifecycle, 'create');
  assert.match(next.bytes.toString('latin1'), /a=T,U=1/);
});

test('a failed write-ahead throws before any terminal byte', async () => {
  const ledger = { read: async () => EMPTY_ENTRY, write: async () => { throw new Error('EROFS'); } };
  const writes = [];
  let closed = false;
  await assert.rejects(captureEmission({
    ...section({ ledger }),
    write: (_fd, _bytes, _offset, length) => { writes.push(length); return length; },
    close: () => { closed = true; },
  }), /EROFS/);
  assert.deepEqual(writes, []);
  assert.equal(closed, true);
});

test('a suppressed event (tty or open gate) preserves held and advances seq', async () => {
  for (const overrides of [{ checkTty: () => false }, { open: () => { throw new Error('ENOENT'); } }]) {
    const ledger = memoryLedger(stamp({ held: directHeld('idle') }, { seq: 1, owner: OWNER }));
    const { result, bytes } = await captureEmission({
      prev: agentAt('idle'), next: agentAt('working'), ...section({ seq: 2, ledger }), ...overrides,
    });
    assert.equal(result.kind, 'suppressed');
    assert.equal(bytes.length, 0);
    assert.deepEqual(ledger.entry.held, directHeld('idle'));
    assert.equal(ledger.entry.seq, 2);
  }
});
