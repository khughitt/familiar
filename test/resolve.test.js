import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdentity, resolveIdentities, resolveIntent, resolveAll } from '../src/bus/resolve.js';
import { autoSlot } from '../src/bus/identity.js';
import { parseIdentities } from '../src/bus/pins.js';
import { TTL_DONE_MS, TTL_ERROR_MS } from '../src/protocol/intent.js';
import { parseThemePack, STATES } from 'familiar-theme';

const POSES = STATES.map((s) => `      ${s}: a pose for ${s}`).join('\n');
const PACK = parseThemePack(`
spec-version: 2
id: cats
label: Cats
members:
  - id: ginger-tabby
    asset-root: sprites/ginger-tabby
    label: Ginger Tabby
    roles: [default, planner]
    persona: The Enthusiast.
    animation: { kind: static }
    poses:
${POSES}
  - id: dog-in-disguise
    asset-root: sprites/dog-in-disguise
    label: Dog in Disguise
    roles: [reviewer]
    persona: The Impostor.
    animation: { kind: static }
    poses:
${POSES}
  - id: schrodingers-cat
    asset-root: sprites/schrodingers-cat
    label: Schrodinger's Cat
    roles: []
    persona: The Uncertain.
    anchor: center
    animation: { kind: static }
    poses:
${POSES}
  - id: maine-coon
    asset-root: sprites/maine-coon
    label: Maine Coon
    roles: []
    persona: The Gentle Giant.
    animation: { kind: static }
    poses:
${POSES}
`, '/themes/cats');

const PLANTS = parseThemePack(`
spec-version: 2
id: plants
label: Plants
members:
  - id: fern
    asset-root: sprites/fern
    label: Fern
    roles: [default]
    persona: The Unfurling.
    animation: { kind: static }
    poses:
${POSES}
  - id: moss
    asset-root: sprites/moss
    label: Moss
    roles: []
    persona: The Patient.
    animation: { kind: static }
    poses:
${POSES}
`, '/themes/plants');

const PACKS = { cats: PACK, plants: PLANTS };
const packFor = (themeId) => {
  if (!Object.hasOwn(PACKS, themeId)) throw new Error(`theme "${themeId}" is not installed`);
  return PACKS[themeId];
};
// The same `themeId`/`families` keys loadConfig returns; `packFor` is synchronous and
// throws the theme's own load error.
const THEMES = { themeId: 'cats', families: { verifiably: 'plants' }, packFor };

const NO_PINS = parseIdentities('identities: []');
const DARK = { mode: 'dark', satScale: 1 };
const spriteFor = (theme, member, state) => ({
  terminal: `/${theme}/${member}/${state}.png`,
  rows: 12,
});
const CLIPS_REF = Object.freeze({
  kind: 'clips',
  manifest: '/theme/sprites/ginger-tabby/animation.yaml',
  sha256: 'abc123',
});
const animationFor = (theme, member) => theme === 'cats' && member === 'ginger-tabby' ? CLIPS_REF : { kind: 'static' };
const motionPolicy = 'full';

const record = (over = {}) => ({
  sessionId: 's1',
  projectKey: 'github.com/me/api',
  project: 'api',
  cwd: '/home/k/d/api',
  repositoryRoot: '/home/k/d/api',
  projectColor: null,
  family: null,
  role: null,
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
  repositoryRoot: '/home/k/d/api',
  projectColor: null,
  family: null,
  role: null,
};

const pinMember = (member, theme = 'cats') => parseIdentities(
  `identities:\n  - project: api\n    slot: 6\n    members:\n      ${theme}: ${member}\n`
);

test('an unpinned project with no role gets its slot by hash and the default member', () => {
  const identity = resolveIdentity({ ...ctx, catalog: NO_PINS, themes: THEMES });
  assert.deepEqual(identity, {
    projectKey: 'github.com/me/api',
    project: 'api',
    slot: 3,                      // frozen: autoSlot('github.com/me/api')
    member: 'ginger-tabby',       // the `default` holder
    label: 'Ginger Tabby',
    projectColor: null,
    source: 'auto',
    family: null,
    theme: 'cats',
    themeSource: 'default',
    role: null,
    memberSource: 'default',
    anchor: 'floor',
  });
});

test('role null with a pin naming a member resolves the pinned member', () => {
  const identity = resolveIdentity({ ...ctx, catalog: pinMember('schrodingers-cat'), themes: THEMES });
  assert.deepEqual(
    [identity.member, identity.label, identity.memberSource, identity.slot, identity.source],
    ['schrodingers-cat', "Schrodinger's Cat", 'pin', 6, 'pin'],
  );
});

test('a role the theme covers chooses its member, even over a pin', () => {
  const unpinned = resolveIdentity({ ...ctx, role: 'reviewer', catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([unpinned.member, unpinned.role, unpinned.memberSource], ['dog-in-disguise', 'reviewer', 'role']);
  const pinned = resolveIdentity({
    ...ctx, role: 'reviewer', catalog: pinMember('schrodingers-cat'), themes: THEMES,
  });
  assert.deepEqual([pinned.member, pinned.memberSource], ['dog-in-disguise', 'role']);
  // The pin still decides the slot: a role chooses a face, never a colour.
  assert.equal(pinned.slot, 6);
});

test('a role the theme covers beats a pin-free lookup of the default holder', () => {
  const identity = resolveIdentity({ ...ctx, role: 'planner', catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([identity.member, identity.memberSource], ['ginger-tabby', 'role']);
});

test('a role the theme does not cover falls back to the default holder, marked unmapped', () => {
  const identity = resolveIdentity({ ...ctx, role: 'poet', catalog: NO_PINS, themes: THEMES });
  assert.deepEqual(
    [identity.member, identity.role, identity.memberSource],
    ['ginger-tabby', 'poet', 'unmapped'],
  );
});

test('a role the theme does not cover yields to a pin', () => {
  const identity = resolveIdentity({
    ...ctx, role: 'poet', catalog: pinMember('maine-coon'), themes: THEMES,
  });
  assert.deepEqual([identity.member, identity.memberSource], ['maine-coon', 'pin']);
});

test('a role that is not a valid id throws', () => {
  assert.throws(
    () => resolveIdentity({ ...ctx, role: 'Reviewer', catalog: NO_PINS, themes: THEMES }),
    /role/,
  );
});

test('a family named in families: chooses its theme and that theme\'s default member', () => {
  const identity = resolveIdentity({ ...ctx, family: 'verifiably', catalog: NO_PINS, themes: THEMES });
  assert.deepEqual(
    [identity.family, identity.theme, identity.themeSource, identity.member, identity.label, identity.memberSource],
    ['verifiably', 'plants', 'family', 'fern', 'Fern', 'default'],
  );
});

test('a family not named in families: keeps the default theme', () => {
  const identity = resolveIdentity({ ...ctx, family: 'guild', catalog: NO_PINS, themes: THEMES });
  assert.deepEqual(
    [identity.family, identity.theme, identity.themeSource, identity.member],
    ['guild', 'cats', 'default', 'ginger-tabby'],
  );
});

test('a null family keeps the default theme', () => {
  const identity = resolveIdentity({ ...ctx, family: null, catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([identity.family, identity.theme, identity.themeSource], [null, 'cats', 'default']);
});

test('a family whose theme fails to load throws that theme\'s error', () => {
  const themes = {
    ...THEMES,
    packFor: (themeId) => {
      if (themeId === 'plants') throw new Error('theme "plants": theme.yaml: members must be a list');
      return packFor(themeId);
    },
  };
  assert.throws(
    () => resolveIdentity({ ...ctx, family: 'verifiably', catalog: NO_PINS, themes }),
    /theme "plants": theme\.yaml: members must be a list/,
  );
  // Only that family's theme is loaded: the default theme still resolves.
  assert.equal(resolveIdentity({ ...ctx, catalog: NO_PINS, themes }).member, 'ginger-tabby');
});

test('pins are theme-scoped: the resolved theme reads its own entry of a pin', () => {
  const catalog = parseIdentities(
    'identities:\n  - project: api\n    slot: 6\n    members:\n      cats: maine-coon\n      plants: moss\n'
  );
  const plants = resolveIdentity({ ...ctx, family: 'verifiably', catalog, themes: THEMES });
  assert.deepEqual([plants.theme, plants.member, plants.memberSource], ['plants', 'moss', 'pin']);
  const cats = resolveIdentity({ ...ctx, catalog, themes: THEMES });
  assert.deepEqual([cats.theme, cats.member, cats.memberSource], ['cats', 'maine-coon', 'pin']);
});

test('a pin naming a member the resolved theme lacks throws', () => {
  assert.throws(
    () => resolveIdentity({ ...ctx, family: 'verifiably', catalog: pinMember('cheshire', 'plants'), themes: THEMES }),
    /theme "plants" has no member "cheshire"/,
  );
  assert.throws(
    () => resolveIdentity({ ...ctx, catalog: pinMember('cheshire'), themes: THEMES }),
    /theme "cats" has no member "cheshire"/,
  );
});

test('a pin naming an unknown member throws even when a role would choose the member', () => {
  // The table lets a covered role win over a pin; it does not make a broken pin valid.
  assert.throws(
    () => resolveIdentity({ ...ctx, role: 'reviewer', catalog: pinMember('cheshire'), themes: THEMES }),
    /theme "cats" has no member "cheshire"/,
  );
});

test('the anchor is the resolved member\'s', () => {
  const center = resolveIdentity({ ...ctx, catalog: pinMember('schrodingers-cat'), themes: THEMES });
  assert.equal(center.anchor, 'center');
  const floor = resolveIdentity({ ...ctx, role: 'reviewer', catalog: NO_PINS, themes: THEMES });
  assert.equal(floor.anchor, 'floor');
});

test('a slot pin overrides the hash and no longer constrains the member', () => {
  const catalog = parseIdentities('identities:\n  - project: api\n    slot: 6\n');
  const identity = resolveIdentity({ ...ctx, catalog, themes: THEMES });
  assert.deepEqual([identity.slot, identity.source, identity.member], [6, 'pin', 'ginger-tabby']);
});

test('a member pinned beside any slot is accepted: the member/slot check is gone', () => {
  const catalog = parseIdentities(
    'identities:\n  - project: api\n    slot: 9\n    members:\n      cats: dog-in-disguise\n'
  );
  const identity = resolveIdentity({ ...ctx, catalog, themes: THEMES });
  assert.deepEqual([identity.slot, identity.member, identity.memberSource], [9, 'dog-in-disguise', 'pin']);
});

test('a member pin naming an uninstalled theme is INERT, not an error', () => {
  const identity = resolveIdentity({ ...ctx, catalog: pinMember('ember', 'elements'), themes: THEMES });
  assert.deepEqual([identity.member, identity.memberSource], ['ginger-tabby', 'default']);
});

test('a path pin matches a repo that ALSO has a remote — the pin is not silently ignored', () => {
  // 9, not 3: the hash would have given this ctx slot 3, so a matching slot
  // would prove nothing.
  const catalog = parseIdentities('identities:\n  - path: /home/k/d/api\n    slot: 9\n');
  const identity = resolveIdentity({ ...ctx, catalog, themes: THEMES });
  assert.equal(identity.slot, 9);
  assert.equal(identity.source, 'pin');
});

test('slot and colours are unchanged: a colour still decides the slot', () => {
  const ginger = resolveIdentity({ ...ctx, projectColor: '#bc8369', catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([ginger.slot, ginger.source, ginger.projectColor], [0, 'colour', '#bc8369']);
  const green = resolveIdentity({ ...ctx, projectColor: '#317d01', catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([green.slot, green.member, green.source], [3, 'ginger-tabby', 'colour']);
});

test('undefined family or role throws, as projectColor does', () => {
  assert.throws(
    () => resolveIdentity({ ...ctx, family: undefined, catalog: NO_PINS, themes: THEMES }),
    { message: 'resolveIdentity: family must be a string or null' },
  );
  assert.throws(
    () => resolveIdentity({ ...ctx, role: undefined, catalog: NO_PINS, themes: THEMES }),
    { message: 'resolveIdentity: role must be a string or null' },
  );
  assert.throws(
    () => resolveIdentity({ ...ctx, family: 7, catalog: NO_PINS, themes: THEMES }),
    { message: 'resolveIdentity: family must be a string or null' },
  );
});

// `default` is the one reserved role: it names the member an agent with no role gets,
// so a record carries null for that agent, never the word (controller ruling 8).
test('a role of "default" is refused, not resolved as a role', () => {
  assert.throws(
    () => resolveIdentity({ ...ctx, role: 'default', catalog: NO_PINS, themes: THEMES }),
    { message: 'resolveIdentity: role "default" is reserved for an agent with no role; pass null' },
  );
});

const identity = { projectKey: 'k', project: 'api', slot: 0, projectColor: null, source: 'auto', theme: 'cats', member: 'ginger-tabby', label: 'Ginger Tabby' };

// Two live themes may share a member id, so the asset callbacks are asked for the pair.
test('resolveIntent asks spriteFor and animationFor for its identity\'s theme and member', () => {
  const calls = [];
  const intent = resolveIntent({
    record: record({ state: 'done' }), identity: { ...identity, theme: 'forest', member: 'ginger' }, tone: DARK,
    spriteFor: (...args) => { calls.push(['sprite', ...args]); return spriteFor(...args); },
    animationFor: (...args) => { calls.push(['animation', ...args]); return animationFor(...args); },
    motionPolicy,
  });
  assert.deepEqual(calls, [
    ['animation', 'forest', 'ginger'], ['sprite', 'forest', 'ginger', 'done'], ['sprite', 'forest', 'ginger', 'idle'],
  ]);
  assert.equal(intent.current.sprite.terminal, '/forest/ginger/done.png');
});

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
    terminal: '/cats/ginger-tabby/idle.png',
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
    s2: record({ sessionId: 's2', role: 'reviewer' }),
    s3: record({ sessionId: 's3', family: 'verifiably' }),
  };
  const { identities, faults } = resolveIdentities({ agents, catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([...identities.keys()], ['s1', 's2', 's3']);
  assert.equal(identities.get('s1').member, 'ginger-tabby');
  assert.equal(identities.get('s2').member, 'dog-in-disguise');
  assert.deepEqual([identities.get('s3').theme, identities.get('s3').member], ['plants', 'fern']);
  assert.equal(faults.size, 0);
});

test('an unresolvable record is a FAULT ON THAT RECORD, not on the pass', () => {
  // The bug: this pass used to throw, and it runs over EVERY record on the bus on
  // EVERY hook. So one project's bad pin — or a `theme:` switch, or a renamed
  // member — took down every OTHER session on the machine, before anything was
  // written. Both files froze, for everybody, and reap could not heal it.
  //
  // A record that cannot be drawn is still a record that cannot be drawn. It just
  // does not get to decide anything about its neighbours. s1 is unpinned and must be
  // untouched by s2's broken config.
  const catalog = parseIdentities(
    'identities:\n  - project: zzz\n    slot: 1\n    members:\n      cats: cheshire\n'
  );
  const agents = {
    s1: record(),
    s2: record({ sessionId: 's2', projectKey: 'zzz', project: 'zzz', remote: null, repoRoot: '/x/zzz' }),
  };
  const { identities, faults } = resolveIdentities({ agents, catalog, themes: THEMES });

  assert.deepEqual([...identities.keys()], ['s1'], 'the healthy record still resolves');
  assert.equal(identities.get('s1').member, 'ginger-tabby');
  assert.match(faults.get('s2'), /theme "cats" has no member "cheshire"/);
  assert.equal(faults.size, 1);
});

test('a family whose theme fails to load faults only that family\'s records', () => {
  const themes = {
    ...THEMES,
    packFor: (themeId) => {
      if (themeId === 'plants') throw new Error('theme "plants": cannot parse theme.yaml');
      return packFor(themeId);
    },
  };
  const agents = { s1: record(), s2: record({ sessionId: 's2', family: 'verifiably' }) };
  const { identities, faults } = resolveIdentities({ agents, catalog: NO_PINS, themes });
  assert.deepEqual([...identities.keys()], ['s1']);
  assert.deepEqual([...faults], [['s2', 'theme "plants": cannot parse theme.yaml']]);
});

// A record written before repositoryRoot existed would otherwise hash its stored old key
// quietly. It faults instead, and the session's next hook re-admits it; an own null (outside
// any repository) is a real answer, and an inherited property is not an own one.
test('an old record faults while own null and healthy anchors resolve', () => {
  const old = record();
  delete old.repositoryRoot;
  const inherited = Object.assign(Object.create({ repositoryRoot: '/fixture/api' }), old);
  const agents = {
    old, inherited,
    outside: record({ sessionId: 'outside', repositoryRoot: null }),
    current: record({ sessionId: 'current', repositoryRoot: '/fixture/api' }),
  };
  const r = resolveIdentities({ agents, catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([...r.faults.keys()], ['old', 'inherited']);
  assert.match(r.faults.get('old'), /lacks repositoryRoot/);
  assert.deepEqual([...r.identities.keys()], ['outside', 'current']);
});

// A record written before family and role existed is not given a guessed theme or member:
// it faults, and its session's next hook writes both. An own null is an answer; an
// inherited property is not an own one.
test('resolveIdentities faults a record lacking its own family or role', () => {
  const noFamily = record({ sessionId: 'noFamily' });
  delete noFamily.family;
  const noRole = record({ sessionId: 'noRole' });
  delete noRole.role;
  const inherited = Object.assign(Object.create({ family: null }), noFamily, { sessionId: 'inherited' });
  const agents = { noFamily, noRole, inherited, current: record({ sessionId: 'current' }) };
  const result = resolveIdentities({ agents, catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([...result.faults], [
    ['noFamily', 'session record lacks family; wait for its next hook'],
    ['noRole', 'session record lacks role; wait for its next hook'],
    ['inherited', 'session record lacks family; wait for its next hook'],
  ]);
  assert.deepEqual([...result.identities.keys()], ['current']);
});

// A worktree resolves through its repository's pin: the winning pin's slot AND its own
// theme-scoped member map, validated exactly as any other pin's.
const WORKTREE = {
  projectKey: '/fixture/api', project: 'fix-api', remote: null,
  repoRoot: '/fixture/fix-api', repositoryRoot: '/fixture/api', projectColor: null,
  family: null, role: null,
};

test('a worktree inherits its repository path pin with the pin\'s member', () => {
  const catalog = { identities: [{ path: '/fixture/api', slot: 6,
    members: { cats: 'maine-coon', inactive: 'not-in-this-pack' } }] };
  const result = resolveIdentity({ ...WORKTREE, catalog, themes: THEMES });
  assert.equal(result.slot, 6);
  assert.equal(result.member, 'maine-coon');
  assert.equal(result.project, 'fix-api');
});

test('an inherited pin is validated like any pin', () => {
  const unknown = { identities: [{ path: '/fixture/api', slot: 6, members: { cats: 'cheshire' } }] };
  assert.throws(() => resolveIdentity({ ...WORKTREE, catalog: unknown, themes: THEMES }),
    /theme "cats" has no member "cheshire"/);
});

test('a worktree path pin brings its own member map, never the inherited one', () => {
  const catalog = { identities: [
    { path: '/fixture/api', slot: 6, members: { cats: 'maine-coon' } },
    { path: '/fixture/fix-api', slot: 6 },
  ] };
  const result = resolveIdentity({ ...WORKTREE, catalog, themes: THEMES });
  assert.equal(result.slot, 6);
  assert.equal(result.member, 'ginger-tabby', 'the default holder, not the inherited maine-coon');
});

test('resolveAll keys intent records by session id', () => {
  const agents = {
    s1: record(),
    s2: record({ sessionId: 's2', state: 'done', projectKey: 'github.com/me/api' }),
  };
  const { identities } = resolveIdentities({ agents, catalog: NO_PINS, themes: THEMES });
  const out = resolveAll({
    agents, identities, tone: DARK, spriteFor, animationFor, motionPolicy,
  });
  assert.deepEqual(Object.keys(out), ['s1', 's2']);
  assert.equal(out.s2.after.state, 'idle');
  assert.equal(out.s1.current.pid, 4242);
});

test('resolveAll takes the identity map rather than recomputing it — one pin-match pass per transaction, not two', () => {
  // The map IS the contract: resolveAll has no catalog or themes to fall back on,
  // so it cannot quietly re-resolve. A record with no identity is a caller bug,
  // and it says so instead of throwing on `undefined.slot`.
  const agents = { s1: record(), s2: record({ sessionId: 's2' }) };
  const { identities } = resolveIdentities({ agents, catalog: NO_PINS, themes: THEMES });
  identities.delete('s2');

  assert.throws(
    () => resolveAll({
      agents, identities, tone: DARK, spriteFor, animationFor, motionPolicy,
    }),
    /no resolved identity for session "s2"/
  );
});

test('an agreeing pin keeps its member choice under a colour', () => {
  const catalog = parseIdentities(`identities:\n  - path: ${ctx.repoRoot}\n    slot: 6\n    members:\n      cats: maine-coon\n`);
  const id = resolveIdentity({ ...ctx, projectColor: '#058dfa', catalog, themes: THEMES });
  assert.deepEqual([id.slot, id.member, id.source, id.projectColor], [6, 'maine-coon', 'colour', '#058dfa']);
});

test('a pin that disagrees with the colour is a fault naming both', () => {
  const catalog = parseIdentities(`identities:\n  - path: ${ctx.repoRoot}\n    slot: 4\n`);
  assert.throws(() => resolveIdentity({ ...ctx, projectColor: '#317d01', catalog, themes: THEMES }), {
    message: "pin declares slot 4, but project colour #317d01 (from tasks) maps to slot 3: "
      + "remove the pin or change the project's colour",
  });
});

test('without a colour the pin, then the hash, decide as before', () => {
  const catalog = parseIdentities(`identities:\n  - path: ${ctx.repoRoot}\n    slot: 6\n`);
  const pinned = resolveIdentity({ ...ctx, catalog, themes: THEMES });
  assert.deepEqual([pinned.slot, pinned.source, pinned.projectColor], [6, 'pin', null]);
  const automatic = resolveIdentity({ ...ctx, catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([automatic.slot, automatic.source, automatic.projectColor], [autoSlot(ctx.projectKey), 'auto', null]);
});

test('projectColor is required and validated', () => {
  assert.throws(() => resolveIdentity({ ...ctx, projectColor: undefined, catalog: NO_PINS, themes: THEMES }),
    /resolveIdentity: projectColor must be a #rrggbb string or null/);
  assert.throws(() => resolveIdentity({ ...ctx, projectColor: '#BC8369', catalog: NO_PINS, themes: THEMES }),
    /not a #rrggbb colour/);
});

test('a record without its own projectColor faults until its next hook', () => {
  const old = record();
  delete old.projectColor;
  const inherited = Object.assign(Object.create({ projectColor: '#317d01' }), old);
  const agents = { old, inherited, current: record({ sessionId: 'current', projectColor: null }) };
  const result = resolveIdentities({ agents, catalog: NO_PINS, themes: THEMES });
  assert.deepEqual([...result.faults], [
    ['old', 'session record lacks projectColor; wait for its next hook'],
    ['inherited', 'session record lacks projectColor; wait for its next hook'],
  ]);
  assert.deepEqual([...result.identities.keys()], ['current']);
});

test('the intent carries the exact colour as its project stop', () => {
  const identity = resolveIdentity({ ...ctx, projectColor: '#317d01', catalog: NO_PINS, themes: THEMES });
  const intent = resolveIntent({ record: record(), identity, tone: DARK, spriteFor, animationFor, motionPolicy });
  assert.equal(intent.current.color.project, '#317d01');
});
