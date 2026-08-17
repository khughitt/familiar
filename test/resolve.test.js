import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdentity, resolveIdentities, resolveIntent, resolveAll } from '../src/bus/resolve.js';
import { parseIdentities } from '../src/bus/pins.js';
import { TTL_DONE_MS, TTL_ERROR_MS } from '../src/protocol/intent.js';
import { parseThemePack, STATES } from 'familiar-theme';

const POSES = STATES.map((s) => `      ${s}: a pose for ${s}`).join('\n');
const PACK = parseThemePack(`
spec-version: 1
id: cats
label: Cats
members:
  - id: ginger-tabby
    asset-root: sprites/ginger-tabby
    label: Ginger Tabby
    slots: [0]
    persona: The Enthusiast.
    animation: { kind: static }
    poses:
${POSES}
  - id: dog-in-disguise
    asset-root: sprites/dog-in-disguise
    label: Dog in Disguise
    slots: [3]
    persona: The Impostor.
    animation: { kind: static }
    poses:
${POSES}
  - id: schrodingers-cat
    asset-root: sprites/schrodingers-cat
    label: Schrodinger's Cat
    slots: [6]
    persona: The Uncertain.
    animation: { kind: static }
    poses:
${POSES}
  - id: maine-coon
    asset-root: sprites/maine-coon
    label: Maine Coon
    slots: [6, 1, 2, 4, 5, 7, 8, 9, 10, 11]
    persona: The Gentle Giant.
    animation: { kind: static }
    poses:
${POSES}
`, '/themes/cats');

const NO_PINS = parseIdentities('identities: []');
const DARK = { mode: 'dark', satScale: 1 };
const spriteFor = (member, state) => ({
  terminal: `/c/${member}/${state}.png`,
  rows: 12,
});
const CLIPS_REF = Object.freeze({
  kind: 'clips',
  manifest: '/theme/sprites/ginger-tabby/animation.yaml',
  sha256: 'abc123',
});
const animationFor = (member) => member === 'ginger-tabby' ? CLIPS_REF : { kind: 'static' };
const motionPolicy = 'full';

const record = (over = {}) => ({
  sessionId: 's1',
  projectKey: 'github.com/me/api',
  project: 'api',
  cwd: '/home/k/d/api',
  pid: 4242,
  state: 'working',
  updatedAt: 1_000_000,
  ...over,
});

// The match context a real AgentRecord carries. projectKey collapses to the
// remote when there is one, so remote/repoRoot are kept alongside it — a `path:`
// pin must still be able to match a repo that also has a remote.
const ctx = {
  projectKey: 'github.com/me/api',
  project: 'api',
  remote: 'github.com/me/api',
  repoRoot: '/home/k/d/api',
};

test('an unpinned project is hashed to a slot and gets that slot default member', () => {
  const identity = resolveIdentity({ ...ctx, catalog: NO_PINS, pack: PACK });
  assert.deepEqual(identity, {
    projectKey: 'github.com/me/api',
    project: 'api',
    slot: 3,                      // frozen: autoSlot('github.com/me/api')
    member: 'dog-in-disguise',    // slot 3's only member, therefore its default
    label: 'Dog in Disguise',
  });
});

test('a pin is accepted for any slot its member holds', () => {
  // maine-coon is declared for slot 6 and absorbs the fixture's uncovered slots,
  // so it holds 9 as well. Before spec-version 1 a member held exactly one slot
  // and this pin was a contradiction; now it is the ordinary case.
  const catalog = parseIdentities(
    'identities:\n  - project: api\n    slot: 9\n    members:\n      cats: maine-coon\n'
  );
  const identity = resolveIdentity({ ...ctx, catalog, pack: PACK });
  assert.equal(identity.slot, 9);
  assert.equal(identity.member, 'maine-coon');
});

test('a slot pin overrides the hash', () => {
  const catalog = parseIdentities('identities:\n  - project: api\n    slot: 6\n');
  const identity = resolveIdentity({ ...ctx, catalog, pack: PACK });
  assert.equal(identity.slot, 6);
  assert.equal(identity.member, 'schrodingers-cat');   // first member declared for slot 6
});

test('a theme-scoped member pin selects the alternate', () => {
  const catalog = parseIdentities(
    'identities:\n  - project: api\n    slot: 6\n    members:\n      cats: maine-coon\n'
  );
  const identity = resolveIdentity({ ...ctx, catalog, pack: PACK });
  assert.equal(identity.member, 'maine-coon');
  assert.equal(identity.label, 'Maine Coon');
});

test('a member pin naming an uninstalled theme is INERT, not an error', () => {
  const catalog = parseIdentities(
    'identities:\n  - project: api\n    slot: 6\n    members:\n      elements: ember\n'
  );
  const identity = resolveIdentity({ ...ctx, catalog, pack: PACK });
  assert.equal(identity.member, 'schrodingers-cat');   // falls back to the slot default
});

test('a path pin matches a repo that ALSO has a remote — the pin is not silently ignored', () => {
  // 9, not 3: the hash would have given this ctx slot 3, so a matching slot
  // would prove nothing. maine-coon absorbs the fixture's uncovered slots.
  const catalog = parseIdentities('identities:\n  - path: /home/k/d/api\n    slot: 9\n');
  const identity = resolveIdentity({ ...ctx, catalog, pack: PACK });
  assert.equal(identity.slot, 9);
  assert.equal(identity.member, 'maine-coon');
});

test('a member pinned to a DIFFERENT slot is a contradiction, resolved in neither direction', () => {
  const catalog = parseIdentities(
    'identities:\n  - project: api\n    slot: 6\n    members:\n      cats: ginger-tabby\n'
  );
  assert.throws(
    () => resolveIdentity({ ...ctx, catalog, pack: PACK }),
    /member "ginger-tabby" holds slot 0, but the pin declares slot 6/
  );
});

test('the contradiction message lists ALL the slots a multi-slot member holds', () => {
  // The plural branch of the same message, and under spec-version 1 it is the
  // COMMON one: a member holds one or more slots, so most real pins that go wrong
  // go wrong against a multi-slot member. Only the singular branch was covered,
  // which left `slots ${member.slots.join(', ')}` free to print `[object Object]`
  // or one slot or nothing at all — in the exact string a user reads when their
  // own pin is the thing that is broken. maine-coon holds ten slots; 0 is not
  // among them, it is ginger-tabby's.
  const catalog = parseIdentities(
    'identities:\n  - project: api\n    slot: 0\n    members:\n      cats: maine-coon\n'
  );
  assert.throws(
    () => resolveIdentity({ ...ctx, catalog, pack: PACK }),
    /member "maine-coon" holds slots 6, 1, 2, 4, 5, 7, 8, 9, 10, 11, but the pin declares slot 0/
  );
});

test('a member pin unknown to its own theme is an error', () => {
  const catalog = parseIdentities(
    'identities:\n  - project: api\n    slot: 6\n    members:\n      cats: sphynx\n'
  );
  assert.throws(
    () => resolveIdentity({ ...ctx, catalog, pack: PACK }),
    /theme "cats" has no member "sphynx"/
  );
});

const identity = { projectKey: 'k', project: 'api', slot: 0, member: 'ginger-tabby', label: 'Ginger Tabby' };

test('a persistent state has no expiry and no successor', () => {
  const intent = resolveIntent({
    record: record({ state: 'needs-input' }), identity, tone: DARK,
    spriteFor, animationFor, motionPolicy,
  });
  assert.equal(intent.expiresAt, null);
  assert.equal(intent.after, null);
  assert.equal(intent.current.state, 'needs-input');
  assert.equal(intent.current.urgency, 'demand');
  assert.equal(intent.current.motion, 'pulse');
});

test('state owns urgency and motion; it never repaints the identity hue', () => {
  const working = resolveIntent({
    record: record({ state: 'working' }), identity, tone: DARK,
    spriteFor, animationFor, motionPolicy,
  });
  const erroring = resolveIntent({
    record: record({ state: 'error' }), identity, tone: DARK,
    spriteFor, animationFor, motionPolicy,
  });

  // An erroring ginger tabby is still ginger.
  assert.deepEqual(working.current.color, erroring.current.color);
  assert.equal(erroring.current.color.base, '#d68251');
  assert.notEqual(working.current.motion, erroring.current.motion);
});

test('a transient state carries its expiry AND its fully-resolved successor', () => {
  const done = resolveIntent({
    record: record({ state: 'done' }), identity, tone: DARK,
    spriteFor, animationFor, motionPolicy,
  });
  assert.equal(done.expiresAt, 1_000_000 + TTL_DONE_MS);
  assert.equal(done.after.state, 'idle');
  assert.equal(done.after.motion, 'breathe');
  assert.equal(done.after.urgency, 'none');
  assert.deepEqual(done.after.sprite, {
    terminal: '/c/ginger-tabby/idle.png',
    rows: 12,
  });
  assert.equal(done.current.motionPolicy, 'full');
  assert.equal(done.after.motionPolicy, 'full');
  assert.strictEqual(done.current.animation, CLIPS_REF);
  assert.strictEqual(done.after.animation, CLIPS_REF);
  const serialized = JSON.stringify(done);
  assert.doesNotMatch(serialized, /"clips"\s*:/);
  assert.doesNotMatch(serialized, /"frames"\s*:/);
  assert.doesNotMatch(serialized, /"bytes"\s*:/);

  const err = resolveIntent({
    record: record({ state: 'error' }), identity, tone: DARK,
    spriteFor, animationFor, motionPolicy,
  });
  assert.equal(err.expiresAt, 1_000_000 + TTL_ERROR_MS);   // longer: a failure deserves to be noticed
  assert.equal(err.after.state, 'idle');
});

test('the successor is a complete Intent — a renderer decides WHEN to swap, never WHAT to', () => {
  const done = resolveIntent({
    record: record({ state: 'done' }), identity, tone: DARK,
    spriteFor, animationFor, motionPolicy,
  });
  assert.deepEqual(Object.keys(done.after).sort(), Object.keys(done.current).sort());
});

test('an unknown state throws rather than defaulting to idle', () => {
  assert.throws(
    () => resolveIntent({
      record: record({ state: 'busy' }), identity, tone: DARK,
      spriteFor, animationFor, motionPolicy,
    }),
    /unknown state: busy/
  );
});

test('resolveIntent rejects a missing motionPolicy before resolving any member data', () => {
  let touchedMember = false;
  assert.throws(
    () => resolveIntent({
      record: record(),
      identity,
      tone: DARK,
      spriteFor: () => { touchedMember = true; },
      animationFor: () => { touchedMember = true; },
    }),
    /resolveIntent: motionPolicy must be exactly full, reduced, or off \(found undefined\)/,
  );
  assert.equal(touchedMember, false);
});

test('resolveIntent rejects an unknown motionPolicy before resolving any member data', () => {
  let touchedMember = false;
  assert.throws(
    () => resolveIntent({
      record: record(),
      identity,
      tone: DARK,
      spriteFor: () => { touchedMember = true; },
      animationFor: () => { touchedMember = true; },
      motionPolicy: 'sometimes',
    }),
    /resolveIntent: motionPolicy must be exactly full, reduced, or off \(found "sometimes"\)/,
  );
  assert.equal(touchedMember, false);
});

test('resolveIntent names a missing animationFor dependency before building an intent', () => {
  let touchedSprite = false;
  assert.throws(
    () => resolveIntent({
      record: record(),
      identity,
      tone: DARK,
      spriteFor: () => { touchedSprite = true; },
      motionPolicy,
    }),
    /resolveIntent: animationFor must be a function \(found undefined\)/,
  );
  assert.equal(touchedSprite, false);
});

test('resolveIntent rejects a non-function animationFor dependency by name', () => {
  let touchedSprite = false;
  assert.throws(
    () => resolveIntent({
      record: record(),
      identity,
      tone: DARK,
      spriteFor: () => { touchedSprite = true; },
      animationFor: { kind: 'static' },
      motionPolicy,
    }),
    /resolveIntent: animationFor must be a function \(found object\)/,
  );
  assert.equal(touchedSprite, false);
});

test('resolveIdentities resolves every record once, keyed by session id', () => {
  const agents = {
    s1: record(),
    s2: record({ sessionId: 's2', projectKey: 'github.com/me/api' }),
  };
  const { identities, faults } = resolveIdentities({ agents, catalog: NO_PINS, pack: PACK });
  assert.deepEqual([...identities.keys()], ['s1', 's2']);
  assert.equal(identities.get('s1').member, 'dog-in-disguise');
  assert.equal(faults.size, 0);
});

test('an unresolvable record is a FAULT ON THAT RECORD, not on the pass', () => {
  // The bug: this pass used to throw, and it runs over EVERY record on the bus on
  // EVERY hook. So one project's bad pin — or a `theme:` switch, or a renamed
  // member — took down every OTHER session on the machine, before anything was
  // written. Both files froze, for everybody, and reap could not heal it.
  //
  // A record that cannot be drawn is still a record that cannot be drawn. It just
  // does not get to decide anything about its neighbours.
  //
  // A gap is impossible now that every slot is covered, so the fault is the other
  // per-record cause resolveIdentity has always had: a member renamed out of the
  // theme. s1 is unpinned and must be untouched by s2's broken config.
  const catalog = parseIdentities(
    'identities:\n  - project: zzz\n    slot: 1\n    members:\n      cats: cheshire\n'
  );
  const agents = {
    s1: record(),                                                    // fine: slot 3
    s2: record({ sessionId: 's2', projectKey: 'zzz', project: 'zzz', remote: null, repoRoot: '/x/zzz' }),
  };
  const { identities, faults } = resolveIdentities({ agents, catalog, pack: PACK });

  assert.deepEqual([...identities.keys()], ['s1'], 'the healthy record still resolves');
  assert.equal(identities.get('s1').member, 'dog-in-disguise');
  assert.match(faults.get('s2'), /theme "cats" has no member "cheshire"/);
  assert.equal(faults.size, 1);
});

test('resolveAll keys intent records by session id', () => {
  const agents = {
    s1: record(),
    s2: record({ sessionId: 's2', state: 'done', projectKey: 'github.com/me/api' }),
  };
  const { identities } = resolveIdentities({ agents, catalog: NO_PINS, pack: PACK });
  const out = resolveAll({
    agents, identities, tone: DARK, spriteFor, animationFor, motionPolicy,
  });
  assert.deepEqual(Object.keys(out), ['s1', 's2']);
  assert.equal(out.s2.after.state, 'idle');
  assert.equal(out.s1.current.pid, 4242);
});

test('resolveAll takes the identity map rather than recomputing it — one pin-match pass per transaction, not two', () => {
  // The map IS the contract: resolveAll no longer has a catalog or a pack to
  // fall back on, so it cannot quietly re-resolve. A record with no identity is
  // a caller bug, and it says so instead of throwing on `undefined.slot`.
  const agents = { s1: record(), s2: record({ sessionId: 's2' }) };
  const { identities } = resolveIdentities({ agents, catalog: NO_PINS, pack: PACK });
  identities.delete('s2');

  assert.throws(
    () => resolveAll({
      agents, identities, tone: DARK, spriteFor, animationFor, motionPolicy,
    }),
    /no resolved identity for session "s2"/
  );
});
