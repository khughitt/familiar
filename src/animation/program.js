import { fnv1a32 } from '../protocol/hash.js';
import { assertState } from 'familiar-theme';

export const MOTION_POLICIES = Object.freeze(['full', 'reduced', 'off']);

const CAPABILITIES = Object.freeze(['kitty-animation', 'static-graphics', 'none']);
const ANIMATION_KINDS = Object.freeze(['clips', 'static']);
const IDLE_AMBIENT_COUNT = 20;
const IDLE_HOLD_MIN_MS = 8_000;
const IDLE_HOLD_MAX_MS = 20_000;

// The role each animated state needs before it can be planned. needs-input and
// needs-approval are absent because they return static before the lookup.
const STATE_ROLE = Object.freeze({
  idle: 'idle-ambient',
  working: 'working-loop',
  done: 'done-enter',
  error: 'error-enter',
});

function assertMember(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new Error(`animation: unknown ${name} ${JSON.stringify(value)}`);
  }
}

export function selectPlayback({ policy, capability, animationKind }) {
  assertMember(policy, MOTION_POLICIES, 'policy');
  assertMember(capability, CAPABILITIES, 'capability');
  assertMember(animationKind, ANIMATION_KINDS, 'animationKind');

  if (policy === 'off' || capability === 'none') return 'none';
  if (policy === 'reduced' || capability === 'static-graphics' || animationKind === 'static') {
    return 'static';
  }
  return 'animation';
}

function clipFor(set, role, state, root) {
  const clip = set.clips.get(role);
  if (!clip) throw new Error(`animation: clips set is missing required role "${role}"`);
  if (!Array.isArray(clip.frames) || clip.frames.length < 2) {
    throw new Error(`animation: role "${role}" must contain leading and trailing root frames`);
  }
  if (clip.state !== state) {
    throw new Error(`animation: role "${role}" belongs to state ${JSON.stringify(clip.state)}, not "${state}"`);
  }

  const leading = clip.frames[0];
  const trailing = clip.frames.at(-1);
  if (leading.ref !== 'root' || trailing.ref !== 'root') {
    throw new Error(`animation: role "${role}" must contain leading and trailing symbolic roots`);
  }
  for (const frame of clip.frames) {
    if (frame.ref === 'root' && frame.path !== root) {
      throw new Error(
        `animation: role "${role}" symbolic root did not resolve to the current state root ${root}`,
      );
    }
  }
  return clip;
}

function nextIdleHold(nextRandom) {
  const span = IDLE_HOLD_MAX_MS - IDLE_HOLD_MIN_MS + 1;
  return IDLE_HOLD_MIN_MS + (nextRandom() % span);
}

function seededRandom(seed) {
  let value = fnv1a32(seed);
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value;
  };
}

function planIdle(set, root, sessionId) {
  const ambient = clipFor(set, 'idle-ambient', 'idle', root);
  // The two idle roles are independently optional: the special is a rare easter
  // egg and must not gate the common case.
  const special = set.clips.has('idle-special')
    ? clipFor(set, 'idle-special', 'idle', root)
    : null;
  const nextRandom = seededRandom(`${sessionId}:idle`);
  const frames = [];

  for (let occurrence = 0; occurrence < IDLE_AMBIENT_COUNT; occurrence += 1) {
    frames.push({
      ...ambient.frames[0],
      durationMs: nextIdleHold(nextRandom),
    });
    frames.push(...ambient.frames);
  }
  if (special !== null) frames.push(...special.frames);

  return {
    kind: 'animation',
    state: 'idle',
    playback: 'loop',
    root,
    frames,
  };
}

function planWorking(set, root) {
  const clip = clipFor(set, 'working-loop', 'working', root);
  if (clip.frames[0].durationMs !== clip.frames.at(-1).durationMs) {
    throw new Error('animation: working-loop leading and trailing root durations must be equal');
  }
  const normalized = clip.frames.slice(0, -1);
  return {
    kind: 'animation',
    state: 'working',
    playback: 'loop',
    root: normalized[0].path,
    frames: normalized,
  };
}

function planEntry(set, root, state, role) {
  const clip = clipFor(set, role, state, root);
  return {
    kind: 'animation',
    state,
    playback: 'once',
    root,
    frames: clip.frames.slice(),
  };
}

export function planAnimation({ set, root, state, sessionId, policy, capability }) {
  assertState(state);
  if (!set || typeof set !== 'object') throw new Error('animation: set must be an object');
  assertMember(set.kind, ANIMATION_KINDS, 'animationKind');
  if (typeof root !== 'string' || root === '') {
    throw new Error('animation: current state root must be a non-empty path');
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('animation: sessionId must be a non-empty string');
  }

  const playback = selectPlayback({ policy, capability, animationKind: set.kind });
  if (playback === 'none') return { kind: 'none' };
  if (playback === 'static' || state === 'needs-input' || state === 'needs-approval') {
    return { kind: 'static', state, root };
  }
  if (!(set.clips instanceof Map)) {
    throw new Error('animation: clips set must provide clips as a Map');
  }

  const role = STATE_ROLE[state];
  if (role === undefined) {
    throw new Error(`animation: animated state ${JSON.stringify(state)} has no planner`);
  }
  // The member declared no clip for this state, so it wears its static sprite
  // here. Same shape reduced motion and static-graphics already return.
  if (!set.clips.has(role)) return { kind: 'static', state, root };

  if (state === 'idle') return planIdle(set, root, sessionId);
  if (state === 'working') return planWorking(set, root);
  if (state === 'done') return planEntry(set, root, state, 'done-enter');
  return planEntry(set, root, state, 'error-enter');
}
