import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIdentities } from '../src/bus/pins.js';
import { makePrepareSprites } from '../bin/familiar';
import { assetsFor, parseThemePack, STATES } from 'familiar-theme';

// NOT 12, and that is deliberate. assetsFor's job is to carry the PACK's number onto the
// asset; a fixture that happened to use the default would keep passing if assets.js
// hardcoded `rows: 12`. 9 is a number the default never produces.
const ROWS = 9;

const pack = {
  id: 'cats',
  dir: '/themes/cats',
  rows: ROWS,
  members: new Map([['ginger-tabby', {
    slots: [3],
    label: 'Ginger',
    assetRoot: 'prior/static-v1/sprites/ginger-tabby',
    assetDir: '/themes/cats/prior/static-v1/sprites/ginger-tabby',
    assetDirProof: 'filesystem',
    animation: { kind: 'static' },
  }]]),
};
const fileStat = Object.freeze({ isFile: () => true, isSymbolicLink: () => false });
const all = () => fileStat;
const identity = (p) => p;
const sprite = (f) => join('/themes/cats', 'prior/static-v1/sprites', 'ginger-tabby', f);

test('resolves one full-colour master for every state', () => {
  const assets = assetsFor(pack, 'ginger-tabby', 'dark', { lstat: all, realpath: identity });
  assert.deepEqual(assets.idle, { terminal: sprite('idle.png'), rows: ROWS });
  assert.equal(Object.keys(assets).length, 6);
});

// --- rows ride on the asset --------------------------------------------------
//
// THIS IS THE SEAM. src/bus/resolve.js does `sprite: spriteFor(member, state)` and
// bin/familiar builds spriteFor out of assetsFor — so putting the row count on the
// asset object is the entire mechanism by which the theme's per-state height reaches
// intent.sprite.rows, with resolve.js and transaction.js untouched. Drop it here and
// the emitter transmits `r=undefined`, which kitty renders as a full-height cat.

test('assetsFor puts the pack\'s rows on EVERY state\'s asset — the paths do not travel alone', () => {
  // KILLS: `rows: 12` hardcoded in assets.js (ROWS is 9), dropping `rows` from the object,
  // and putting it on only the first state.
  const assets = assetsFor(pack, 'ginger-tabby', 'dark', { lstat: all, realpath: identity });
  assert.deepEqual(
    Object.fromEntries(STATES.map((s) => [s, assets[s].rows])),
    Object.fromEntries(STATES.map((s) => [s, ROWS])),
  );
  // ...and the terminal master is still there beside it. A `{ rows }` that replaced it would
  // satisfy the assertion above and break every renderer.
  assert.equal(assets.working.terminal, sprite('working.png'));
});

test('a missing asset throws, naming the member AND the state', () => {
  // MATCH THE QUOTED FORM THE CODE EMITS, not the bare words. The path in the message
  // is `/themes/cats/prior/static-v1/sprites/ginger-tabby/error.png` -- so `/ginger-tabby.*error/s`
  // is satisfied by the PATH and says nothing whatever about the member or the state
  // being named. Task 1 shipped exactly this bug (a regex that matched a filename and
  // claimed to check an error message), and Global Constraints require "a missing asset
  // throws and names the member AND the state". This assertion is that constraint.
  //
  // KILLS: `throw new Error(`assets: missing ${pair[kind]}`)` -- which names neither.
  const missing = (p) => {
    if (!p.endsWith('error.png')) return fileStat;
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  };
  assert.throws(
    () => assetsFor(pack, 'ginger-tabby', 'dark', { lstat: missing, realpath: identity }),
    /member "ginger-tabby".*state "error"/s,
  );
});

test('a missing terminal master says it is missing', () => {
  assert.throws(
    () => assetsFor(pack, 'ginger-tabby', 'dark', {
      lstat: (p) => {
        if (!p.endsWith('idle.png')) return fileStat;
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      realpath: identity,
    }),
    /^Error: assets: terminal sprite missing for member "ginger-tabby" state "idle"/,
  );
});

test('an unknown member throws before it touches the filesystem', () => {
  // "BEFORE it touches the filesystem" is a claim about ORDER, and `lstat: all`
  // counts nothing -- so the old version of this test passed with memberOrThrow moved
  // to AFTER the entire filesystem loop. Spy on the injection: the only way to prove
  // the filesystem was never asked is to record every question it was asked.
  //
  // KILLS: memberOrThrow() called anywhere after the `for (const state of STATES)` loop.
  const seen = [];
  const spy = (p) => { seen.push(p); return fileStat; };
  assert.throws(() => assetsFor(pack, 'nobody', 'dark', { lstat: spy, realpath: identity }), /no member "nobody"/);
  assert.deepEqual(seen, [], 'it asked the filesystem about a member that does not exist');
});

test('light mode takes a light master when present and otherwise uses the base master', () => {
  const onlyIdleLight = (path) => {
    if (!path.includes('.light.') || path.endsWith('idle.light.png')) return fileStat;
    const error = new Error('missing');
    error.code = 'ENOENT';
    throw error;
  };
  const assets = assetsFor(pack, 'ginger-tabby', 'light', { lstat: onlyIdleLight, realpath: identity });
  assert.equal(assets.idle.terminal, sprite('idle.light.png'));
  assert.equal(assets.working.terminal, sprite('working.png'));
});

// DARK NEVER LOOKS. The light-variant rule is the only conditional the theme format
// has, and it is gated on `mode !== 'light'` returning early -- so a dark resolve must
// never so much as ASK whether a light file exists. Nothing above proves that: every
// dark test injects an `lstat` that answers happily either way.
//
// KILLS: deletion of the `if (mode !== 'light') return base;` early return, which
// leaves every other test in this file green (with `lstat: all`, light and dark
// resolve identically right up until a light file is genuinely absent).
test('a dark resolve asks exactly once per state and never probes light variants', () => {
  const lstatSeen = [];
  const realpathSeen = [];
  assetsFor(pack, 'ginger-tabby', 'dark', {
    lstat: (p) => { lstatSeen.push(p); return fileStat; },
    realpath: (p) => { realpathSeen.push(p); return p; },
  });
  assert.deepEqual(lstatSeen.filter((p) => p.includes('.light.')), []);
  assert.equal(lstatSeen.length, 6);
  assert.deepEqual([...realpathSeen].sort(), [...lstatSeen].sort());
  assert.equal(realpathSeen.length, 6);
});

test('a light resolve proves each present light variant once and never probes its base', () => {
  const lstatSeen = [];
  const realpathSeen = [];
  assetsFor(pack, 'ginger-tabby', 'light', {
    lstat: (p) => { lstatSeen.push(p); return fileStat; },
    realpath: (p) => { realpathSeen.push(p); return p; },
  });
  assert.equal(lstatSeen.length, 6);
  assert.equal(realpathSeen.length, 6);
  assert.ok(lstatSeen.every((p) => p.includes('.light.')));
  assert.deepEqual([...realpathSeen].sort(), [...lstatSeen].sort());
});

test('a light resolve with every variant absent costs one failed probe plus one proof per state', () => {
  const lstatSeen = [];
  const realpathSeen = [];
  const lstat = (p) => {
    lstatSeen.push(p);
    if (p.includes('.light.')) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return fileStat;
  };
  assetsFor(pack, 'ginger-tabby', 'light', {
    lstat,
    realpath: (p) => { realpathSeen.push(p); return p; },
  });
  assert.equal(lstatSeen.length, 12);
  assert.equal(realpathSeen.length, 6);
  assert.equal(lstatSeen.filter((p) => p.includes('.light.')).length, 6);
  assert.equal(lstatSeen.filter((p) => !p.includes('.light.')).length, 6);
  assert.ok(realpathSeen.every((p) => !p.includes('.light.')));
});

// KILLS: `{ lstat = () => fileStat }` -- and every other wrong default. Every other test
// in this file injects `lstat`, so the default is invisible to all of them. This is
// the coverage test/pack.test.js:191-207 was carrying for spritePath(); it does not
// get dropped on the floor because its subject was renamed.
test('the DEFAULT exists() reads the real filesystem — no injection', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = {
    id: 'cats',
    dir,
    rows: ROWS,
    members: new Map([['ginger-tabby', {
      slots: [3],
      label: 'Ginger',
      assetRoot: 'sprites/ginger-tabby',
      assetDir: join(dir, 'sprites', 'ginger-tabby'),
      assetDirProof: 'filesystem',
      animation: { kind: 'static' },
    }]]),
  };
  const spriteDir = join(dir, 'sprites', 'ginger-tabby');
  mkdirSync(spriteDir, { recursive: true });
  for (const state of STATES) {
    writeFileSync(join(spriteDir, `${state}.png`), '');
  }
  const assets = assetsFor(real, 'ginger-tabby', 'dark');          // no options
  assert.equal(assets.idle.terminal, join(spriteDir, 'idle.png'));

  rmSync(join(spriteDir, 'error.png'));
  assert.throws(() => assetsFor(real, 'ginger-tabby', 'dark'), /member "ginger-tabby".*state "error"/s);
});

const ADMISSION_POSES = STATES.map((state) => `      ${state}: ${state} pose`).join('\n');

function admissionFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-animation-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pack = parseThemePack(`
spec-version: 1
id: cats
label: Cats
members:
  - id: healthy-cat
    asset-root: sprites/healthy-cat
    label: Healthy Cat
    slots: [3]
    persona: Healthy.
    animation: { kind: clips }
    poses:
${ADMISSION_POSES}
  - id: broken-cat
    asset-root: sprites/broken-cat
    label: Broken Cat
    slots: [9]
    persona: Broken.
    animation: { kind: clips }
    poses:
${ADMISSION_POSES}
  - id: static-cat
    asset-root: sprites/static-cat
    label: Static Cat
    slots: [0, 1, 2, 4, 5, 6, 7, 8, 10, 11]
    persona: Still.
    animation: { kind: static }
    poses:
${ADMISSION_POSES}
`, dir);
  for (const memberId of pack.members.keys()) {
    const memberDir = join(dir, 'sprites', memberId);
    mkdirSync(memberDir, { recursive: true });
    for (const state of STATES) {
      writeFileSync(join(memberDir, `${state}.png`), 'root');
    }
    pack.members.get(memberId).assetDirProof = 'filesystem';
  }
  const catalog = parseIdentities(`
identities:
  - project: healthy
    slot: 3
  - project: broken
    slot: 9
  - project: still
    slot: 0
`);
  return { dir, pack, catalog, tone: { mode: 'dark', satScale: 1 } };
}

function admissionRecord(sessionId, project) {
  return {
    sessionId,
    projectKey: `project:${project}`,
    project,
    remote: null,
    repoRoot: `/repos/${project}`,
    cwd: `/repos/${project}`,
    pid: 100,
    state: 'working',
    updatedAt: 1_000,
  };
}

test('animation admission validates and preflights one clips member once for every session using it', async (t) => {
  const ctx = admissionFixture(t);
  const set = { kind: 'clips', clips: new Map() };
  const ref = {
    kind: 'clips',
    manifest: join(ctx.dir, 'sprites', 'healthy-cat', 'animation.yaml'),
    sha256: 'a'.repeat(64),
  };
  const loaded = [];
  const preflighted = [];
  const prepare = makePrepareSprites(ctx, {
    loadAnimationMember: async (_pack, memberId) => {
      loaded.push(memberId);
      return { ref, set };
    },
    preflightKittyPrograms: (animationSet, options) => {
      preflighted.push({ animationSet, options });
      return { programs: new Map(), worst: { frames: 1 } };
    },
  });

  const prepared = await prepare({
    a: admissionRecord('a', 'healthy'),
    b: admissionRecord('b', 'healthy'),
  });

  assert.deepEqual(loaded, ['healthy-cat']);
  assert.equal(preflighted.length, 1);
  assert.strictEqual(preflighted[0].animationSet, set);
  assert.deepEqual(Object.keys(preflighted[0].options.roots), STATES);
  assert.strictEqual(prepared.animationFor('healthy-cat'), ref);
  assert.strictEqual(prepared.animationSetFor('healthy-cat'), set);
  assert.equal(prepared.faults.size, 0);
});

test('a malformed animation faults only its member even for Ghostty; static is explicit, never fallback', async (t) => {
  const ctx = { ...admissionFixture(t), capability: 'static-graphics' };
  const loaded = [];
  const prepare = makePrepareSprites(ctx, {
    loadAnimationMember: async (_pack, memberId) => {
      loaded.push(memberId);
      if (memberId === 'broken-cat') {
        throw new Error('animation: member "broken-cat" manifest has unknown role "wobble"');
      }
      if (memberId === 'static-cat') {
        return { ref: { kind: 'static' }, set: { kind: 'static' } };
      }
      return {
        ref: {
          kind: 'clips',
          manifest: join(ctx.dir, 'sprites', memberId, 'animation.yaml'),
          sha256: 'b'.repeat(64),
        },
        set: { kind: 'clips', clips: new Map() },
      };
    },
    preflightKittyPrograms: () => ({ programs: new Map(), worst: {} }),
  });

  const prepared = await prepare({
    good: admissionRecord('good', 'healthy'),
    bad: admissionRecord('bad', 'broken'),
    still: admissionRecord('still', 'still'),
  });

  assert.deepEqual(loaded.sort(), ['broken-cat', 'healthy-cat', 'static-cat']);
  assert.deepEqual([...prepared.identities.keys()].sort(), ['good', 'still']);
  assert.match(prepared.faults.get('bad'), /unknown role "wobble"/);
  assert.deepEqual(prepared.animationFor('static-cat'), { kind: 'static' });
  assert.throws(
    () => prepared.animationFor('broken-cat'),
    /no animation for member "broken-cat"/,
  );
});
