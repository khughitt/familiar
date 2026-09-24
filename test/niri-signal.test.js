import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  levelFor, motionFor, niriHasSignals, planWindowSignals, sessionSlot,
} from '../integrations/niri/signal.js';

// The mapping is niri-material's signals design, section 2 ("The familiar bridge"):
// identity hue -> accent, urgency -> level, motion verbatim under familiar's motion
// policy, expiresAt/after -> a ttl niri decays by itself, done/error -> an impulse.

const GINGER = '#e5a33c';
const TUXEDO = '#c464bc';

function intentFor(state, { urgency, motion, base = GINGER, member = 'ginger', motionPolicy = 'full' } = {}) {
  return {
    state, urgency, motion, motionPolicy,
    color: { base },
    identity: { member },
  };
}

const idle = (o) => intentFor('idle', { urgency: 'none', motion: 'breathe', ...o });
const working = (o) => intentFor('working', { urgency: 'none', motion: 'pulse', ...o });
const needsInput = (o) => intentFor('needs-input', { urgency: 'demand', motion: 'pulse', ...o });
const done = (o) => intentFor('done', { urgency: 'notice', motion: 'static', ...o });
const error = (o) => intentFor('error', { urgency: 'demand', motion: 'flash', ...o });

const persistent = (current) => ({ current, expiresAt: null, after: null });
const transient = (current, after, expiresAt) => ({ current, expiresAt, after });

const NOW = 1_000_000;
const win = (id, sources = null) => ({ id, pid: id * 10, signal: sources && { sources } });

function plan({ intent, agents = {}, sessionWindows, windows, sent = new Map(), states = new Map(), now = NOW }) {
  return planWindowSignals({ intent, agents, sessionWindows, windows, sent, states, themeId: 'cats', now });
}

const argsOf = (result) => result.commands.map((c) => c.args);

test('urgency none is quiet at rest and active while working; the rest keep their names', () => {
  assert.equal(levelFor(idle()), 'quiet');
  assert.equal(levelFor(working()), 'active');
  assert.equal(levelFor(done()), 'notice');
  assert.equal(levelFor(needsInput()), 'demand');
  assert.throws(() => levelFor(intentFor('idle', { urgency: 'loud', motion: 'static' })), /urgency "loud"/);
});

test('familiar motion policy applies before niri sees the motion', () => {
  assert.equal(motionFor(error()), 'flash');
  assert.equal(motionFor(error({ motionPolicy: 'reduced' })), 'pulse');
  assert.equal(motionFor(working({ motionPolicy: 'reduced' })), 'breathe');
  assert.equal(motionFor(idle({ motionPolicy: 'reduced' })), 'breathe');
  assert.equal(motionFor(error({ motionPolicy: 'off' })), 'static');
  assert.throws(() => motionFor(idle({ motionPolicy: 'sometimes' })), /motionPolicy "sometimes"/);
});

test('a persistent state is one slot in the identity hue, tagged theme/member', () => {
  const result = plan({
    intent: { s1: persistent(needsInput()) },
    sessionWindows: { s1: { windowId: 7 } },
    windows: [win(7)],
  });
  assert.deepEqual(argsOf(result), [[
    'set-window-signal', '--id', '7', '--source', 'familiar',
    '--accent', GINGER, '--level', 'demand', '--motion', 'pulse', '--tag', 'cats/ginger',
  ]]);
});

test('a transient state hands niri its successor and the time left, so niri decays it', () => {
  const result = plan({
    intent: { s1: transient(done(), idle(), NOW + 8000) },
    sessionWindows: { s1: { windowId: 7 } },
    windows: [win(7)],
  });
  assert.deepEqual(argsOf(result)[0].slice(-6), [
    '--ttl-ms', '8000', '--after-level', 'quiet', '--after-motion', 'breathe',
  ]);
});

test('an expired transient state is sent as its successor, with no ttl', () => {
  const slot = sessionSlot(transient(done(), idle(), NOW - 1), { themeId: 'cats', now: NOW });
  assert.equal(slot.level, 'quiet');
  assert.equal(slot.motion, 'breathe');
  assert.equal(slot.expiresAt, null);
});

test('two sessions in one window write ONE slot: the higher level wins, with its hue', () => {
  const result = plan({
    intent: {
      s1: persistent(working({ base: GINGER, member: 'ginger' })),
      s2: persistent(needsInput({ base: TUXEDO, member: 'tuxedo' })),
    },
    agents: { s1: { seq: 9 }, s2: { seq: 3 } },
    sessionWindows: { s1: { windowId: 7 }, s2: { windowId: 7 } },
    windows: [win(7)],
  });
  const args = argsOf(result);
  assert.equal(args.length, 1);
  assert.ok(args[0].includes(TUXEDO));
  assert.ok(args[0].includes('cats/tuxedo'));
});

test('on a level tie the session latest on the bus wins', () => {
  const result = plan({
    intent: {
      s1: persistent(idle({ base: GINGER })),
      s2: persistent(idle({ base: TUXEDO, member: 'tuxedo' })),
    },
    agents: { s1: { seq: 9 }, s2: { seq: 3 } },
    sessionWindows: { s1: { windowId: 7 }, s2: { windowId: 7 } },
    windows: [win(7)],
  });
  assert.ok(argsOf(result)[0].includes(GINGER));
});

test('an unchanged slot is not resent while niri still carries it', () => {
  const input = {
    intent: { s1: persistent(idle()) },
    sessionWindows: { s1: { windowId: 7 } },
    windows: [win(7)],
  };
  const first = plan(input);
  const second = plan({ ...input, windows: [win(7, ['familiar'])], sent: first.sent, states: first.states });
  assert.deepEqual(second.commands, []);
});

test('an unchanged slot IS resent when niri no longer carries it', () => {
  const input = {
    intent: { s1: persistent(idle()) },
    sessionWindows: { s1: { windowId: 7 } },
    windows: [win(7)],
  };
  const first = plan(input);
  const second = plan({ ...input, sent: first.sent, states: first.states });
  assert.equal(argsOf(second)[0][0], 'set-window-signal');
});

test('a window that no longer hosts a session is cleared, by niri\'s account', () => {
  // A restarted bridge has sent nothing, yet window 9 still carries a slot from the
  // previous run and no session: it must go dark. Window 3 carries only niri's own.
  const result = plan({
    intent: { s1: persistent(idle()) },
    sessionWindows: { s1: { windowId: 7 } },
    windows: [win(7, ['familiar']), win(9, ['familiar']), win(3, ['niri'])],
  });
  assert.deepEqual(argsOf(result), [
    argsOf(result)[0],
    ['clear-window-signal', '--id', '9', '--source', 'familiar'],
  ]);
  assert.equal(argsOf(result)[0][0], 'set-window-signal');
});

test('a closed window is never cleared: its slot died with it', () => {
  const result = plan({ intent: {}, sessionWindows: {}, windows: [win(7)] });
  assert.deepEqual(result.commands, []);
});

test('a transition into done pulses after the slot is set', () => {
  const states = new Map([['s1', 'working']]);
  const result = plan({
    intent: { s1: transient(done(), idle(), NOW + 8000) },
    sessionWindows: { s1: { windowId: 7 } },
    windows: [win(7, ['familiar'])],
    states,
  });
  const args = argsOf(result);
  assert.equal(args[0][0], 'set-window-signal');
  assert.deepEqual(args[1], [
    'pulse-window-signal', '--id', '7', '--source', 'familiar', '--kind', 'done', '--accent', GINGER,
  ]);
});

test('no pulse without a seen transition: not on first sight, not while it lasts', () => {
  const input = {
    intent: { s1: persistent(error()) },
    sessionWindows: { s1: { windowId: 7 } },
    windows: [win(7)],
  };
  const first = plan(input);
  assert.ok(argsOf(first).every((a) => a[0] !== 'pulse-window-signal'));
  const second = plan({ ...input, sent: first.sent, states: first.states });
  assert.ok(argsOf(second).every((a) => a[0] !== 'pulse-window-signal'));
});

test('motion policy off sends no pulses', () => {
  const result = plan({
    intent: { s1: persistent(error({ motionPolicy: 'off' })) },
    sessionWindows: { s1: { windowId: 7 } },
    windows: [win(7)],
    states: new Map([['s1', 'working']]),
  });
  assert.ok(argsOf(result).every((a) => a[0] !== 'pulse-window-signal'));
  assert.ok(argsOf(result)[0].includes('static'));
});

test('a session intent.json has not caught up with is skipped, and keeps its last state', () => {
  const states = new Map([['s1', 'working']]);
  const result = plan({ intent: {}, sessionWindows: { s1: { windowId: 7 } }, windows: [win(7)], states });
  assert.deepEqual(result.commands, []);
  assert.equal(result.states.get('s1'), 'working');
});

test('stock niri, with no signal key on its windows, is detected', () => {
  assert.equal(niriHasSignals([{ id: 1 }]), false);
  assert.equal(niriHasSignals([{ id: 1, signal: null }]), true);
});
