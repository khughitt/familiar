import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSpriteRuntime } from './sprite-runtime.js';
import { hidePlacement, freeImage } from './sprite.js';
import { pngSize } from '../../src/render/term/box.js';
import { planAnimation } from '../../src/animation/program.js';
import { encodeKittyProgram } from '../../src/render/term/kitty-animation.js';

const validPng = readFileSync(fileURLToPath(
  new URL('../../test/fixtures/theme-pack/sprites/pip/idle.png', import.meta.url),
));

const intent = (path, state = 'working', {
  motionPolicy = 'full',
  animation = { kind: 'static' },
} = {}) => ({
  sessionId: 'session-42',
  state,
  motionPolicy,
  animation,
  sprite: { terminal: path, rows: 8 },
});

const record = (path, state = 'working', {
  expiresAt = null,
  after = null,
  motionPolicy = 'full',
  animation = { kind: 'static' },
} = {}) => ({
  'opencode:42': {
    current: intent(path, state, { motionPolicy, animation }),
    expiresAt,
    after: after === null ? null : intent(after.sprite.terminal, after.state, {
      motionPolicy: after.motionPolicy ?? motionPolicy,
      animation: after.animation ?? animation,
    }),
  },
});

const CLIPS_REF = Object.freeze({
  kind: 'clips',
  manifest: '/theme/sprites/ginger-tabby/animation.yaml',
  sha256: 'a'.repeat(64),
});

const clipsSet = (root = '/a.png') => Object.freeze({
  kind: 'clips',
  clips: new Map([
    ['working-loop', Object.freeze({
      state: 'working',
      playback: 'loop',
      frames: Object.freeze([
        Object.freeze({ ref: 'root', path: root, durationMs: 100, decodedBytes: 4 }),
        Object.freeze({ ref: 'step', path: '/step.png', durationMs: 100, decodedBytes: 4 }),
        Object.freeze({ ref: 'root', path: root, durationMs: 100, decodedBytes: 4 }),
      ]),
    })],
  ]),
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeWatcher extends EventEmitter {
  constructor(onEvent, events) {
    super();
    this.onEvent = onEvent;
    this.events = events;
  }
  change(filename = 'intent.json') { this.onEvent('rename', filename); }
  close() { this.events.push('watch-close'); this.emit('close'); }
}

function harness(overrides = {}) {
  const events = [];
  const writes = [];
  const errors = [];
  const watchers = [];
  const rows = [];
  let intent = null;
  let renderRequests = 0;
  const encodes = [];
  const renderer = new EventEmitter();
  renderer.isDestroyed = false;
  renderer.requestRender = () => { renderRequests++; };

  const deps = {
    pid: 42,
    stateDir: '/state',
    intentPath: '/state/intent.json',
    imageId: 4096,
    placementId: 1,
    maxRows: 16,
    capability: 'kitty-animation',
    now: () => 0,
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: () => {},
    ensureDirectory: (path) => { events.push(`mkdir:${path}`); },
    watchDirectory: (path, onEvent) => {
      events.push(`watch:${path}`);
      const watcher = new FakeWatcher(onEvent, events);
      watchers.push(watcher);
      return watcher;
    },
    readIntent: async (path) => { events.push(`read:${path}`); return intent; },
    readPng: (path) => Buffer.from(`png:${path}`),
    sizePng: () => ({ w: 20, h: 20 }),
    loadAnimation: (animation) => animation.kind === 'static' ? { kind: 'static' } : clipsSet(),
    plan: planAnimation,
    encode: (program, options) => {
      options.readFrame(program.root);
      encodes.push({ program, options: { ...options, readFrame: undefined } });
      return { bytes: Buffer.from(`program:${options.lifecycle}:${program.kind}:${program.root}`) };
    },
    writeTerminal: (output) => { writes.push(output); },
    renderer,
    onPoseChange: (height) => { rows.push(height); },
    logError: (message) => { errors.push(message); },
    ...overrides,
  };
  const runtime = createSpriteRuntime(deps);
  return {
    runtime, deps, events, writes, errors, watchers, rows, renderer, encodes,
    setIntent: (value) => { intent = value; },
    renderRequests: () => renderRequests,
  };
}

test('sprite-runtime: watcher attaches before the authoritative refresh', async () => {
  const h = harness();
  await h.runtime.start();
  assert.deepEqual(h.events.slice(0, 3), [
    'mkdir:/state', 'watch:/state', 'read:/state/intent.json',
  ]);
});

test('sprite-runtime: refresh and watcher callbacks only queue work and request a frame', async () => {
  const h = harness();
  h.setIntent(record('/a.png'));
  await h.runtime.start();
  assert.deepEqual(h.writes, []);
  assert.equal(h.renderRequests(), 1);

  h.setIntent(record('/b.png'));
  h.watchers[0].change();
  await tick();
  assert.deepEqual(h.writes, []);
  assert.equal(h.renderRequests(), 2);
});

test('sprite-runtime: first full Kitty frame uploads one complete animation before placement; later frames place only', async () => {
  const h = harness({
    readPng: () => validPng,
    sizePng: pngSize,
    loadAnimation: () => clipsSet('/a.png'),
    encode: encodeKittyProgram,
  });
  h.setIntent(record('/a.png', 'working', { animation: CLIPS_REF }));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();

  const program = Buffer.isBuffer(h.writes[0]) ? h.writes[0].toString() : h.writes[0];
  assert.match(program, /\x1b_Ga=t,/);
  assert.doesNotMatch(program, /\x1b_Ga=T,/);
  assert.match(program, /\x1b_Ga=f,/);
  assert.match(program, /\x1b_Ga=a,i=4096,s=3,v=1/);
  assert.match(String(h.writes[1]), /\x1b_Ga=p,i=4096/);
  assert.equal(h.writes.join('').match(/\x1b_Ga=p,i=4096,p=1/g)?.length, 1);

  h.writes.length = 0;
  h.runtime.captureBox({ x: 2, y: 3, width: 10, height: 8 });
  h.runtime.frame();
  assert.equal(h.writes.length, 1);
  assert.match(String(h.writes[0]), /\x1b\[4;3H.*\x1b_Ga=p,i=4096/);
});

test('sprite-runtime: state, policy, and clips digest changes queue in-place updates under one image id', async () => {
  const h = harness({
    plan: ({ root, state }) => ({ kind: 'static', state, root }),
  });
  h.setIntent(record('/a.png', 'working', { animation: CLIPS_REF }));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();

  for (const next of [
    record('/idle.png', 'idle', { animation: { ...CLIPS_REF, sha256: 'b'.repeat(64) } }),
    record('/idle.png', 'idle', {
      animation: { ...CLIPS_REF, sha256: 'b'.repeat(64) },
      motionPolicy: 'reduced',
    }),
  ]) {
    h.setIntent(next);
    h.watchers[0].change();
    await tick();
    h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
    h.runtime.frame();
  }

  assert.deepEqual(h.encodes.map(({ options }) => options.lifecycle), ['create', 'update', 'update']);
  assert.deepEqual(h.encodes.map(({ options }) => options.id), [4096, 4096, 4096]);
});

test('sprite-runtime: failed animated transmit keeps recovery hide pending and recreates later', async () => {
  let failProgram = false;
  let failHide = false;
  const h = harness({
    plan: ({ root, state }) => ({ kind: 'static', state, root }),
    writeTerminal: (output) => {
      h.writes.push(output);
      if (failProgram && Buffer.isBuffer(output)) throw new Error('program blocked');
      if (failHide && output === hidePlacement(4096, 1)) throw new Error('hide blocked');
    },
  });
  h.setIntent(record('/a.png', 'working', { animation: CLIPS_REF }));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();

  failProgram = true;
  failHide = true;
  h.setIntent(record('/b.png', 'working', {
    animation: { ...CLIPS_REF, sha256: 'b'.repeat(64) },
  }));
  h.watchers[0].change();
  await tick();
  h.runtime.frame();
  const failedHideAttempts = h.writes.filter((x) => x === hidePlacement(4096, 1)).length;
  assert.equal(failedHideAttempts, 1);

  failProgram = false;
  failHide = false;
  h.runtime.frame();
  assert.equal(h.writes.filter((x) => x === hidePlacement(4096, 1)).length, 2);

  h.setIntent(record('/b.png', 'working', {
    animation: { ...CLIPS_REF, sha256: 'b'.repeat(64) },
  }));
  h.watchers[0].change();
  await tick();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  assert.equal(h.encodes.at(-1).options.lifecycle, 'create');
});

for (const [name, capability, motionPolicy] of [
  ['reduced Kitty', 'kitty-animation', 'reduced'],
  ['full Ghostty', 'static-graphics', 'full'],
]) {
  test(`sprite-runtime: ${name} uploads only the current root`, async () => {
    const h = harness({
      capability,
      readPng: () => validPng,
      sizePng: pngSize,
      loadAnimation: (ref) => clipsSet(ref.sha256 === 'b'.repeat(64) ? '/b.png' : '/a.png'),
      encode: encodeKittyProgram,
    });
    h.setIntent(record('/a.png', 'working', { animation: CLIPS_REF, motionPolicy }));
    await h.runtime.start();
    h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
    h.runtime.frame();

    const output = Buffer.isBuffer(h.writes[0]) ? h.writes[0].toString() : h.writes[0];
    assert.match(output, /\x1b_Ga=t,/);
    assert.doesNotMatch(output, /\x1b_Ga=T,/);
    assert.doesNotMatch(output, /\x1b_Ga=f,|\x1b_Ga=a,/);

    if (capability === 'static-graphics') {
      h.writes.length = 0;
      h.setIntent(record('/b.png', 'working', {
        animation: { ...CLIPS_REF, sha256: 'b'.repeat(64) },
        motionPolicy,
      }));
      h.watchers[0].change();
      await tick();
      h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
      h.runtime.frame();
      const changed = Buffer.isBuffer(h.writes[0]) ? h.writes[0].toString() : h.writes[0];
      assert.match(changed, /\x1b_Ga=t,/);
      assert.doesNotMatch(changed, /\x1b_Ga=T,/);
      assert.doesNotMatch(changed, /\x1b_Ga=f,|\x1b_Ga=a,/);
    }
  });
}

test('sprite-runtime: off reserves zero rows and emits no image or placement', async () => {
  const h = harness();
  h.setIntent(record('/a.png', 'working', { motionPolicy: 'off', animation: CLIPS_REF }));
  await h.runtime.start();
  assert.equal(h.rows.at(-1), 0);
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 0 });
  h.runtime.frame();
  assert.deepEqual(h.writes, []);
  assert.equal(h.encodes.length, 0);
});

test('sprite-runtime: full to off hides the successful placement, reserves zero rows, and stops placing', async () => {
  const h = harness({
    readPng: () => validPng,
    sizePng: pngSize,
    encode: encodeKittyProgram,
  });
  h.setIntent(record('/a.png'));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  assert.match(String(h.writes[0]), /\x1b_Ga=t,/);
  assert.doesNotMatch(h.writes.join(''), /\x1b_Ga=T,/);
  assert.equal(h.writes.join('').match(/\x1b_Ga=p,i=4096,p=1/g)?.length, 1);
  h.writes.length = 0;

  h.setIntent(record('/a.png', 'working', { motionPolicy: 'off' }));
  h.watchers[0].change();
  await tick();
  assert.equal(h.rows.at(-1), 0);
  h.runtime.frame();
  assert.deepEqual(h.writes, [hidePlacement(4096, 1)]);

  h.writes.length = 0;
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 0 });
  h.runtime.frame();
  assert.deepEqual(h.writes, []);
});

test('sprite-runtime: overlapping refreshes coalesce and apply newest read last', async () => {
  const first = deferred();
  const reads = [first.promise, Promise.resolve(record('/b.png'))];
  const h = harness({ readIntent: () => reads.shift() });
  const start = h.runtime.start();
  h.watchers[0].change();
  h.watchers[0].change();
  first.resolve(record('/a.png'));
  await start;
  await tick();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  assert.match(h.writes.join(''), /program:create:static:\/b\.png/);
  assert.equal(reads.length, 0);                       // one follow-up, not two
});

test('sprite-runtime: an in-flight refresh cannot apply after disposal', async () => {
  const read = deferred();
  const h = harness({ readIntent: () => read.promise });
  h.renderer.isDestroyed = true;
  const start = h.runtime.start();
  await h.runtime.dispose();
  read.resolve(record('/late.png'));
  await start;
  h.runtime.frame();
  assert.deepEqual(h.rows, []);
  assert.deepEqual(h.writes, []);
});

test('sprite-runtime: unexpected watcher close reattaches and refreshes', async () => {
  const h = harness();
  await h.runtime.start();
  const readsBefore = h.events.filter((x) => x.startsWith('read:')).length;
  h.watchers[0].emit('close');
  await tick();
  assert.equal(h.watchers.length, 2);
  assert.equal(h.events.filter((x) => x.startsWith('read:')).length, readsBefore + 1);
});

test('sprite-runtime: watcher error closes, replaces, and refreshes exactly once', async () => {
  const h = harness();
  await h.runtime.start();
  const readsBefore = h.events.filter((x) => x.startsWith('read:')).length;
  h.watchers[0].emit('error', new Error('watch broke'));
  await tick();
  assert.equal(h.errors.filter((x) => x.startsWith('sprite watch error:')).length, 1);
  assert.equal(h.events.filter((x) => x === 'watch-close').length, 1);
  assert.equal(h.watchers.length, 2);              // close event did not reattach twice
  assert.equal(h.events.filter((x) => x.startsWith('read:')).length, readsBefore + 1);
});

test('sprite-runtime: disposal close does not reattach its watcher', async () => {
  const h = harness();
  await h.runtime.start();
  h.renderer.isDestroyed = true;
  await h.runtime.dispose();
  assert.equal(h.watchers.length, 1);
});

test('sprite-runtime: pre-transmit failure explicitly hides stale placement', async () => {
  const h = harness({
    readPng: (path) => {
      if (path === '/b.png') throw new Error('missing b');
      return Buffer.from(`png:${path}`);
    },
  });
  h.setIntent(record('/a.png'));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  h.writes.length = 0;

  h.setIntent(record('/b.png'));
  h.watchers[0].change();
  await tick();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  assert.equal(h.writes.at(-1), hidePlacement(4096, 1));
  assert.equal(h.errors.filter((x) => x.startsWith('sprite change:')).length, 1);

  h.writes.length = 0;
  h.setIntent(record('/a.png'));                    // formerly displayed path
  h.watchers[0].change();
  await tick();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  assert.match(h.writes.join(''), /program:create:static:\/a\.png/); // it retransmits A
});

test('sprite-runtime: real PNG validation rejects non-PNG bytes before transmit and logs once', async () => {
  const malformed = Buffer.from('this is not a PNG but is long');
  const h = harness({
    readPng: (path) => path === '/b.png' ? malformed : validPng,
    sizePng: pngSize,
  });
  h.setIntent(record('/a.png'));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  h.writes.length = 0;
  h.errors.length = 0;

  h.setIntent(record('/b.png'));
  h.watchers[0].change();
  await tick();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  assert.equal(h.writes.some((output) => output.includes('\x1b_Ga=t,')), false);
  assert.equal(h.writes.at(-1), hidePlacement(4096, 1));
  assert.equal(h.errors.filter((x) => x.startsWith('sprite change:')).length, 1);
});

test('sprite-runtime: failed recovery hide requeues the current pose only after hide succeeds', async () => {
  let failHide = true;
  const outputs = [];
  const h = harness({
    readPng: (path) => {
      if (path === '/b.png') throw new Error('missing b');
      return Buffer.from(`png:${path}`);
    },
    writeTerminal: (output) => {
      outputs.push(output);
      if (output === hidePlacement(4096, 1) && failHide) throw new Error('hide blocked');
    },
  });
  h.setIntent(record('/a.png'));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  outputs.length = 0;

  h.setIntent(record('/b.png'));
  h.watchers[0].change();
  await tick();
  h.runtime.frame();                              // B fails; recovery hide fails
  h.setIntent(record('/a.png'));
  h.watchers[0].change();                         // must cancel B against remembered A
  await tick();
  failHide = false;
  h.runtime.frame();                              // pending recovery hide now succeeds
  outputs.length = 0;
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  assert.match(outputs.join(''), /program:create:static:\/a\.png/);

  outputs.length = 0;
  h.watchers[0].change();                         // A is already restored; no duplicate transmit
  await tick();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  assert.doesNotMatch(outputs.join(''), /program:.*:\/a\.png/);
});

test('sprite-runtime: a failed desired hide retries on the next frame without another event', async () => {
  let hideAttempts = 0;
  const h = harness({
    writeTerminal: (output) => {
      h.writes.push(output);
      if (output === hidePlacement(4096, 1) && ++hideAttempts === 1) {
        throw new Error('hide blocked');
      }
    },
  });
  h.setIntent(record('/a.png'));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();                              // A is visible
  h.writes.length = 0;

  h.setIntent(null);
  h.watchers[0].change();
  await tick();
  h.runtime.frame();                              // desired hide fails once
  assert.equal(hideAttempts, 1);                  // no same-frame recovery write

  h.runtime.frame();                              // no watch event between frames
  assert.equal(hideAttempts, 2);
  assert.deepEqual(h.writes, [hidePlacement(4096, 1), hidePlacement(4096, 1)]);

  h.runtime.frame();
  assert.equal(hideAttempts, 2);                  // successful recovery is committed once
});

test('sprite-runtime: recovery requeues a pose restored after a failed desired hide', async () => {
  let hideAttempts = 0;
  const h = harness({
    writeTerminal: (output) => {
      h.writes.push(output);
      if (output === hidePlacement(4096, 1) && ++hideAttempts === 1) {
        throw new Error('hide blocked');
      }
    },
  });
  h.setIntent(record('/a.png'));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();                              // A is visible

  h.setIntent(null);
  h.watchers[0].change();
  await tick();
  h.runtime.frame();                              // desired hide fails

  h.setIntent(record('/a.png'));
  h.watchers[0].change();                         // A returns before recovery
  await tick();
  h.runtime.frame();                              // recovery hide succeeds
  h.writes.length = 0;

  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();                              // no further watch event
  assert.match(h.writes.join(''), /program:create:static:\/a\.png/);
});

test('sprite-runtime: a frame past expiry transmits the successor before a late timer fires', async () => {
  let now = 0;
  const h = harness({ now: () => now });
  h.setIntent(record('/done.png', 'done', {
    expiresAt: 1000,
    after: { state: 'idle', sprite: { terminal: '/idle.png', rows: 8 } },
  }));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  h.writes.length = 0;

  now = 1000;                                     // injected timer remains unfired
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();

  assert.match(h.writes.join(''), /program:update:static:\/idle\.png/);
});

test('sprite-runtime: converts zero-based box origin to one-based CUP', async () => {
  const h = harness();
  h.setIntent(record('/a.png'));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  h.runtime.frame();
  const placement = h.writes.find((output) => output.includes('\x1b_Ga=p,'));
  assert.ok(placement);
  assert.match(placement, /\x1b\[1;1H/);
  assert.doesNotMatch(placement, /\x1b\[(?:0;\d+|\d+;0)H/);
});

for (const mode of ['place', 'sidebar-hide', 'recovery-hide']) {
  test(`sprite-runtime: ${mode} retries every frame and logs once per consecutive failure run`, async () => {
    const outcomes = [false, false, true, false];
    let attempts = 0;
    let enabled = false;
    const target = mode === 'place'
      ? (output) => output.includes('\x1b_Ga=p,')
      : (output) => output === hidePlacement(4096, 1);
    const h = harness({
      readPng: (path) => {
        if (mode === 'recovery-hide' && path === '/b.png') throw new Error('missing b');
        return Buffer.from(`png:${path}`);
      },
      writeTerminal: (output) => {
        if (!enabled || !target(output)) return;
        const succeeds = outcomes[attempts++];
        if (!succeeds) throw new Error(`${mode} blocked`);
      },
    });
    h.setIntent(record('/a.png'));
    await h.runtime.start();
    h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
    h.runtime.frame();                              // establish transmitted A
    enabled = true;
    h.errors.length = 0;

    switch (mode) {
      case 'place':
        for (let i = 0; i < 4; i++) {
          h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
          h.runtime.frame();
        }
        break;
      case 'sidebar-hide':
        for (let i = 0; i < 4; i++) h.runtime.frame();
        break;
      case 'recovery-hide':
        h.setIntent(record('/b.png'));
        h.watchers[0].change();
        await tick();
        h.runtime.frame();                          // fail change; hide attempt 1 fails
        h.runtime.frame();                          // hide attempt 2 fails, no second log
        h.runtime.frame();                          // hide attempt 3 succeeds, clears latch
        h.watchers[0].change();                     // next generation retries desired B
        await tick();
        h.runtime.frame();                          // B fails again; hide attempt 4 logs again
        break;
      default:
        assert.fail(`unhandled mode ${mode}`);
    }

    assert.equal(attempts, 4);
    assert.equal(
      h.errors.filter((message) => message.startsWith('sprite frame:')).length,
      2,
    );
  });
}

test('sprite-runtime: dispose writes nothing until the requested cleanup frame', async () => {
  const h = harness();
  h.setIntent(record('/a.png'));
  await h.runtime.start();
  h.runtime.captureBox({ x: 0, y: 0, width: 10, height: 8 });
  const requests = h.renderRequests();
  const disposing = h.runtime.dispose();
  assert.equal(h.runtime.dispose(), disposing);       // one cleanup transaction
  assert.deepEqual(h.writes, []);
  assert.equal(h.renderRequests(), requests + 1);
  assert.equal(h.renderer.listenerCount('destroy'), 1);
  h.runtime.frame();
  await disposing;
  assert.deepEqual(h.writes, [freeImage(4096)]);
  assert.equal(h.renderer.listenerCount('destroy'), 0);
  h.runtime.frame();
  assert.deepEqual(h.writes, [freeImage(4096)]);      // cleanup cannot run twice
});

test('sprite-runtime: cleanup write failure logs once and still settles', async () => {
  const h = harness({ writeTerminal: () => { throw new Error('cleanup blocked'); } });
  await h.runtime.start();
  const disposing = h.runtime.dispose();
  h.runtime.frame();
  await disposing;
  assert.equal(h.errors.filter((x) => x.startsWith('sprite cleanup:')).length, 1);
  assert.equal(h.renderer.listenerCount('destroy'), 0);
});

test('sprite-runtime: renderer destroy settles teardown without writing', async () => {
  const h = harness();
  await h.runtime.start();
  const disposing = h.runtime.dispose();
  h.renderer.emit('destroy');
  await disposing;
  assert.deepEqual(h.writes, []);
  assert.equal(h.renderer.listenerCount('destroy'), 0);
});

test('sprite-runtime: an already-destroyed renderer settles without requesting or writing', async () => {
  const h = harness();
  await h.runtime.start();
  h.renderer.isDestroyed = true;
  const requests = h.renderRequests();
  await h.runtime.dispose();
  assert.equal(h.renderRequests(), requests);
  assert.deepEqual(h.writes, []);
});
