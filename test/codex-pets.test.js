import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  spritesheet, sampleTimeline, fitFrame, petFile, FRAME, SPRITESHEET_PATH,
} from '../src/render/codex/pets.js';
import { decodeRgba, encodeRgba } from 'familiar-theme';
import { STATES, loadThemePackSync, memberAssetDir } from 'familiar-theme';

const themeDir = fileURLToPath(new URL('../test/fixtures/theme-pack', import.meta.url));
const pack = loadThemePackSync(themeDir);
const sprite = (member, state) =>
  decodeRgba(readFileSync(join(memberAssetDir(pack, member), `${state}.png`)));

const posesOf = (member) => Object.fromEntries(STATES.map((state) => [state, sprite(member, state)]));
const staticSheet = (member, motionPolicy = 'full') => spritesheet({
  animationSet: { kind: 'static' },
  roots: posesOf(member),
  motionPolicy,
});

const pixel = (r, g = 0, b = 0) => ({
  w: 1,
  h: 1,
  buf: Uint8Array.from([r, g, b, 255]),
});

function clip(state, playback, entries) {
  return {
    state,
    playback,
    frames: entries.map(([ref, durationMs]) => ({ ref, durationMs, path: `/frames/${ref}.png` })),
  };
}

function clipsFixture() {
  const roots = {
    idle: pixel(10),
    working: pixel(20),
    'needs-input': pixel(30),
    'needs-approval': pixel(40),
    error: pixel(50),
    done: pixel(60),
  };
  const images = new Map([
    ['/frames/idle-a.png', pixel(11)],
    ['/frames/work-a.png', pixel(21)],
    ['/frames/work-b.png', pixel(22)],
    ['/frames/work-c.png', pixel(23)],
    ['/frames/done-a.png', pixel(61)],
    ['/frames/done-b.png', pixel(62)],
    ['/frames/error-a.png', pixel(51)],
    ['/frames/error-b.png', pixel(52)],
  ]);
  const clips = new Map([
    ['idle-ambient', clip('idle', 'once', [
      ['root', 100], ['idle-a', 400], ['root', 100],
    ])],
    ['working-loop', clip('working', 'loop', [
      ['root', 100], ['work-a', 500], ['work-b', 200], ['work-c', 200], ['root', 100],
    ])],
    ['done-enter', clip('done', 'once', [
      ['root', 100], ['done-a', 500], ['done-b', 100], ['root', 100],
    ])],
    ['error-enter', clip('error', 'once', [
      ['root', 400], ['error-a', 100], ['error-b', 100], ['root', 200],
    ])],
    ['idle-special', clip('idle', 'once', [
      ['root', 100], ['idle-a', 100], ['root', 100],
    ])],
  ]);
  for (const role of clips.values()) {
    for (const frame of role.frames) {
      if (frame.ref === 'root') images.set(frame.path, roots[role.state]);
    }
  }
  return {
    animationSet: { kind: 'clips', clips },
    roots,
    readFrame: (path) => images.get(path),
  };
}

function cellRed(sheet, cell) {
  const x = (cell % FRAME.columns) * FRAME.width + (FRAME.width >> 1);
  const y = ((cell / FRAME.columns) | 0) * FRAME.height + FRAME.height - 1;
  return sheet.buf[(y * sheet.w + x) * 4];
}

test('the sheet is exactly the geometry Codex accepts', () => {
  const sheet = staticSheet('pip');
  assert.equal(sheet.w, 1536);
  assert.equal(sheet.h, 1872);
  assert.equal(sheet.buf.length, 1536 * 1872 * 4);
  assert.ok(encodeRgba(sheet).length <= 20 * 1024 * 1024);
});

test('every member produces the same sheet dimensions whatever its canvas', () => {
  const visited = [...pack.members.keys()];
  const dims = new Set(
    visited.map((member) => {
      const { w, h } = staticSheet(member);
      return `${w}x${h}`;
    }),
  );
  assert.equal(visited.length, 1);
  assert.deepEqual([...dims], ['1536x1872']);
});

test('duration sampling includes both endpoints and repeats the active frame', () => {
  const frames = clip('idle', 'once', [
    ['root', 100], ['active', 400], ['root', 100],
  ]).frames;
  assert.deepEqual(
    sampleTimeline(frames, 6, { includeEndpoints: true }).map((frame) => frame.ref),
    ['root', 'active', 'active', 'active', 'active', 'root'],
  );
});

test('full motion duration-samples canonical clips into fixed cells', () => {
  const sheet = spritesheet({ ...clipsFixture(), motionPolicy: 'full' });
  assert.deepEqual([...Array(20)].map((_, cell) => cellRed(sheet, cell)), [
    10, 11, 11, 11, 11, 10,
    21, 22,
    60, 61, 61, 61, 62, 60,
    50, 50, 50, 51, 50, 50,
  ]);
});

test('working samples exclude the trailing loop-seam root and use quarter instants', () => {
  const sheet = spritesheet({ ...clipsFixture(), motionPolicy: 'full' });
  assert.deepEqual([cellRed(sheet, 6), cellRed(sheet, 7)], [21, 22]);
});

test('reduced and static members fill occupied cells with corresponding state roots', () => {
  const reduced = spritesheet({ ...clipsFixture(), motionPolicy: 'reduced' });
  assert.deepEqual([...Array(20)].map((_, cell) => cellRed(reduced, cell)), [
    10, 10, 10, 10, 10, 10,
    20, 20,
    60, 60, 60, 60, 60, 60,
    50, 50, 50, 50, 50, 50,
  ]);

  const staticMember = staticSheet('pip');
  assert.ok(staticMember.buf.some((value) => value !== 0));
});

test('cells 20-71 are exactly transparent', () => {
  const sheet = spritesheet({ ...clipsFixture(), motionPolicy: 'full' });
  for (let cell = 20; cell < FRAME.columns * FRAME.rows; cell++) {
    const ox = (cell % FRAME.columns) * FRAME.width;
    const oy = ((cell / FRAME.columns) | 0) * FRAME.height;
    for (let y = 0; y < FRAME.height; y++) {
      const start = ((oy + y) * sheet.w + ox) * 4;
      assert.equal(
        sheet.buf.subarray(start, start + FRAME.width * 4).some((value) => value !== 0),
        false,
        `cell ${cell} row ${y} is not transparent`,
      );
    }
  }
});

test('the manifest owns every reachable Codex semantic track and one-shot fallback', () => {
  const pet = petFile({ id: 'x', displayName: 'X', description: 'x' });
  assert.deepEqual(pet.animations, {
    idle: { frames: [0, 1, 2, 3, 4, 5], fps: 1, loop: true },
    running: { frames: [6], fps: 1, loop: true },
    waiting: { frames: [7], fps: 1, loop: true },
    review: { frames: [8, 9, 10, 11, 12, 13], fps: 8, loop: false, fallback: 'review-root-hold' },
    'review-root-hold': { frames: [13], fps: 1, loop: true },
    failed: { frames: [14, 15, 16, 17, 18, 19], fps: 8, loop: false, fallback: 'failed-root-hold' },
    'failed-root-hold': { frames: [19], fps: 1, loop: true },
  });
});

test('the cat stands on a floor and keeps 1-bit alpha', () => {
  for (const state of STATES) {
    const cell = fitFrame(sprite('pip', state), FRAME);
    let lastRow = -1;
    for (let y = FRAME.height - 1; y >= 0 && lastRow < 0; y--) {
      for (let x = 0; x < FRAME.width; x++) {
        if (cell[(y * FRAME.width + x) * 4 + 3] !== 0) { lastRow = y; break; }
      }
    }
    assert.ok(lastRow >= FRAME.height - 2, `${state}: last ink row is ${lastRow}`);
    const alphas = new Set();
    for (let i = 3; i < cell.length; i += 4) alphas.add(cell[i]);
    assert.deepEqual([...alphas].sort((a, b) => a - b), [0, 255]);
  }
});

test('a missing required root is refused, not rendered as a hole', () => {
  const roots = posesOf('pip');
  delete roots.working;
  assert.throws(() => spritesheet({
    animationSet: { kind: 'static' }, roots, motionPolicy: 'full',
  }), /no sprite for working/);
});

test('the spritesheet lives under assets', () => {
  assert.match(SPRITESHEET_PATH, /^assets\//);
  assert.equal(petFile({ id: 'x', displayName: 'X', description: 'x' }).spritesheetPath, SPRITESHEET_PATH);
});
