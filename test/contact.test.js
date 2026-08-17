import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeStrip, composeGrid, scaleTo, padTo } from '../src/render/term/contact.js';
import { decodeRgba } from 'familiar-theme';
import { STATES, encodeRgba } from 'familiar-theme';

// A frame of one flat colour, so every assertion below is about GEOMETRY. The layout is
// the whole of what this module does; colour fidelity is the codec's job and is proved
// where the codec is.
function solid(w, h, [r, g, b, a] = [10, 20, 30, 255]) {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = a; }
  return { w, h, buf };
}
const at = (f, x, y) => [f.buf[(y * f.w + x) * 4], f.buf[(y * f.w + x) * 4 + 1],
  f.buf[(y * f.w + x) * 4 + 2], f.buf[(y * f.w + x) * 4 + 3]];

test('a strip is as wide as its frames plus the gaps between them', () => {
  const strip = composeStrip([solid(4, 6), solid(5, 6), solid(3, 6)], { gap: 2 });
  assert.equal(strip.w, 4 + 5 + 3 + 2 * 2);
  assert.equal(strip.h, 6);
});

test('a single frame carries no gap', () => {
  assert.equal(composeStrip([solid(4, 6)], { gap: 9 }).w, 4);
});

// FLOOR-ANCHORED, and this is the assertion that matters: compile.mjs sits every pose on
// a shared floor, so a shorter frame must hang from the BOTTOM. Aligning to the top would
// put a sleeping cat in mid-air next to a standing one.
test('a short frame sits on the floor, not the ceiling', () => {
  const strip = composeStrip([solid(2, 6, [1, 2, 3, 255]), solid(2, 2, [9, 9, 9, 255])]);
  assert.equal(strip.h, 6);
  assert.deepEqual(at(strip, 2, 0), [0, 0, 0, 0], 'the short frame must be empty at the top');
  assert.deepEqual(at(strip, 2, 5), [9, 9, 9, 255], 'and present at the bottom');
});

test('a grid is as wide as its widest row and as tall as its rows plus the row gaps', () => {
  const grid = composeGrid([[solid(4, 6), solid(4, 6)], [solid(4, 6)]], { gap: 2, rowGap: 3 });
  assert.equal(grid.w, 4 + 4 + 2);
  assert.equal(grid.h, 6 + 3 + 6);
});

test('an empty strip or grid is refused rather than producing a zero-size image', () => {
  assert.throws(() => composeStrip([]), /at least one frame/);
  assert.throws(() => composeGrid([]), /at least one row/);
  assert.throws(() => composeStrip([solid(1, 1)], { gap: -1 }), /non-negative/);
});

// NEAREST-NEIGHBOUR. Averaging across a block boundary turns the hard staircase this art
// is made of into a gradient — the exact defect the style atom spent four rounds removing.
// A two-colour frame halved must still hold exactly those two colours and no third.
test('scaling never invents an intermediate colour', () => {
  const f = solid(4, 4, [0, 0, 0, 255]);
  for (let y = 0; y < 4; y++) for (let x = 2; x < 4; x++) {
    const i = (y * 4 + x) * 4; f.buf[i] = 255; f.buf[i + 1] = 255; f.buf[i + 2] = 255;
  }
  const half = scaleTo(f, { height: 2 });
  assert.equal(half.h, 2);
  assert.equal(half.w, 2);
  const reds = new Set();
  for (let i = 0; i < half.w * half.h; i++) reds.add(half.buf[i * 4]);
  assert.deepEqual([...reds].sort((a, b) => a - b), [0, 255]);
});

test('scaling preserves aspect and refuses a nonsense height', () => {
  assert.equal(scaleTo(solid(40, 20), { height: 10 }).w, 20);
  assert.throws(() => scaleTo(solid(4, 4), { height: 0 }), /positive integer/);
});

// The box exists so column N lines up down the whole sheet; centred horizontally and on
// the floor vertically, matching how the art is drawn.
test('padding centres horizontally and sits on the floor', () => {
  const p = padTo(solid(2, 2, [7, 7, 7, 255]), { width: 6, height: 4 });
  assert.equal(p.w, 6); assert.equal(p.h, 4);
  assert.deepEqual(at(p, 2, 3), [7, 7, 7, 255]);
  assert.deepEqual(at(p, 2, 0), [0, 0, 0, 0]);
  assert.deepEqual(at(p, 0, 3), [0, 0, 0, 0]);
});

// A frame wider than its box would have to be CLIPPED, and a contact sheet that silently
// crops the persian's flared coat to keep its columns tidy is lying about the art.
test('a frame that does not fit its box is refused rather than clipped', () => {
  assert.throws(() => padTo(solid(8, 2), { width: 6, height: 4 }), /does not fit/);
});

// ── the CLI ──────────────────────────────────────────────────────────────────
const bin = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const ttyBin = fileURLToPath(new URL('fixtures/tty-familiar.mjs', import.meta.url));

// The engine ships no art, and the sheet's whole geometry claim below (twelve
// ROWS, six state COLUMNS, hence portrait) depends on having more members
// than states — the committed single-member engine fixture cannot stand in
// for that. Self-authored instead: twelve single-slot members, same shape as
// the real roster, built once and reused via FAMILIAR_THEMES_DIR.
function writeTwelveMemberTheme(dir) {
  const buf = Buffer.alloc(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      buf[i] = 150;
      if (x >= 1 && x <= 6 && y >= 1) buf[i + 3] = 255;
    }
  }
  const png = encodeRgba({ w: 8, h: 8, buf });
  const poseBlock = STATES.map((state) => `      ${state}: flat grey square`).join('\n');
  const members = [];
  for (let slot = 0; slot < 12; slot++) {
    const id = `m${slot}`;
    const spritesDir = join(dir, 'sprites', id);
    mkdirSync(spritesDir, { recursive: true });
    for (const state of STATES) writeFileSync(join(spritesDir, `${state}.png`), png);
    members.push([
      `  - id: ${id}`,
      `    asset-root: sprites/${id}`,
      `    label: M${slot}`,
      `    slots: [${slot}]`,
      `    persona: synthetic member ${slot} of twelve, one per slot like the real roster`,
      '    animation:',
      '      kind: static',
      '    poses:',
      poseBlock,
    ].join('\n'));
  }
  writeFileSync(join(dir, 'theme.yaml'), [
    'spec-version: 1',
    'id: cats',
    'label: Cats',
    'rows: 4',
    'members:',
    ...members,
    '',
  ].join('\n'));
}

const shippedThemesFixture = mkdtempSync(join(tmpdir(), 'familiar-contact-shipped-'));
writeTwelveMemberTheme(join(shippedThemesFixture, 'cats'));

function cliEnv() {
  const configDir = mkdtempSync(join(tmpdir(), 'familiar-contact-cfg-'));
  writeFileSync(join(configDir, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  const env = { ...process.env, FAMILIAR_CONFIG_DIR: configDir,
    FAMILIAR_STATE_DIR: mkdtempSync(join(tmpdir(), 'familiar-contact-state-')),
    FAMILIAR_THEMES_DIR: shippedThemesFixture };
  delete env.TMUX; delete env.TERM; delete env.KITTY_WINDOW_ID; delete env.TERM_PROGRAM;
  delete env.GHOSTTY_RESOURCES_DIR; delete env.GHOSTTY_BIN_DIR;
  return env;
}
const run = (...args) => spawnSync(process.execPath, [bin, 'theme', 'sheet', ...args],
  { encoding: 'utf8', env: cliEnv(), maxBuffer: 64 * 1024 * 1024 });
const runTty = (...args) => spawnSync(process.execPath, [ttyBin, 'theme', 'sheet', ...args],
  { encoding: 'utf8', env: cliEnv(), maxBuffer: 64 * 1024 * 1024 });

// --out is the path that works WITHOUT kitty graphics, which is the only way to see this
// sheet on an ordinary terminal — so it is the one that gets the geometry assertion.
test('--out writes one PNG holding every member and every state', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'familiar-contact-out-')), 'sheet.png');
  const result = run('--theme', 'cats', '--out', out);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(out));
  const png = decodeRgba(readFileSync(out));
  assert.ok(png.w > 0 && png.h > 0);
  // Six columns wide and twelve rows tall, so the sheet is markedly taller than it is wide.
  assert.ok(png.h > png.w, `expected a portrait sheet, got ${png.w}x${png.h}`);
  assert.match(result.stdout, /12 members x 6 states/);
});

test('--member narrows the sheet to one row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-contact-one-'));
  const all = join(dir, 'all.png');
  const one = join(dir, 'one.png');
  assert.equal(run('--theme', 'cats', '--out', all).status, 0);
  const result = run('--theme', 'cats', '--member', 'm3', '--out', one);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 member x 6 states/);
  assert.ok(decodeRgba(readFileSync(one)).h < decodeRgba(readFileSync(all)).h);
});

test('every state gets a column', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'familiar-contact-cols-')), 'sheet.png');
  const result = run('--theme', 'cats', '--member', 'm0', '--out', out);
  assert.equal(result.status, 0, result.stderr);
  for (const state of STATES) assert.match(result.stdout, new RegExp(state));
});

// Same flag discipline as `theme` and `preview`: an unknown flag names itself and the
// legal ones, a repeat is refused rather than letting the second value silently win, and
// a flag with no value does not fall back to a default.
test('flags are refused precisely rather than silently ignored', () => {
  const unknown = run('--nope', 'x');
  assert.match(unknown.stderr, /unknown option.*--nope/i);
  assert.match(unknown.stderr, /familiar theme sheet --help/);
  assert.match(run('--rows', '4', '--rows', '5').stderr, /duplicate --rows/);
  assert.match(run('--theme').stderr, /--theme <value>.*missing/i);
  assert.match(run('--rows', '999').stderr, /--rows must be a whole number/);
  assert.notEqual(unknown.status, 0);
});

// A terminal with no kitty graphics gets a NAMED reason and a way forward, not a silent
// list of captions with nothing above them.
test('a non-graphical terminal says so and names --out', () => {
  const result = runTty('--theme', 'cats');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /does not advertise kitty graphics/);
  assert.match(result.stderr, /--out/);
  assert.match(result.stdout, /m3/);
  assert.doesNotMatch(result.stdout, /\x1b_G/);
});
