import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES } from 'familiar-theme';
import {
  MOTION_POLICIES,
  planAnimation,
  selectPlayback,
} from '../src/animation/program.js';

const CAPABILITIES = ['kitty-animation', 'static-graphics', 'none'];
const ANIMATION_KINDS = ['clips', 'static'];

function expectedPlayback(policy, capability, animationKind) {
  if (policy === 'off' || capability === 'none') return 'none';
  if (policy === 'reduced' || capability === 'static-graphics' || animationKind === 'static') {
    return 'static';
  }
  return 'animation';
}

test('selectPlayback exhaustively selects the three explicit playback modes', () => {
  assert.deepEqual(MOTION_POLICIES, ['full', 'reduced', 'off']);
  assert.ok(Object.isFrozen(MOTION_POLICIES));

  for (const policy of MOTION_POLICIES) {
    for (const capability of CAPABILITIES) {
      for (const animationKind of ANIMATION_KINDS) {
        assert.equal(
          selectPlayback({ policy, capability, animationKind }),
          expectedPlayback(policy, capability, animationKind),
          `${policy} / ${capability} / ${animationKind}`,
        );
      }
    }
  }
});

for (const [field, value] of [
  ['policy', 'sometimes'],
  ['capability', 'sixel'],
  ['animationKind', 'maybe'],
]) {
  test(`selectPlayback rejects an unknown ${field}`, () => {
    const input = { policy: 'full', capability: 'kitty-animation', animationKind: 'clips' };
    input[field] = value;
    assert.throws(() => selectPlayback(input), new RegExp(`unknown ${field}.*${value}`, 'i'));
  });
}

function frame(ref, path, durationMs) {
  return Object.freeze({ ref, path, durationMs, width: 2, height: 2, decodedBytes: 16 });
}

function oneShot(state, name, middleDuration = 120) {
  const root = `/sprites/${state}.png`;
  return Object.freeze({
    state,
    playback: 'once',
    frames: Object.freeze([
      frame('root', root, 100),
      frame(`${name}-motion`, `/animation/${name}/motion.png`, middleDuration),
      frame('root', root, 100),
    ]),
  });
}

function fixtureSet() {
  return Object.freeze({
    kind: 'clips',
    clips: new Map([
      ['idle-ambient', oneShot('idle', 'idle-ambient', 120)],
      ['working-loop', Object.freeze({
        state: 'working',
        playback: 'loop',
        frames: Object.freeze([
          frame('root', '/sprites/working.png', 140),
          frame('work-a', '/animation/working-loop/a.png', 90),
          frame('work-b', '/animation/working-loop/b.png', 90),
          frame('root', '/sprites/working.png', 140),
        ]),
      })],
      ['done-enter', oneShot('done', 'done-enter', 300)],
      ['error-enter', oneShot('error', 'error-enter', 400)],
      ['idle-special', oneShot('idle', 'idle-special', 500)],
    ]),
  });
}

function plan(set, state, overrides = {}) {
  return planAnimation({
    set,
    root: `/sprites/${state}.png`,
    state,
    sessionId: 'session-alpha',
    policy: 'full',
    capability: 'kitty-animation',
    ...overrides,
  });
}

function durations(frames) {
  return frames.reduce((total, current) => total + current.durationMs, 0);
}

test('idle is deterministic per session and the seed changes holds only', () => {
  const set = fixtureSet();
  const first = plan(set, 'idle');
  const repeated = plan(set, 'idle');
  const other = plan(set, 'idle', { sessionId: 'session-beta' });

  assert.deepEqual(repeated, first);
  assert.equal(other.frames.length, first.frames.length);
  assert.deepEqual(other.frames.map(({ path }) => path), first.frames.map(({ path }) => path));
  assert.notDeepEqual(other.frames.map(({ durationMs }) => durationMs), first.frames.map(({ durationMs }) => durationMs));
});

test('idle waits before every ambient, preserves complete clips, then plays its special', () => {
  const set = fixtureSet();
  const program = plan(set, 'idle');
  const ambient = set.clips.get('idle-ambient');
  const special = set.clips.get('idle-special');
  const ambientBlockLength = ambient.frames.length + 1;

  assert.equal(program.kind, 'animation');
  assert.equal(program.state, 'idle');
  assert.equal(program.playback, 'loop');
  assert.equal(program.root, '/sprites/idle.png');
  assert.equal(program.frames.length, 20 * ambientBlockLength + special.frames.length);

  const holds = [];
  for (let index = 0; index < 20; index += 1) {
    const offset = index * ambientBlockLength;
    const hold = program.frames[offset];
    holds.push(hold);
    assert.equal(hold.ref, 'root');
    assert.equal(hold.path, '/sprites/idle.png');
    assert.ok(hold.durationMs >= 8_000 && hold.durationMs <= 20_000);
    assert.deepEqual(program.frames.slice(offset + 1, offset + ambientBlockLength), ambient.frames);
  }

  assert.deepEqual(program.frames.slice(20 * ambientBlockLength), special.frames);
  assert.equal(
    durations(program.frames),
    durations(holds) + 20 * durations(ambient.frames) + durations(special.frames),
  );
  assert.ok(holds.every(({ durationMs }) => durationMs >= 1 && durationMs <= 600_000));
});

test('working elides only the trailing root and retains one leading root dwell', () => {
  const set = fixtureSet();
  const clip = set.clips.get('working-loop');
  const program = plan(set, 'working');

  assert.deepEqual(program, {
    kind: 'animation',
    state: 'working',
    playback: 'loop',
    root: '/sprites/working.png',
    frames: clip.frames.slice(0, -1),
  });
  assert.equal(program.frames.filter(({ ref }) => ref === 'root').length, 1);
});

test('working rejects unequal loop seam root durations as a planner invariant', () => {
  const set = fixtureSet();
  const clip = set.clips.get('working-loop');
  const broken = {
    kind: 'clips',
    clips: new Map(set.clips),
  };
  broken.clips.set('working-loop', {
    ...clip,
    frames: [...clip.frames.slice(0, -1), { ...clip.frames.at(-1), durationMs: 141 }],
  });

  assert.throws(() => plan(broken, 'working'), /working-loop.*root durations.*equal/i);
});

for (const [state, role] of [['done', 'done-enter'], ['error', 'error-enter']]) {
  test(`${state} retains both roots and settles on its final root`, () => {
    const set = fixtureSet();
    const clip = set.clips.get(role);
    const program = plan(set, state);

    assert.equal(program.kind, 'animation');
    assert.equal(program.playback, 'once');
    assert.deepEqual(program.frames, clip.frames);
    assert.equal(program.frames[0].ref, 'root');
    assert.equal(program.frames.at(-1).ref, 'root');
    assert.equal(program.frames.at(-1).path, `/sprites/${state}.png`);
  });
}

for (const state of ['needs-input', 'needs-approval']) {
  test(`${state} remains a static root under full motion`, () => {
    assert.deepEqual(plan(fixtureSet(), state), {
      kind: 'static',
      state,
      root: `/sprites/${state}.png`,
    });
  });
}

test('a static member uses the injected root under full motion', () => {
  assert.deepEqual(plan({ kind: 'static' }, 'working'), {
    kind: 'static',
    state: 'working',
    root: '/sprites/working.png',
  });
});

test('reduced returns the injected root for every state', () => {
  for (const state of STATES) {
    assert.deepEqual(plan(fixtureSet(), state, { policy: 'reduced' }), {
      kind: 'static',
      state,
      root: `/sprites/${state}.png`,
    });
  }
});

test('off returns none for every state and reserves no root', () => {
  for (const state of STATES) {
    assert.deepEqual(plan(fixtureSet(), state, { policy: 'off' }), { kind: 'none' });
  }
});

test('a later state plan cannot alter or advance an earlier idle plan', () => {
  const set = fixtureSet();
  const idle = plan(set, 'idle');
  const snapshot = structuredClone(idle);

  plan(set, 'working');
  plan(set, 'done');

  assert.deepEqual(idle, snapshot);
  assert.deepEqual(plan(set, 'idle'), snapshot);
});

test('an animated clip must resolve symbolic roots to the injected state root', () => {
  assert.throws(
    () => plan(fixtureSet(), 'working', { root: '/sprites/wrong.png' }),
    /working-loop.*root.*current state root/i,
  );
});

test('idle without a special ends on the twentieth ambient and is otherwise identical', () => {
  const complete = fixtureSet();
  const partial = { kind: 'clips', clips: new Map(complete.clips) };
  partial.clips.delete('idle-special');

  const full = plan(complete, 'idle');
  const program = plan(partial, 'idle');
  const ambient = complete.clips.get('idle-ambient');
  const special = complete.clips.get('idle-special');
  const ambientBlockLength = ambient.frames.length + 1;

  // Exactly the full plan with the special's tail removed — same seeded holds,
  // same ambient copies, same order.
  assert.equal(program.frames.length, 20 * ambientBlockLength);
  assert.deepEqual(program.frames, full.frames.slice(0, 20 * ambientBlockLength));
  assert.deepEqual(full.frames.slice(20 * ambientBlockLength), special.frames);
  assert.equal(program.frames.at(-1).ref, 'root');
  assert.equal(program.frames.at(-1).path, '/sprites/idle.png');

  // "Otherwise identical" means every field but frames.
  assert.deepEqual({ ...program, frames: null }, { ...full, frames: null });
});

test('idle without a special is still deterministic per session', () => {
  const partial = { kind: 'clips', clips: new Map(fixtureSet().clips) };
  partial.clips.delete('idle-special');

  assert.deepEqual(plan(partial, 'idle'), plan(partial, 'idle'));
  assert.notDeepEqual(
    plan(partial, 'idle', { sessionId: 'session-beta' }).frames.map(({ durationMs }) => durationMs),
    plan(partial, 'idle').frames.map(({ durationMs }) => durationMs),
  );
});

test('a member declaring only idle-ambient animates idle and falls back elsewhere', () => {
  const complete = fixtureSet();
  const ambient = complete.clips.get('idle-ambient');
  const only = {
    kind: 'clips',
    clips: new Map([['idle-ambient', ambient]]),
  };

  const idle = plan(only, 'idle');
  assert.equal(idle.kind, 'animation');
  assert.equal(idle.state, 'idle');
  assert.equal(idle.playback, 'loop');
  assert.equal(idle.frames.length, 20 * (ambient.frames.length + 1));

  for (const state of ['working', 'done', 'error']) {
    assert.deepEqual(plan(only, state), {
      kind: 'static',
      state,
      root: `/sprites/${state}.png`,
    });
  }
});

test('each animated state falls back on its own missing role', () => {
  for (const [state, role] of [
    ['idle', 'idle-ambient'],
    ['working', 'working-loop'],
    ['done', 'done-enter'],
    ['error', 'error-enter'],
  ]) {
    const set = { kind: 'clips', clips: new Map(fixtureSet().clips) };
    set.clips.delete(role);

    assert.deepEqual(plan(set, state), {
      kind: 'static',
      state,
      root: `/sprites/${state}.png`,
    }, `${state} without ${role}`);

    // Dropping one role does not disturb the others.
    for (const other of ['idle', 'working', 'done', 'error']) {
      if (other === state) continue;
      assert.equal(plan(set, other).kind, 'animation', `${other} after dropping ${role}`);
    }
  }
});
