import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placeAt, hidePlacement, freeImage,
  recordForPid, displayedForPid, programIdentityOf, cellBox,
} from './sprite.js';
import { writeAllSync } from '../../src/render/term/io.js';
import { createSpriteState } from './sprite-state.js';

// A controllable fake clock + timer scheduler.
function harness(startNow) {
  let nowValue = startNow;
  const timers = [];
  let renders = 0;
  const poseChanges = [];
  const deps = {
    now: () => nowValue,
    setTimer: (fn, ms) => { const h = { fn, at: nowValue + ms, cancelled: false }; timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.cancelled = true; },
    requestRender: () => { renders++; },
    onPoseChange: (pose) => { poseChanges.push(pose); },
    capability: 'kitty-animation',
  };
  return {
    deps,
    advanceTo: (t) => { nowValue = t; },
    fireDue: () => { for (const h of timers) if (!h.cancelled && h.at <= nowValue) { h.cancelled = true; h.fn(); } },
    liveTimer: () => timers.find((h) => !h.cancelled) ?? null,
    renders: () => renders,
    poseChanges: () => poseChanges,
  };
}

const pose = (state, path, {
  motionPolicy = 'full',
  animation = { kind: 'static' },
} = {}) => ({
  sessionId: 'session-42',
  state,
  motionPolicy,
  animation,
  sprite: { terminal: path, rows: 8 },
});

const rec = (state, path, {
  expiresAt = null,
  after = null,
  motionPolicy = 'full',
  animation = { kind: 'static' },
} = {}) => ({
  'opencode:42': {
    current: pose(state, path, { motionPolicy, animation }),
    expiresAt,
    after: after === null ? null : pose(after.state, after.sprite.terminal, {
      motionPolicy: after.motionPolicy ?? motionPolicy,
      animation: after.animation ?? animation,
    }),
  },
});

test('sprite-state: onPoseChange must be a function at construction', () => {
  const h = harness(0);
  const { onPoseChange: _omitted, ...missingOnPoseChange } = h.deps;
  assert.throws(
    () => createSpriteState(42, missingOnPoseChange),
    /onPoseChange must be a function/,
  );
  assert.throws(
    () => createSpriteState(42, { ...h.deps, onPoseChange: 'not a function' }),
    /onPoseChange must be a function/,
  );
});

test('placeAt: one-based CUP, ESC7/ESC8 wrapped, fixed placement id', () => {
  assert.equal(
    placeAt(1, 1, 4096, 1, 6, 4),
    '\x1b7\x1b[1;1H\x1b_Ga=p,i=4096,p=1,c=6,r=4,q=2,C=1\x1b\\\x1b8',
  );
});

test('hidePlacement: d=i keeps image data', () => {
  assert.equal(hidePlacement(4096, 1), '\x1b_Ga=d,d=i,i=4096,p=1,q=2\x1b\\');
});

test('freeImage: d=I frees image data', () => {
  assert.equal(freeImage(4096), '\x1b_Ga=d,d=I,i=4096,q=2\x1b\\');
});

test('recordForPid: keyed by opencode:<pid>, null when absent', () => {
  const rec = { current: { state: 'working' }, expiresAt: null, after: null };
  const intent = { 'opencode:42': rec };
  assert.equal(recordForPid(intent, 42), rec);
  assert.equal(recordForPid(intent, 99), null);
  assert.equal(recordForPid(null, 42), null);
});

test('displayedForPid: honors decay contract', () => {
  const intent = {
    'opencode:42': {
      current: { state: 'done', sprite: { terminal: '/d/done.png' } },
      expiresAt: 1000,
      after: { state: 'idle', sprite: { terminal: '/d/idle.png' } },
    },
  };
  assert.equal(displayedForPid(intent, 42, 500).state, 'done');   // before expiry
  assert.equal(displayedForPid(intent, 42, 1500).state, 'idle');  // after expiry
});

test('programIdentityOf: clips include state, policy, digest, and capability', () => {
  const record = pose('working', '/d/root.png', {
    animation: { kind: 'clips', manifest: '/d/animation.yaml', sha256: 'a'.repeat(64) },
  });
  const identity = programIdentityOf(record, 'kitty-animation');
  assert.notEqual(identity, programIdentityOf({ ...record, state: 'idle' }, 'kitty-animation'));
  assert.notEqual(identity, programIdentityOf({ ...record, motionPolicy: 'reduced' }, 'kitty-animation'));
  assert.notEqual(identity, programIdentityOf({
    ...record,
    animation: { ...record.animation, sha256: 'b'.repeat(64) },
  }, 'kitty-animation'));
  assert.notEqual(identity, programIdentityOf(record, 'static-graphics'));
});

test('programIdentityOf: static identity is state, path, and capability', () => {
  const record = pose('working', '/d/root.png');
  assert.equal(
    programIdentityOf(record, 'kitty-animation'),
    programIdentityOf({ ...record, motionPolicy: 'reduced' }, 'kitty-animation'),
  );
  assert.notEqual(
    programIdentityOf(record, 'kitty-animation'),
    programIdentityOf({ ...record, sprite: { ...record.sprite, terminal: '/d/other.png' } }, 'kitty-animation'),
  );
});

test('cellBox: preserves aspect in cell units (cell ~1:2 w:h), fits box', () => {
  // Square image: aspect in cells = W/(H/2) = 2. Into 10x10 -> width-bound: c=10, r=5.
  assert.deepEqual(cellBox(20, 20, 10, 10), { c: 10, r: 5 });
  // Tall image 10x40: aspect = 10/20 = 0.5. Into 10x10 -> height-bound: r=10, c=5.
  assert.deepEqual(cellBox(10, 40, 10, 10), { c: 5, r: 10 });
  // Never returns 0.
  const b = cellBox(1, 1000, 4, 4);
  assert.ok(b.c >= 1 && b.r >= 1);
});

test('writeAllSync: drains the whole buffer across short writes', () => {
  const seen = [];
  // A writer that accepts at most 3 bytes per call.
  const write = (fd, buf, offset, length) => {
    const n = Math.min(3, length);
    seen.push(buf.subarray(offset, offset + n).toString());
    return n;
  };
  const total = writeAllSync(Buffer.from('abcdefgh'), { write, fd: 7 });
  assert.equal(total, 8);
  assert.equal(seen.join(''), 'abcdefgh');
});

test('writeAllSync: zero-progress write throws instead of spinning', () => {
  const write = () => 0;
  assert.throws(() => writeAllSync(Buffer.from('abc'), { write }), /zero progress/);
});

test('writeAllSync: over-remaining or non-integer write throws', () => {
  assert.throws(() => writeAllSync(Buffer.from('abc'), { write: () => 99 }), /overrun.*99/);
  assert.throws(() => writeAllSync(Buffer.from('abc'), { write: () => 1.5 }), /reported 1.5/);
});

test('sprite-state: first apply queues record, program identity, and visible placement', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('working', '/d/working.png'));
  assert.equal(h.renders(), 1);
  assert.equal(h.poseChanges().at(-1).sprite.terminal, '/d/working.png'); // box-height notified
  const change = s.peekChange();
  assert.equal(change.record.sprite.terminal, '/d/working.png');
  assert.equal(change.programIdentity, programIdentityOf(change.record, 'kitty-animation'));
  assert.equal(change.placement, 'visible');
  assert.equal(s.programIdentity, null); // NOT advanced by peek
  s.commitChange();
  assert.equal(s.programIdentity, change.programIdentity);
  assert.equal(s.peekChange(), null);    // consumed
});

test('sprite-state: peek is idempotent; only commit advances (retry-safe write failure)', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('working', '/d/working.png'));
  assert.equal(s.peekChange().placement, 'visible');
  assert.equal(s.peekChange().placement, 'visible'); // still pending — a thrown write left it unconsumed
  assert.equal(s.programIdentity, null);
  s.commitChange();                               // write finally succeeded
  assert.ok(s.programIdentity);
  assert.equal(s.peekChange(), null);
});

test('sprite-state: decay fires and swaps done -> after(idle), re-notifying box height', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('done', '/d/done.png', {
    expiresAt: 1000,
    after: { state: 'idle', sprite: { terminal: '/d/idle.png' } },
  }));
  s.commitChange();                // consume the initial done pose
  assert.ok(h.liveTimer());        // timer armed for expiry
  h.advanceTo(1000);
  h.fireDue();
  assert.equal(s.peekChange().record.sprite.terminal, '/d/idle.png');
  s.commitChange();
  assert.equal(h.poseChanges().at(-1).state, 'idle'); // decay updates box height
});

test('sprite-state: a frame-observed expiry cancels its late timer and queues the successor', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('done', '/d/done.png', {
    expiresAt: 1000,
    after: { state: 'idle', sprite: { terminal: '/d/idle.png' } },
  }));
  s.commitChange();
  const lateTimer = h.liveTimer();
  h.advanceTo(1000);                              // timer has not fired

  assert.equal(typeof s.observeExpiry, 'function');
  s.observeExpiry();

  assert.equal(lateTimer.cancelled, true);
  assert.equal(s.peekChange().record.sprite.terminal, '/d/idle.png');
});

test('sprite-state: a frame observes each applied expiry once and does not spin a failed successor', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('done', '/d/done.png', {
    expiresAt: 1000,
    after: { state: 'idle', sprite: { terminal: '/d/idle.png' } },
  }));
  s.commitChange();
  const staleTimer = h.liveTimer();
  h.advanceTo(1000);
  assert.equal(typeof s.observeExpiry, 'function');
  s.observeExpiry();
  assert.equal(s.peekChange().placement, 'visible');
  s.failChange();

  s.observeExpiry();
  s.observeExpiry();
  staleTimer.fn();                                // a cancelled late callback is inert too
  assert.equal(s.peekChange(), null);

  s.apply(rec('error', '/d/error.png', {
    expiresAt: 2000,
    after: { state: 'working', sprite: { terminal: '/d/working.png' } },
  }));
  s.commitChange();
  h.advanceTo(2000);
  s.observeExpiry();                              // apply reset the one-shot marker
  assert.equal(s.peekChange().record.sprite.terminal, '/d/working.png');
});

test('sprite-state: a newer working record cancels the stale done timer', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('done', '/d/done.png', {
    expiresAt: 1000,
    after: { state: 'idle', sprite: { terminal: '/d/idle.png' } },
  }));
  const staleTimer = h.liveTimer();
  s.commitChange();
  // Superseding record arrives before expiry.
  s.apply(rec('working', '/d/working.png'));
  assert.equal(staleTimer.cancelled, true);       // cancelled on apply
  s.commitChange();                               // consume working pose
  // Even if the stale callback is somehow invoked, generation guards it.
  staleTimer.cancelled = false;
  staleTimer.fn();
  assert.equal(s.peekChange(), null);             // no wrongful decay to idle
  assert.equal(s.currentPose().state, 'working');
});

test('sprite-state: applying no record cancels and invalidates a stale decay timer', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('done', '/d/done.png', {
    expiresAt: 1000,
    after: { state: 'idle', sprite: { terminal: '/d/idle.png' } },
  }));
  const staleTimer = h.liveTimer();
  s.commitChange();
  s.apply(null);
  assert.equal(staleTimer.cancelled, true);
  assert.deepEqual(s.peekChange(), { record: null, programIdentity: null, placement: 'hidden' });
  s.commitChange();
  staleTimer.cancelled = false;
  staleTimer.fn();
  assert.equal(s.currentPose(), null);
  assert.equal(s.peekChange(), null);
});

test('sprite-state: a change that returns to the on-screen pose cancels the queued change', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('working', '/d/working.png'));
  s.commitChange();                               // working on screen
  s.apply(rec('idle', '/d/idle.png'));            // queue idle...
  assert.equal(s.peekChange().placement, 'visible'); // ...pending
  s.apply(rec('working', '/d/working.png'));      // record returns to working before the frame
  assert.equal(s.peekChange(), null);             // queued idle CANCELLED, no stale transmit
  assert.ok(s.programIdentity);
  assert.equal(h.poseChanges().at(-1).sprite.terminal, '/d/working.png'); // box height re-asserted
});

test('sprite-state: a queued pose that is then removed transmits nothing', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('working', '/d/working.png'));      // queued, never committed (no frame yet)
  s.apply(null);                                  // removed before the frame
  assert.equal(s.peekChange(), null);             // back to the on-screen state (null) -> nothing
  assert.equal(s.programIdentity, null);
});

test('sprite-state: a failed change is not re-offered until the next event (no frame-rate spin)', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('working', '/d/working.png'));
  assert.equal(s.peekChange().placement, 'visible');
  s.failChange();                              // the frame's write threw
  assert.equal(s.peekChange(), null);          // NOT retried this generation
  assert.equal(s.peekChange(), null);          // ...and still not, no matter how many frames
  s.apply(rec('working', '/d/working.png'));   // next watch event -> generation advances
  assert.equal(s.peekChange().placement, 'visible'); // re-offered exactly once
});

test('sprite-state: a decay timer advances generation, re-offering a failed change as its successor', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('done', '/d/done.png', {
    expiresAt: 1000,
    after: { state: 'idle', sprite: { terminal: '/d/idle.png' } },
  }));
  assert.equal(s.peekChange().placement, 'visible'); // done pending
  s.failChange();                                // done PNG write failed
  assert.equal(s.peekChange(), null);            // blocked at this generation
  h.advanceTo(1000);
  h.fireDue();                                   // decay fires -> generation++ then evaluate()
  const change = s.peekChange();
  assert.equal(change.placement, 'visible');     // re-offered (finding: decay must advance generation)...
  assert.equal(change.record.sprite.terminal, '/d/idle.png'); // ...as the decay successor, not the dead done pose
});

test('sprite-state: removing a committed record hides the placement (finding: pose->null)', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('working', '/d/working.png'));
  s.commitChange();
  s.apply(null);                                  // record gone
  const change = s.peekChange();
  assert.deepEqual(change, { record: null, programIdentity: null, placement: 'hidden' });
  s.commitChange();
  assert.equal(s.programIdentity, null);
  assert.equal(s.currentPose(), null);
  assert.equal(h.liveTimer(), null);
});

test('sprite-state: dispose cancels and invalidates a stale decay timer', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('done', '/d/done.png', {
    expiresAt: 1000,
    after: { state: 'idle', sprite: { terminal: '/d/idle.png' } },
  }));
  const staleTimer = h.liveTimer();
  const rendersBeforeDispose = h.renders();
  s.dispose();
  assert.equal(staleTimer.cancelled, true);
  staleTimer.cancelled = false;
  staleTimer.fn();
  assert.equal(s.currentPose(), null);
  assert.equal(s.peekChange(), null);
  assert.equal(h.renders(), rendersBeforeDispose);
});

test('sprite-state: marking a successful recovery hide preserves the pending desired pose', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('working', '/d/a.png'));
  s.commitChange();
  s.apply(rec('idle', '/d/b.png'));
  s.failChange();

  s.markPlacementHidden();
  assert.equal(s.programIdentity, null);
  assert.equal(s.peekChange(), null);              // still gated in the failed generation

  s.apply(rec('idle', '/d/b.png'));               // later event advances generation
  assert.equal(s.peekChange().placement, 'visible');
  assert.equal(s.peekChange().record.sprite.terminal, '/d/b.png');
});

test('sprite-state: after recovery hide, returning to the old pose retransmits it', () => {
  const h = harness(0);
  const s = createSpriteState(42, h.deps);
  s.apply(rec('working', '/d/a.png'));
  s.commitChange();
  s.apply(rec('idle', '/d/b.png'));
  s.failChange();
  s.markPlacementHidden();

  s.apply(rec('working', '/d/a.png'));
  assert.equal(s.peekChange().placement, 'visible');
  assert.equal(s.peekChange().record.sprite.terminal, '/d/a.png');
});
