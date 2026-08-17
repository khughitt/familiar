import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { stringify } from 'yaml';
import {
  crc32,
  STATES,
  CLIP_ROLES,
  ROLE_SPEC,
  loadAnimationMember,
  loadAnimationRefSync,
  loadThemePackSync,
} from 'familiar-theme';

const MEMBER = 'ginger-tabby';
const fileStat = Object.freeze({ isFile: () => true, isSymbolicLink: () => false });
const SAFE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const scratch = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return out;
}

function png(width = 2, height = 2) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function baseManifest(rootBytes) {
  const digest = sha256(rootBytes);
  return {
    version: 1,
    clips: Object.fromEntries(CLIP_ROLES.map((role) => [role, {
      playback: ROLE_SPEC[role].playback,
      'root-sha256': digest,
      frames: [
        { ref: 'root', 'duration-ms': 100 },
        { ref: 'f01', 'duration-ms': 100 },
        { ref: 'root', 'duration-ms': 100 },
      ],
    }])),
  };
}

function fixture({
  kind = 'clips',
  assetRoot = `prior/static-v1/sprites/${MEMBER}`,
  rootBytes = png(),
  frameBytes = rootBytes,
  manifest = baseManifest(rootBytes),
  manifestBytes = manifest === null ? null : Buffer.from(stringify(manifest)),
  skipFrames = new Set(),
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-animation-'));
  scratch.push(dir);
  const memberDir = join(dir, ...assetRoot.split('/'));
  mkdirSync(memberDir, { recursive: true });
  for (const state of STATES) writeFileSync(join(memberDir, `${state}.png`), rootBytes);

  if (manifestBytes !== null) writeFileSync(join(memberDir, 'animation.yaml'), manifestBytes);
  if (manifest?.clips && typeof manifest.clips === 'object' && !Array.isArray(manifest.clips)) {
    for (const [role, clip] of Object.entries(manifest.clips)) {
      if (!SAFE_ID.test(role) || !Array.isArray(clip?.frames)) continue;
      for (const frame of clip.frames) {
        const ref = frame?.ref;
        if (ref === 'root' || !SAFE_ID.test(ref) || skipFrames.has(`${role}/${ref}`)) continue;
        const path = join(memberDir, 'animation', role, `${ref}.png`);
        mkdirSync(join(memberDir, 'animation', role), { recursive: true });
        writeFileSync(path, typeof frameBytes === 'function' ? frameBytes(role, ref) : frameBytes);
      }
    }
  }
  writeFileSync(join(dir, 'theme.yaml'), `spec-version: 1
id: cats
label: Cats
rows: 4
members:
  - id: ${MEMBER}
    asset-root: ${assetRoot}
    label: Ginger Tabby
    slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    persona: A sufficiently detailed animation asset fixture persona.
    animation: { kind: ${kind} }
    poses:
      idle: idle
      working: working
      needs-input: needs input
      needs-approval: needs approval
      error: error
      done: done
`);

  return {
    dir,
    memberDir,
    manifestPath: join(memberDir, 'animation.yaml'),
    pack: loadThemePackSync(dir),
  };
}

function withManifest(change, options = {}) {
  const rootBytes = options.rootBytes ?? png();
  const manifest = baseManifest(rootBytes);
  change(manifest);
  return fixture({ ...options, rootBytes, manifest });
}

function authoredFrames(manifest, count) {
  let next = 0;
  for (const role of CLIP_ROLES) {
    const remainingRoles = CLIP_ROLES.length - CLIP_ROLES.indexOf(role);
    const take = Math.ceil((count - next) / remainingRoles);
    const refs = Array.from({ length: take }, () => `f${String(++next).padStart(2, '0')}`);
    manifest.clips[role].frames = [
      { ref: 'root', 'duration-ms': 40 },
      ...refs.map((ref) => ({ ref, 'duration-ms': 40 })),
      { ref: 'root', 'duration-ms': 40 },
    ];
  }
  assert.equal(next, count);
}

test('exports the exact five-role contract and returns compact refs plus resolved frames', async () => {
  assert.deepEqual(CLIP_ROLES, [
    'idle-ambient', 'working-loop', 'done-enter', 'error-enter', 'idle-special',
  ]);
  assert.deepEqual(ROLE_SPEC, {
    'idle-ambient': { state: 'idle', playback: 'once' },
    'working-loop': { state: 'working', playback: 'loop' },
    'done-enter': { state: 'done', playback: 'once' },
    'error-enter': { state: 'error', playback: 'once' },
    'idle-special': { state: 'idle', playback: 'once' },
  });
  assert.ok(Object.isFrozen(CLIP_ROLES));
  assert.ok(Object.isFrozen(ROLE_SPEC));

  const built = fixture();
  const result = await loadAnimationMember(built.pack, MEMBER);
  assert.deepEqual(result.ref, {
    kind: 'clips',
    manifest: built.manifestPath,
    sha256: sha256(readFileSync(built.manifestPath)),
  });
  assert.equal(result.set.kind, 'clips');
  assert.deepEqual([...result.set.clips.keys()], CLIP_ROLES);

  const clip = result.set.clips.get('working-loop');
  assert.equal(clip.state, 'working');
  assert.equal(clip.playback, 'loop');
  assert.deepEqual(clip.frames.map(({ ref, durationMs }) => ({ ref, durationMs })), [
    { ref: 'root', durationMs: 100 },
    { ref: 'f01', durationMs: 100 },
    { ref: 'root', durationMs: 100 },
  ]);
  assert.equal(clip.frames[0].path, join(built.memberDir, 'working.png'));
  assert.equal(clip.frames[1].path, join(built.memberDir, 'animation', 'working-loop', 'f01.png'));
  assert.equal(clip.frames[0].width, 2);
  assert.equal(clip.frames[0].height, 2);
  assert.equal(clip.frames[0].decodedBytes, 16);
  assert.equal(existsSync(join(built.memberDir, 'animation', 'working-loop', 'root.png')), false);
});

test('animation loading follows a content-addressed release root without a conventional member path', async () => {
  const digest = 'a'.repeat(64);
  const built = fixture({
    assetRoot: `releases/${digest}/sprites/${MEMBER}`,
  });
  const loaded = await loadAnimationMember(built.pack, MEMBER);
  assert.equal(loaded.set.kind, 'clips');
  assert.equal(
    loaded.ref.manifest,
    join(built.dir, 'releases', digest, 'sprites', MEMBER, 'animation.yaml'),
  );
  assert.equal(existsSync(join(built.dir, 'sprites', MEMBER)), false);
});

for (const [label, mutate, pattern] of [
  ['missing version', (m) => { delete m.version; }, /manifest.*exactly.*version.*clips/i],
  ['unknown version', (m) => { m.version = 2; }, /version.*exactly 1/i],
  ['an extra top-level key', (m) => { m.extra = true; }, /manifest.*exactly.*version.*clips/i],
  ['non-object clips', (m) => { m.clips = []; }, /clips.*object/i],
]) {
  test(`manifest rejects ${label}`, async () => {
    const built = withManifest(mutate);
    await assert.rejects(() => loadAnimationMember(built.pack, MEMBER), pattern);
  });
}

test('a manifest may declare a single role', async () => {
  const built = withManifest((m) => {
    m.clips = { 'idle-ambient': m.clips['idle-ambient'] };
  });
  const result = await loadAnimationMember(built.pack, MEMBER);
  assert.equal(result.set.kind, 'clips');
  assert.deepEqual([...result.set.clips.keys()], ['idle-ambient']);

  const clip = result.set.clips.get('idle-ambient');
  assert.equal(clip.state, 'idle');
  assert.equal(clip.playback, 'once');
  assert.equal(clip.frames[0].path, join(built.memberDir, 'idle.png'));
  assert.equal(
    clip.frames[1].path,
    join(built.memberDir, 'animation', 'idle-ambient', 'f01.png'),
  );
  // The four undeclared roles wrote no authored frames at all.
  assert.equal(existsSync(join(built.memberDir, 'animation', 'working-loop')), false);
});

test('a manifest declaring idle-special without idle-ambient is refused by name', async () => {
  const built = withManifest((manifest) => {
    manifest.clips = { 'idle-special': manifest.clips['idle-special'] };
  });
  await assert.rejects(
    () => loadAnimationMember(built.pack, MEMBER),
    /clips: idle-special requires idle-ambient/,
  );
});

test('idle-special alongside idle-ambient still loads', async () => {
  const built = withManifest((manifest) => {
    manifest.clips = {
      'idle-ambient': manifest.clips['idle-ambient'],
      'idle-special': manifest.clips['idle-special'],
    };
  });
  const loaded = await loadAnimationMember(built.pack, MEMBER);
  assert.deepEqual([...loaded.set.clips.keys()], ['idle-ambient', 'idle-special']);
});

test('declared roles are ordered by CLIP_ROLES, not by manifest key order', async () => {
  // Reversed on purpose: a manifest is a set of declarations, and the runtime
  // order must come from the contract rather than from how the file was written.
  const built = withManifest((m) => {
    m.clips = {
      'idle-special': m.clips['idle-special'],
      'working-loop': m.clips['working-loop'],
      'idle-ambient': m.clips['idle-ambient'],
    };
  });
  const result = await loadAnimationMember(built.pack, MEMBER);
  assert.deepEqual(
    [...result.set.clips.keys()],
    ['idle-ambient', 'working-loop', 'idle-special'],
  );
});

test('a manifest declaring no roles, or an unknown role, fails', async () => {
  const empty = withManifest((m) => { m.clips = {}; });
  await assert.rejects(
    () => loadAnimationMember(empty.pack, MEMBER),
    /member "ginger-tabby".*clips.*at least one.*idle-ambient/i,
  );

  const unknown = withManifest((m) => { m.clips['bonus-loop'] = m.clips['working-loop']; });
  await assert.rejects(
    () => loadAnimationMember(unknown.pack, MEMBER),
    /member "ginger-tabby".*clips.*at least one/i,
  );
});

test('each role has an exact shape and its fixed playback', async () => {
  const extra = withManifest((m) => { m.clips['done-enter'].surprise = true; });
  await assert.rejects(
    () => loadAnimationMember(extra.pack, MEMBER),
    /member "ginger-tabby".*role "done-enter".*exactly.*playback.*root-sha256.*frames/i,
  );

  const playback = withManifest((m) => { m.clips['working-loop'].playback = 'once'; });
  await assert.rejects(
    () => loadAnimationMember(playback.pack, MEMBER),
    /member "ginger-tabby".*role "working-loop".*playback.*loop/i,
  );
});

test('frame objects are exact and unsafe frame ids cannot become paths', async () => {
  const extra = withManifest((m) => { m.clips['error-enter'].frames[1].path = '/etc/passwd'; });
  await assert.rejects(
    () => loadAnimationMember(extra.pack, MEMBER),
    /member "ginger-tabby".*role "error-enter".*frame 1.*exactly.*ref.*duration-ms/i,
  );

  const unsafe = withManifest((m) => { m.clips['working-loop'].frames[1].ref = '../../escape'; });
  await assert.rejects(
    () => loadAnimationMember(unsafe.pack, MEMBER),
    /member "ginger-tabby".*role "working-loop".*frame 1.*invalid/i,
  );
});

test('every clip begins and ends on the reserved symbolic root', async () => {
  const first = withManifest((m) => { m.clips['idle-ambient'].frames[0].ref = 'f00'; });
  await assert.rejects(
    () => loadAnimationMember(first.pack, MEMBER),
    /member "ginger-tabby".*role "idle-ambient".*first frame.*root/i,
  );

  const last = withManifest((m) => { m.clips['idle-special'].frames.at(-1).ref = 'f99'; });
  await assert.rejects(
    () => loadAnimationMember(last.pack, MEMBER),
    /member "ginger-tabby".*role "idle-special".*last frame.*root/i,
  );
});

test('a loop requires equal leading and trailing root durations', async () => {
  const built = withManifest((m) => {
    m.clips['working-loop'].frames[0]['duration-ms'] = 100;
    m.clips['working-loop'].frames.at(-1)['duration-ms'] = 120;
  });
  await assert.rejects(
    () => loadAnimationMember(built.pack, MEMBER),
    /working-loop.*leading.*trailing.*equal/i,
  );
});

test('40ms and 5000ms authored frame boundaries are inclusive', async () => {
  const min = withManifest((m) => {
    for (const clip of Object.values(m.clips)) {
      clip.frames = [{ ref: 'root', 'duration-ms': 40 }, { ref: 'root', 'duration-ms': 40 }];
    }
  });
  await loadAnimationMember(min.pack, MEMBER);

  const max = withManifest((m) => {
    m.clips['working-loop'].frames = [
      { ref: 'root', 'duration-ms': 5000 },
      { ref: 'root', 'duration-ms': 5000 },
    ];
  });
  await loadAnimationMember(max.pack, MEMBER);
});

for (const duration of [39, 5001]) {
  test(`authored frame duration ${duration}ms is rejected outside 40..5000`, async () => {
    const built = withManifest((m) => {
      m.clips['error-enter'].frames[1]['duration-ms'] = duration;
    });
    await assert.rejects(
      () => loadAnimationMember(built.pack, MEMBER),
      new RegExp(`member "ginger-tabby".*role "error-enter".*frame 1.*${duration}.*40.*5000`, 'i'),
    );
  });
}

test('the seam-normalized clip duration accepts 5000ms and rejects 5001ms', async () => {
  const accepted = withManifest((m) => {
    m.clips['working-loop'].frames = [
      { ref: 'root', 'duration-ms': 2500 },
      { ref: 'f01', 'duration-ms': 2500 },
      { ref: 'root', 'duration-ms': 2500 },
    ];
  });
  await loadAnimationMember(accepted.pack, MEMBER);

  const rejected = withManifest((m) => {
    m.clips['working-loop'].frames = [
      { ref: 'root', 'duration-ms': 2500 },
      { ref: 'f01', 'duration-ms': 2501 },
      { ref: 'root', 'duration-ms': 2500 },
    ];
  });
  await assert.rejects(
    () => loadAnimationMember(rejected.pack, MEMBER),
    /member "ginger-tabby".*role "working-loop".*duration.*5001.*5000/i,
  );
});

test('a static member rejects a manifest and otherwise returns an explicit static pair', async () => {
  const withUnexpectedManifest = fixture({ kind: 'static' });
  await assert.rejects(
    () => loadAnimationMember(withUnexpectedManifest.pack, MEMBER),
    /static.*member "ginger-tabby".*manifest/i,
  );

  const clean = fixture({ kind: 'static', manifest: null });
  assert.deepEqual(await loadAnimationMember(clean.pack, MEMBER), {
    ref: { kind: 'static' },
    set: { kind: 'static' },
  });
});

test('a clips member requires animation.yaml', async () => {
  const built = fixture({ manifest: null });
  await assert.rejects(
    () => loadAnimationMember(built.pack, MEMBER),
    /clips.*member "ginger-tabby".*animation\.yaml.*missing/i,
  );
});

for (const [label, bytes, pattern] of [
  ['empty', Buffer.alloc(0), /frame "f01".*empty/i],
  ['truncated', png().subarray(0, -4), /frame "f01".*PNG.*IEND|frame "f01".*truncated/i],
  ['contaminated by trailing garbage', Buffer.concat([png(), Buffer.from('garbage')]), /frame "f01".*trailing garbage/i],
]) {
  test(`a PNG that is ${label} is rejected before the set is returned`, async () => {
    const built = fixture();
    writeFileSync(join(built.memberDir, 'animation', 'done-enter', 'f01.png'), bytes);
    await assert.rejects(() => loadAnimationMember(built.pack, MEMBER), pattern);
  });
}

test('a missing PNG names member, role, and frame', async () => {
  const built = fixture({ skipFrames: new Set(['working-loop/f01']) });
  await assert.rejects(
    () => loadAnimationMember(built.pack, MEMBER),
    /member "ginger-tabby".*role "working-loop".*frame "f01".*missing/i,
  );
});

test('an authored frame must match its role root dimensions', async () => {
  const built = fixture({ frameBytes: (role) => role === 'error-enter' ? png(3, 2) : png() });
  await assert.rejects(
    () => loadAnimationMember(built.pack, MEMBER),
    /member "ginger-tabby".*role "error-enter".*frame "f01".*3x2.*root.*2x2/i,
  );
});

test('root-sha256 binds each clip to the current state root bytes', async () => {
  const built = withManifest((m) => { m.clips['done-enter']['root-sha256'] = '0'.repeat(64); });
  await assert.rejects(
    () => loadAnimationMember(built.pack, MEMBER),
    /member "ginger-tabby".*role "done-enter".*root-sha256.*current root/i,
  );
});

test('a clips member cannot define a state-specific terminal light master', async () => {
  const built = fixture();
  writeFileSync(join(built.memberDir, 'idle.light.png'), png());
  await assert.rejects(
    () => loadAnimationMember(built.pack, MEMBER),
    /clips.*member "ginger-tabby".*state "idle".*\.light\.png/i,
  );
});

test('64 authored frame PNGs pass and 65 fail by name', async () => {
  const rootBytes = png(1, 1);
  const atLimit = baseManifest(rootBytes);
  authoredFrames(atLimit, 64);
  await loadAnimationMember(fixture({ rootBytes, manifest: atLimit }).pack, MEMBER);

  const over = baseManifest(rootBytes);
  authoredFrames(over, 65);
  await assert.rejects(
    () => loadAnimationMember(fixture({ rootBytes, manifest: over }).pack, MEMBER),
    /member "ginger-tabby".*65.*64.*frame PNG/i,
  );
});

test('128 MiB decoded animation pixels pass exactly and one row over fails', async () => {
  const exactBytes = png(1024, 512);
  const exact = baseManifest(exactBytes);
  authoredFrames(exact, 64);
  await loadAnimationMember(
    fixture({ rootBytes: exactBytes, frameBytes: exactBytes, manifest: exact }).pack,
    MEMBER,
  );

  const overBytes = png(1024, 513);
  const over = baseManifest(overBytes);
  authoredFrames(over, 64);
  await assert.rejects(
    () => loadAnimationMember(
      fixture({ rootBytes: overBytes, frameBytes: overBytes, manifest: over }).pack,
      MEMBER,
    ),
    /member "ginger-tabby".*decoded.*128 MiB/i,
  );
});

test('the async loader uses injected promise reads and sync reload verifies the manifest digest', async () => {
  const built = fixture();
  const asyncReads = [];
  const loaded = await loadAnimationMember(built.pack, MEMBER, {
    lstat: lstatSync,
    realpath: realpathSync,
    readFile: async (path) => {
      asyncReads.push(path);
      return readFile(path);
    },
  });
  assert.ok(asyncReads.includes(built.manifestPath));

  const syncReads = [];
  const reloaded = loadAnimationRefSync(loaded.ref, {
    lstat: lstatSync,
    realpath: realpathSync,
    readFile: (path) => {
      syncReads.push(path);
      return readFileSync(path);
    },
  });
  assert.equal(reloaded.clips.get('done-enter').frames[1].ref, 'f01');
  assert.ok(syncReads.includes(built.manifestPath));

  writeFileSync(built.manifestPath, Buffer.from('not: [the, accepted, manifest]'));
  assert.throws(
    () => loadAnimationRefSync(loaded.ref),
    /animation reference.*sha256.*changed/i,
  );
});

test('sync reload rechecks the clips light-master prohibition', async () => {
  const built = fixture();
  const loaded = await loadAnimationMember(built.pack, MEMBER);
  writeFileSync(join(built.memberDir, 'done.light.png'), png());
  assert.throws(
    () => loadAnimationRefSync(loaded.ref),
    /clips.*member "ginger-tabby".*state "done".*\.light\.png/i,
  );
});

test('sync reload rejects malformed compact references before filesystem access', () => {
  let reads = 0;
  assert.throws(
    () => loadAnimationRefSync({ kind: 'clips', manifest: '../../escape', sha256: 'nope' }, {
      readFile: () => { reads++; return Buffer.alloc(0); },
      lstat: () => fileStat,
      realpath: (path) => path,
    }),
    /animation reference.*exact|absolute|sha256/i,
  );
  assert.equal(reads, 0);
});

test('sync reload requires the exact compact reference keys before filesystem access', () => {
  let reads = 0;
  const options = {
    readFile: () => { reads++; return Buffer.alloc(0); },
    lstat: () => fileStat,
    realpath: (path) => path,
  };
  const validValues = {
    kind: 'clips',
    manifest: '/themes/cats/prior/static-v1/sprites/ginger-tabby/animation.yaml',
    sha256: '0'.repeat(64),
  };

  const missing = { ...validValues };
  delete missing.sha256;
  assert.throws(
    () => loadAnimationRefSync(missing, options),
    /animation reference.*exactly.*kind.*manifest.*sha256/i,
  );
  assert.throws(
    () => loadAnimationRefSync({ ...validValues, frames: [] }, options),
    /animation reference.*exactly.*kind.*manifest.*sha256/i,
  );
  assert.equal(reads, 0);
});
