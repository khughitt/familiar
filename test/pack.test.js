import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseThemePack, loadThemePack, validateThemePack, defaultMemberForSlot, memberOrThrow,
  DEFAULT_ROWS, SPEC_VERSION,
} from 'familiar-theme';
import { writePack } from './helpers/fixture.js';

const POSES = `
      idle: sprawled belly-up, one leg twitching
      working: frantic batting, blurred paws
      needs-input: sitting far too close, unblinking stare
      needs-approval: one paw on your arm, insistent
      error: all four paws airborne, comic startle
      done: proud, sitting beside the thing it broke`;

const YAML = `
spec-version: 1
id: cats
label: Cats
members:
  - id: ginger-tabby
    asset-root: sprites/ginger-tabby
    label: Ginger Tabby
    slots: [0]
    persona: The Enthusiast. Boundless energy, zero impulse control.
    animation: { kind: static }
    poses:${POSES}
  - id: siamese
    asset-root: sprites/siamese
    label: Siamese
    slots: [1]
    persona: The Backseat Driver. Vocal, bossy, narrates everything.
    animation: { kind: static }
    poses:${POSES}
  - id: lion
    asset-root: sprites/lion
    label: Lion
    slots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    persona: The Sovereign. Grandiose, theatrical, expects tribute.
    animation: { kind: static }
    poses:${POSES}
`;

const WITH_STATIC_ANIMATION = YAML;

test('every member must declare animation explicitly, naming the member when it is missing', () => {
  const missing = YAML.replace('    animation: { kind: static }\n', '');
  assert.throws(
    () => parseThemePack(missing, '/themes/cats'),
    /theme "cats": member "ginger-tabby" is missing animation declaration/,
  );
});

for (const [label, declaration] of [
  ['an empty object', '{}'],
  ['an unknown kind', '{ kind: stop-motion }'],
  ['an extra key', '{ kind: static, frames: [] }'],
]) {
  test(`animation rejects ${label} with the member id`, () => {
    const broken = WITH_STATIC_ANIMATION.replace(
      'animation: { kind: static }',
      `animation: ${declaration}`,
    );
    assert.throws(
      () => parseThemePack(broken, '/themes/cats'),
      /theme "cats": member "ginger-tabby": animation must be exactly \{ kind: static\|clips \}/,
    );
  });
}

test('animation parses the exact static discriminant', () => {
  const member = parseThemePack(WITH_STATIC_ANIMATION, '/themes/cats').members.get('ginger-tabby');
  assert.deepEqual(member.animation, { kind: 'static' });
  assert.ok(Object.isFrozen(member.animation));
});

test('animation parses the exact clips discriminant', () => {
  const yaml = WITH_STATIC_ANIMATION.replace(
    'animation: { kind: static }',
    'animation: { kind: clips }',
  );
  assert.deepEqual(
    parseThemePack(yaml, '/themes/cats').members.get('ginger-tabby').animation,
    { kind: 'clips' },
  );
});

test('loads members and indexes them by slot', () => {
  const pack = parseThemePack(YAML, '/themes/cats');
  assert.equal(pack.id, 'cats');
  assert.equal(pack.label, 'Cats');
  assert.deepEqual(pack.members.get('lion').slots, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(pack.bySlot.get(1), ['siamese', 'lion']);
});

test('member order within a slot is significant — the first is the default', () => {
  const pack = parseThemePack(YAML, '/themes/cats');
  assert.equal(defaultMemberForSlot(pack, 1), 'siamese');
  assert.equal(defaultMemberForSlot(pack, 0), 'ginger-tabby');
});

test('a leftover slot: names the change instead of reading as a typo', () => {
  const old = YAML.replace('slots: [0]', 'slot: 0');
  assert.throws(() => parseThemePack(old, '/tmp/x'),
    /"slot" was replaced by "slots" in spec-version 1 — write: slots: \[0\]/);
});

test('slots must be a non-empty, duplicate-free array of valid slots', () => {
  const cases = [
    ['slots: 0', /slots must be an array/],
    ['slots: []', /slots is empty/],
    ['slots: [0, 0]', /slots repeats 0/],
    ['slots: [12]', /slot out of range/],
    ['slots: [1.5]', /slot out of range/],
  ];
  for (const [replacement, pattern] of cases) {
    assert.throws(() => parseThemePack(YAML.replace('slots: [0]', replacement), '/tmp/x'), pattern);
  }
});

test('every slot must be held by some member, and the gap is named', () => {
  // Replaces the deleted "a slot with no member names the gap" test: the gap is
  // now impossible in a parsed pack, so the guarantee moved from resolution time
  // to parse time and this is its only home.
  //
  // Target `lion`'s list by its exact text. A regex for the FIRST `slots: [1...]`
  // matches siamese's unchanged `slots: [1]` and replaces it with itself -- a
  // silent no-op that leaves the fixture fully covered and the test vacuous.
  const short = YAML.replace('slots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]', 'slots: [1]');
  assert.notEqual(short, YAML, 'the fixture text moved — retarget this replacement');
  assert.throws(() => parseThemePack(short, '/tmp/x'), /no member holds slots 2, 3, 4, 5, 6, 7, 8, 9, 10, 11/);
});

test('one member may cover every slot', () => {
  const solo = `spec-version: 1
id: cats
label: Cats
members:
  - id: ginger-tabby
    asset-root: sprites/ginger-tabby
    label: Ginger Tabby
    slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    persona: The Enthusiast.
    animation: { kind: static }
    poses:${POSES}`;
  const pack = parseThemePack(solo, '/tmp/x');
  assert.equal(pack.members.size, 1);
  for (let slot = 0; slot < 12; slot++) {
    assert.equal(defaultMemberForSlot(pack, slot), 'ginger-tabby');
  }
});

test('overlap is allowed and the first member declared for a slot still wins', () => {
  const pack = parseThemePack(YAML, '/tmp/x');
  assert.equal(defaultMemberForSlot(pack, 1), 'siamese');
});

test('a member missing a pose is a validation error naming the pose', () => {
  const broken = YAML.replace('      error: all four paws airborne, comic startle\n', '');
  assert.throws(
    () => parseThemePack(broken, '/themes/cats'),
    /member "ginger-tabby" is missing pose: error/
  );
});

test('a member missing a persona is a validation error — six identical poses is the bug it prevents', () => {
  const broken = YAML.replace('    persona: The Enthusiast. Boundless energy, zero impulse control.\n', '');
  assert.throws(
    () => parseThemePack(broken, '/themes/cats'),
    /member "ginger-tabby" is missing persona/
  );
});

test('a member declaring a slot outside the canonical twelve is rejected, and the message names the member', () => {
  const broken = YAML.replace('    slots: [0]\n', '    slots: [12]\n');
  assert.throws(
    () => parseThemePack(broken, '/themes/cats'),
    (err) => err.message === 'theme "cats": member "ginger-tabby": slot out of range: 12'
  );
});

test('a duplicate member id is rejected rather than silently overwritten', () => {
  const broken = YAML.replace('  - id: siamese', '  - id: ginger-tabby');
  assert.throws(() => parseThemePack(broken, '/themes/cats'), /duplicate member id: ginger-tabby/);
});

test('a member id that escapes the pack directory is rejected at parse — assetsFor must never see it', () => {
  const broken = YAML.replace('  - id: ginger-tabby', '  - id: ../../../../etc/passwd');
  assert.throws(
    () => parseThemePack(broken, '/themes/cats'),
    (err) => err.message === 'theme "cats": member id "../../../../etc/passwd" is invalid — ids may only '
      + 'contain lowercase letters, digits, and hyphens (e.g. "ginger-tabby")'
  );
});

// The THEME's own id, not a member's. theme.yaml is a shareable, downloadable
// artifact, and the id inside it is the same charset that config.yaml's `theme:`
// must satisfy — the one themeDirFor() joins into a themes dir (src/config.js:33).
// Validating it HERE too means a pack cannot smuggle in, through a file the user
// downloaded, an id that the config path already refuses to accept typed:
//
//   themeDirFor(paths, '../../../../home/k/.config/autostart')
//     -> /home/k/.config/autostart          (join() collapses "..")
//
// The theme id needs this MORE than the member ids do, not less: a member id is
// only reachable through a pack whose id already had to pass this same check.
test('a THEME id that escapes its directory is rejected at parse — a downloaded pack must not name a path outside the themes dir', () => {
  const broken = YAML.replace('id: cats', 'id: ../../../../home/k/.config/autostart');
  assert.throws(
    () => parseThemePack(broken, '/themes/cats'),
    (err) => err.message === 'theme.yaml: id "../../../../home/k/.config/autostart" is invalid — '
      + 'ids may only contain lowercase letters, digits, and hyphens (e.g. "cats")'
  );
});

test('a theme id with a bare path separator is rejected too — not just the ".." form', () => {
  const broken = YAML.replace('id: cats', 'id: cats/../../etc');
  assert.throws(() => parseThemePack(broken, '/themes/cats'), /theme\.yaml: id ".*" is invalid/);
});

test('a missing theme id is still an error, and now says so in the same words', () => {
  const broken = YAML.replace('id: cats\n', '');
  assert.throws(() => parseThemePack(broken, '/themes/cats'), /theme\.yaml: id is missing/);
});

test('an id with an uppercase letter, underscore, or other char outside the charset is rejected', () => {
  const broken = YAML.replace('  - id: ginger-tabby', '  - id: Ginger_Tabby');
  assert.throws(
    () => parseThemePack(broken, '/themes/cats'),
    (err) => err.message === 'theme "cats": member id "Ginger_Tabby" is invalid — ids may only contain '
      + 'lowercase letters, digits, and hyphens (e.g. "ginger-tabby")'
  );
});

test('a stray "-" under members (a blank list item) parses to a null entry and is a named validation error, not a raw crash', () => {
  const broken = YAML.replace('  - id: ginger-tabby', '  -\n  - id: ginger-tabby');
  assert.throws(
    () => parseThemePack(broken, '/themes/cats'),
    (err) => err.message === 'theme "cats": member at index 0 is not an object (found null)'
  );
});

test('memberOrThrow names the theme it searched', () => {
  const pack = parseThemePack(YAML, '/themes/cats');
  assert.equal(memberOrThrow(pack, 'lion').label, 'Lion');
  assert.throws(() => memberOrThrow(pack, 'maine-coon'), /theme "cats" has no member "maine-coon"/);
});

// --- rows: how tall the familiar stands, one number per theme -----------------
//
// THEME-LEVEL SCALAR, not per state. compile.mjs's canonicalise() composites all six of a
// member's poses onto one shared canvas, so they are the same size and a per-state height
// could only scale that one shared canvas differently per mood — the resize jitter canonicalise
// exists to prevent. parseThemePack returns the number (or the default), so assets.js and
// emit.js read `pack.rows` with no `?? 12` of their own.

const rowsYaml = (value) => YAML.replace('members:', `rows: ${value}\nmembers:`);

test('a theme with no rows: gets DEFAULT_ROWS', () => {
  // KILLS: a default of undefined (kitty draws a full-height cat) or 0.
  const pack = parseThemePack(YAML, '/themes/cats');
  assert.equal(DEFAULT_ROWS, 12);
  assert.equal(pack.rows, 12);
});

test('a theme stating rows takes THAT number', () => {
  assert.equal(parseThemePack(rowsYaml('8'), '/themes/cats').rows, 8);
});

test('rows: a per-state MAP is rejected with a message naming the migration', () => {
  // The per-state map is the PRE-scalar schema. A user-authored theme still carrying it
  // must be TOLD to convert, not silently stranded at the default.
  assert.throws(
    () => parseThemePack(YAML.replace('members:', 'rows:\n  needs-input: 10\nmembers:'), '/themes/cats'),
    (err) => err.message === 'theme "cats": rows must be a single whole number for the theme, not a '
      + 'per-state map — per-state rows: is no longer supported; the shared canvas makes one height '
      + 'per theme the honest shape',
  );
});

test('rows: a LIST is rejected the same way — it is not a height either', () => {
  assert.throws(
    () => parseThemePack(rowsYaml('[10, 12]'), '/themes/cats'),
    /rows must be a single whole number for the theme, not a per-state map/,
  );
});

// A float, a quoted string, an empty value, and a boolean fail the SCALAR check, and they
// get the plain whole-number error — NOT the migration message, which is only for the map
// they did not write.
for (const [label, value, found] of [
  ['a float', '10.5', '10.5'],
  ['a quoted string', '"10"', '"10"'],
  ['an empty value (null)', '', 'null'],
  ['a boolean', 'true', 'true'],
]) {
  test(`rows: a scalar that is not a whole number throws the plain error — ${label}`, () => {
    // KILLS: dropping Number.isInteger, any coercion, and — the P2b fix — attaching the
    // per-state migration message to a value that is not a map.
    assert.throws(
      () => parseThemePack(rowsYaml(value), '/themes/cats'),
      (err) => err.message === `theme "cats": rows must be a whole number (found ${found})`,
    );
  });
}

for (const [label, value] of [['zero — an invisible cat', 0], ['41 — past a screenful', 41]]) {
  test(`rows: a value outside 1..40 throws — ${label}`, () => {
    // KILLS: dropping either half of the range test, and any CLAMPING to the bound.
    assert.throws(
      () => parseThemePack(rowsYaml(value), '/themes/cats'),
      (err) => err.message === `theme "cats": rows is ${value} — rows must be between 1 and 40 inclusive`,
    );
  });
}

test('rows: the bounds themselves are ACCEPTED — 1 and 40 are inclusive', () => {
  // KILLS: <= / >= slipped by one.
  assert.equal(parseThemePack(rowsYaml('1'), '/themes/cats').rows, 1);
  assert.equal(parseThemePack(rowsYaml('40'), '/themes/cats').rows, 40);
});

test('loadThemePack reads theme.yaml from a real pack directory on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-pack-'));
  writeFileSync(join(dir, 'theme.yaml'), YAML);

  const pack = await loadThemePack(dir);
  assert.equal(pack.id, 'cats');
  assert.equal(pack.dir, dir);
  assert.equal(defaultMemberForSlot(pack, 0), 'ginger-tabby');
});

test('loadThemePack honors an injected readFile — it never assumes the real filesystem', async () => {
  const readFile = async (path) => {
    assert.equal(path, join('/themes/cats', 'theme.yaml'));
    return YAML;
  };
  const realpath = async (path) => path;
  const lstat = async (path) => ({
    isFile: () => path.endsWith('theme.yaml'),
    isDirectory: () => !path.endsWith('theme.yaml'),
    isSymbolicLink: () => false,
  });
  const pack = await loadThemePack('/themes/cats', { readFile, realpath, lstat });
  assert.equal(pack.id, 'cats');
});

// `YAML` is the fixture already at the top of this file. Inserting after the
// label line keeps the members block untouched.
const withDescription = (value) =>
  YAML.replace('label: Cats', `label: Cats\ndescription: ${JSON.stringify(value)}`);

test('a theme description is carried onto the pack', () => {
  const pack = parseThemePack(withDescription('Twelve cats.'), '/themes/cats');
  assert.equal(pack.description, 'Twelve cats.');
});

// Absent is the common case — `cats` shipped without one — and must stay legal.
test('an absent description is null, not undefined', () => {
  const pack = parseThemePack(YAML, '/themes/cats');
  assert.equal(pack.description, null);
});

// Fail early. An empty string is someone who meant to write one, and a listing
// that silently renders a blank cell hides that.
test('a blank description is refused by name', () => {
  assert.throws(
    () => parseThemePack(withDescription('   '), '/themes/cats'),
    /description/,
  );
});

// FIX 6: description must be STORED trimmed, not merely validated trimmed.
// `description: >` and `description: |` are the idiomatic way to write a
// multi-sentence blurb and both always yield a trailing newline — persona
// and poses[state] are already stored trimmed (the sibling string fields),
// and an untrimmed description puts a blank line inside the `themes` listing
// and after the `theme` header.
test('a description with surrounding whitespace is stored trimmed', () => {
  const pack = parseThemePack(withDescription('  Twelve cats.\n'), '/themes/cats');
  assert.equal(pack.description, 'Twelve cats.');
});

// FIX 7: a BARE `description:` (no value) parses to null, not undefined —
// an explicitly-present key, not an absent one — and is refused as a type
// error naming the field and the value. That is correct and stays: treating
// an explicitly-present key as absent would be the silent fallback this
// codebase forbids (`?? null` swallowing the distinction between "not
// written" and "written as nothing"). It was untested, so nothing stopped
// someone "fixing" it into exactly that fallback unnoticed.
test('a bare description: (null) is refused by name, not treated as absent', () => {
  assert.throws(
    () => parseThemePack(YAML.replace('label: Cats', 'label: Cats\ndescription:'), '/themes/cats'),
    /description.*null/s,
  );
});

// --- spec-version: which contract this theme.yaml speaks --------------------

test('spec-version is required', () => {
  const withoutVersion = YAML.replace(/^spec-version: 1\n/m, '');
  assert.throws(() => parseThemePack(withoutVersion, '/tmp/x'), /missing spec-version/);
});

test('D1: pre-id parser errors name the descriptor via the caller label', () => {
  assert.throws(() => parseThemePack('label: x\n', '/abs/themes/cats'),
    /\/abs\/themes\/cats\/theme\.yaml: missing spec-version/);
  assert.throws(
    () => parseThemePack('label: x\n', '/abs/themes/cats', { descriptorLabel: 'theme.yaml' }),
    (e) => { assert.match(e.message, /^theme\.yaml: missing spec-version/); return true; },
  );
});

test('D2: the slot->slots migration message renders non-integers through shown()', () => {
  const descriptor = `spec-version: 1\nid: t\nlabel: T\nmembers:\n  - id: m\n    label: M\n    slot: "3"\n`;
  assert.throws(() => parseThemePack(descriptor, '/x'), /write: slots: \["3"\]/);
});

test('D10: a non-object poses names the shape, not "unknown key 0"', () => {
  const descriptor = `spec-version: 1\nid: t\nlabel: T\nmembers:\n  - id: m\n    label: M\n    slots: [0]\n    persona: p\n    asset-root: sprites/m\n    animation: {kind: static}\n    poses: [a, b]\n`;
  assert.throws(() => parseThemePack(descriptor, '/x'), (e) => {
    assert.equal(e.message,
      'theme "t": member "m": poses must be a map of the six states (found a,b)');
    assert.doesNotMatch(e.message, /unknown key "0"/);
    return true;
  });
});

test('the gate stays pack-relative through the D1 label', async (t) => {
  const dir = writePack({ descriptor: 'label: broken\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(() => validateThemePack(dir), (e) => {
    assert.match(e.message, /^theme\.yaml: missing spec-version/);
    assert.ok(!e.message.includes(dir));
    return true;
  });
});

test('spec-version must be an integer, and a quoted string is not one', () => {
  const quoted = YAML.replace(/^spec-version: 1$/m, 'spec-version: "1"');
  assert.throws(() => parseThemePack(quoted, '/tmp/x'), /spec-version must be an integer/);
});

test('spec-version 1.0 is accepted — yaml parses it to the number 1', () => {
  // Deliberate (spec 1.1): yaml.parse yields the JS number 1 for both `1` and
  // `1.0`, so rejecting the lexical form would need parseDocument to enforce a
  // distinction with no semantic content. Do not "fix" this.
  const float = YAML.replace(/^spec-version: 1$/m, 'spec-version: 1.0');
  assert.equal(parseThemePack(float, '/tmp/x').specVersion, 1);
});

test('an unsupported spec-version names both versions', () => {
  const future = YAML.replace(/^spec-version: 1$/m, 'spec-version: 2');
  assert.throws(() => parseThemePack(future, '/tmp/x'), /spec-version 2 .*understands spec-version 1/);
});

test('the parsed pack exposes specVersion', () => {
  assert.equal(parseThemePack(YAML, '/tmp/x').specVersion, SPEC_VERSION);
});

// --- closed key sets: unknown keys point at the wrong line if ignored -------

test('unknown keys are rejected at all three levels', () => {
  const cases = [
    [YAML.replace('id: cats', 'id: cats\nauthor: someone'), /theme.yaml: unknown key "author"/],
    [YAML.replace('persona: The Enthusiast', 'presona: The Enthusiast'), /member "ginger-tabby": unknown key "presona"/],
    [YAML.replace('  idle: sprawled', '  idel: sprawled'), /member "ginger-tabby": poses: unknown key "idel"/],
  ];
  for (const [text, pattern] of cases) {
    assert.throws(() => parseThemePack(text, '/tmp/x'), pattern);
  }
});

test('optional top-level keys are still allowed', () => {
  const withOptional = YAML.replace('label: Cats', 'label: Cats\ndescription: Twelve cats\nrows: 6');
  const pack = parseThemePack(withOptional, '/tmp/x');
  assert.equal(pack.description, 'Twelve cats');
  assert.equal(pack.rows, 6);
});
