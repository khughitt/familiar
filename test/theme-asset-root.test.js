import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadThemePack,
  loadThemePackSync,
  memberAssetDir,
  parseThemePack,
} from 'familiar-theme';

const scratch = new Set();
after(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

const POSES = `
      idle: idle
      working: working
      needs-input: needs input
      needs-approval: needs approval
      error: error
      done: done`;

// The twelve slots a lone member has to hold to make a whole theme. Coverage is
// checked at parse time, so a fixture declaring one member declares all twelve.
const EVERY_SLOT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

// slots, not slot: the caller passes the list this member holds, because only
// the caller knows how many members its descriptor declares.
function member(id, slots, assetRoot = `sprites/${id}`) {
  return `  - id: ${id}
    asset-root: ${assetRoot}
    label: ${id}
    slots: [${slots.join(', ')}]
    persona: A sufficiently detailed test persona.
    animation: { kind: static }
    poses:${POSES}
`;
}

function descriptor(members = member('valid-cat', EVERY_SLOT)) {
  return `spec-version: 1
id: cats
label: Cats
rows: 4
members:
${members}`;
}

test('asset-root is required and names the member', () => {
  const yaml = descriptor(member('valid-cat', EVERY_SLOT).replace('    asset-root: sprites/valid-cat\n', ''));
  assert.throws(
    () => parseThemePack(yaml, '/themes/cats'),
    /member "valid-cat".*asset-root.*missing/i,
  );
});

for (const [label, value] of [
  ['absolute', '/sprites/valid-cat'],
  ['Windows absolute', 'C:/sprites/valid-cat'],
  ['empty', '""'],
  ['dot', '.'],
  ['dot segment', 'prior/./sprites/valid-cat'],
  ['parent segment', 'prior/../sprites/valid-cat'],
  ['backslash', '"sprites\\\\valid-cat"'],
  ['repeated separator', 'prior//sprites/valid-cat'],
  ['member mismatch', 'sprites/other-cat'],
]) {
  test(`asset-root rejects ${label} paths`, () => {
    assert.throws(
      () => parseThemePack(descriptor(member('valid-cat', EVERY_SLOT, value)), '/themes/cats'),
      /member "valid-cat".*asset-root/i,
    );
  });
}

test('pure parsing stores normalized lexical asset fields without touching the filesystem', () => {
  const themeDir = '/a/theme/that/does/not/exist';
  const parsed = parseThemePack(
    descriptor(member('valid-cat', EVERY_SLOT, 'prior/static-v1/sprites/valid-cat')),
    themeDir,
  );
  const found = parsed.members.get('valid-cat');
  assert.equal(found.assetRoot, 'prior/static-v1/sprites/valid-cat');
  assert.equal(found.assetDir, resolve(themeDir, 'prior/static-v1/sprites/valid-cat'));
});

test('memberAssetDir refuses a parse-only lexical directory as unproven', () => {
  const pack = parseThemePack(
    descriptor(member('valid-cat', EVERY_SLOT, 'prior/static-v1/sprites/valid-cat')),
    '/themes/cats',
  );
  const found = pack.members.get('valid-cat');
  assert.equal(found.assetDir, '/themes/cats/prior/static-v1/sprites/valid-cat');
  assert.equal(found.assetDirProof, 'lexical');
  assert.throws(
    () => memberAssetDir(pack, 'valid-cat'),
    /theme "cats": member "valid-cat": asset-root .* has not been filesystem-proven/,
  );
});

function loaderFixture() {
  const root = mkdtempSync(join(tmpdir(), 'familiar-theme-root-'));
  scratch.add(root);
  const themeDir = join(root, 'theme');
  const outside = join(root, 'outside');
  mkdirSync(join(themeDir, 'sprites', 'valid-cat'), { recursive: true });
  mkdirSync(join(themeDir, 'sprites'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(themeDir, 'sprites', 'escape-cat'));
  writeFileSync(join(themeDir, 'sprites', 'not-a-directory'), 'not a directory');
  const yaml = descriptor([
    member('valid-cat', [0]),
    member('escape-cat', [1]),
    member('missing-cat', [2]),
    member('not-a-directory', [3, 4, 5, 6, 7, 8, 9, 10, 11]),
  ].join(''));
  writeFileSync(join(themeDir, 'theme.yaml'), yaml);
  return { root, themeDir, outside, yaml };
}

function memberSummary(pack) {
  return Object.fromEntries([...pack.members].map(([id, found]) => [id, {
    assetRoot: found.assetRoot,
    assetDir: found.assetDir,
    fault: found.assetRootFault?.message,
  }]));
}

test('member root proof is isolated and stores missing, non-directory, and escaping faults', async () => {
  const { themeDir } = loaderFixture();
  const pack = await loadThemePack(themeDir);

  assert.equal(memberAssetDir(pack, 'valid-cat'), resolve(themeDir, 'sprites/valid-cat'));
  for (const [id, pattern] of [
    ['escape-cat', /escapes.*theme|outside.*theme/i],
    ['missing-cat', /missing-cat.*does not exist|missing/i],
    ['not-a-directory', /not-a-directory.*directory/i],
  ]) {
    const found = pack.members.get(id);
    assert.ok(found.assetRootFault instanceof Error, `${id}: no stored root fault`);
    assert.equal(Object.hasOwn(found, 'assetDir'), false, `${id}: unproven assetDir survived`);
    assert.match(found.assetRootFault.message, pattern);
    assert.throws(() => memberAssetDir(pack, id), (error) => error === found.assetRootFault);
  }
  assert.throws(() => memberAssetDir(pack, 'unknown-cat'), /no member "unknown-cat"/);
});

test('async and sync loaders produce the same parsed members, proven roots, and faults', async () => {
  const { themeDir } = loaderFixture();
  const asyncPack = await loadThemePack(themeDir);
  const syncPack = loadThemePackSync(themeDir);
  assert.deepEqual(memberSummary(asyncPack), memberSummary(syncPack));
  assert.deepEqual([...asyncPack.bySlot], [...syncPack.bySlot]);
  assert.equal(asyncPack.members.get('valid-cat').assetDirProof, 'filesystem');
  assert.equal(syncPack.members.get('valid-cat').assetDirProof, 'filesystem');
});

test('descriptorPath accepts a regular sibling of the real theme directory', async () => {
  const { themeDir, yaml } = loaderFixture();
  const alternate = join(themeDir, 'alternate.yaml');
  writeFileSync(alternate, yaml);
  const asyncPack = await loadThemePack(themeDir, { descriptorPath: alternate });
  const syncPack = loadThemePackSync(themeDir, { descriptorPath: alternate });
  assert.equal(memberAssetDir(asyncPack, 'valid-cat'), resolve(themeDir, 'sprites/valid-cat'));
  assert.equal(memberAssetDir(syncPack, 'valid-cat'), resolve(themeDir, 'sprites/valid-cat'));
});

test('a sibling descriptor resolves an immutable release root from the theme directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-theme-release-root-'));
  scratch.add(root);
  const themeDir = join(root, 'theme');
  const digest = 'a'.repeat(64);
  const assetRoot = `releases/${digest}/sprites/valid-cat`;
  mkdirSync(join(themeDir, assetRoot), { recursive: true });
  const temporary = join(themeDir, '.theme.yaml.promote-test');
  writeFileSync(temporary, descriptor(member('valid-cat', EVERY_SLOT, assetRoot)));

  const asyncPack = await loadThemePack(themeDir, { descriptorPath: temporary });
  const syncPack = loadThemePackSync(themeDir, { descriptorPath: temporary });
  const expected = resolve(themeDir, assetRoot);
  assert.equal(memberAssetDir(asyncPack, 'valid-cat'), expected);
  assert.equal(memberAssetDir(syncPack, 'valid-cat'), expected);
});

test('descriptorPath refuses symlinks and regular files outside the real theme directory', async () => {
  const { root, themeDir, yaml } = loaderFixture();
  const link = join(themeDir, 'linked.yaml');
  symlinkSync(join(themeDir, 'theme.yaml'), link);
  const outside = join(root, 'outside.yaml');
  writeFileSync(outside, yaml);

  await assert.rejects(
    () => loadThemePack(themeDir, { descriptorPath: link }),
    /descriptor.*regular.*non-symlink|symlink/i,
  );
  assert.throws(
    () => loadThemePackSync(themeDir, { descriptorPath: link }),
    /descriptor.*regular.*non-symlink|symlink/i,
  );
  await assert.rejects(
    () => loadThemePack(themeDir, { descriptorPath: outside }),
    /descriptor.*sibling|outside.*theme/i,
  );
  assert.throws(
    () => loadThemePackSync(themeDir, { descriptorPath: outside }),
    /descriptor.*sibling|outside.*theme/i,
  );
});

test('lexical containment never substitutes for realpath containment', async () => {
  const { themeDir, outside } = loaderFixture();
  const pack = await loadThemePack(themeDir);
  assert.equal(
    pack.members.get('escape-cat').assetDir,
    undefined,
    `escaping symlink was accepted because its lexical path was under ${themeDir}`,
  );
  assert.match(pack.members.get('escape-cat').assetRootFault.message, new RegExp(outside));
});
