import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, symlinkSync, rmSync,
  realpathSync, renameSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/bus/paths.js';
import {
  addTheme, removeTheme, lockPathFor, STAGING_DIR_NAME, BACKUP_DIR_NAME,
} from '../src/theme/add.js';
import { listThemes } from '../src/theme/catalog.js';
import { readReceipt, receiptPath, writeReceipt } from '../src/theme/receipt.js';
import { DESCRIPTOR, writePack } from './helpers/fixture.js';

const scratch = () => {
  const cfg = mkdtempSync(join(tmpdir(), 'add-'));
  return paths({ FAMILIAR_CONFIG_DIR: cfg, HOME: cfg });
};
const stagingEntries = (p) => {
  const dir = join(p.userThemesDir, STAGING_DIR_NAME);
  return existsSync(dir) ? readdirSync(dir) : [];
};

test('a local pack installs, receipted, staging clean', async () => {
  const p = scratch();
  const src = writePack();
  const result = await addTheme({ paths: p, source: src });
  assert.equal(result.id, 'gate-fixture');
  assert.equal(result.members, 1);
  assert.equal(result.dir, join(p.userThemesDir, 'gate-fixture'));
  assert.equal(existsSync(join(result.dir, 'theme.yaml')), true);
  const read = readReceipt(p, 'gate-fixture');
  assert.equal(read.verdict, 'validated');
  assert.equal(read.receipt.source.kind, 'local');
  assert.deepEqual(stagingEntries(p), []);
});

test('a .git in a local source never reaches the installed pack', async () => {
  const p = scratch();
  const src = writePack();
  mkdirSync(join(src, '.git'));
  writeFileSync(join(src, '.git', 'HEAD'), 'ref: refs/heads/main');
  const { dir } = await addTheme({ paths: p, source: src });
  assert.equal(existsSync(join(dir, '.git')), false);
});

test('an existing user theme id refuses, even an empty directory, leaving no staging residue', async () => {
  const p = scratch();
  mkdirSync(join(p.userThemesDir, 'gate-fixture'), { recursive: true });
  await assert.rejects(addTheme({ paths: p, source: writePack() }),
    /'gate-fixture' is already installed .* remove it first/);
  assert.deepEqual(stagingEntries(p), []);
});

test('an orphan receipt refuses by name; nothing installs', async () => {
  const p = scratch();
  await writeReceipt(p, {
    id: 'gate-fixture',
    source: { kind: 'local', path: '/old/copy' },
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  await assert.rejects(addTheme({ paths: p, source: writePack() }), /orphan receipt/);
  assert.equal(existsSync(join(p.userThemesDir, 'gate-fixture')), false);
  assert.deepEqual(stagingEntries(p), []);
});

test('a dangling orphan receipt refuses; nothing installs', async () => {
  const p = scratch();
  mkdirSync(p.themeReceiptsDir, { recursive: true });
  symlinkSync(join(p.configDir, 'missing-receipt-target'), receiptPath(p, 'gate-fixture'));
  await assert.rejects(addTheme({ paths: p, source: writePack() }), /orphan receipt/);
  assert.equal(existsSync(join(p.userThemesDir, 'gate-fixture')), false);
  assert.deepEqual(stagingEntries(p), []);
});

test('a failed receipt write leaves the pack installed and unreceipted — never falsely receipted', async () => {
  const p = scratch();
  await assert.rejects(addTheme({
    paths: p, source: writePack(),
    writeReceiptFn: async () => { throw new Error('disk full'); },
  }), /disk full/);
  assert.equal(existsSync(join(p.userThemesDir, 'gate-fixture', 'theme.yaml')), true);
  assert.equal(readReceipt(p, 'gate-fixture').verdict, 'absent');
});

test('a validation failure cleans its staging run', async () => {
  const p = scratch();
  const src = writePack();
  writeFileSync(join(src, 'sprites', 'solo', 'idle.png'), 'junk');
  await assert.rejects(addTheme({ paths: p, source: src }), /idle\.png/);
  assert.deepEqual(stagingEntries(p), []);
  assert.equal(existsSync(join(p.userThemesDir, 'gate-fixture')), false);
});

test('a symlinked .staging is a named refusal, never traversed', async () => {
  const p = scratch();
  mkdirSync(p.userThemesDir, { recursive: true });
  const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'));
  symlinkSync(elsewhere, join(p.userThemesDir, STAGING_DIR_NAME));
  await assert.rejects(addTheme({ paths: p, source: writePack() }), /not a directory/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('abandoned staging is cleared by the next add, under the lock', async () => {
  const p = scratch();
  const leftover = join(p.userThemesDir, STAGING_DIR_NAME, 'run-dead');
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, 'partial.png'), 'x');
  await addTheme({ paths: p, source: writePack() });
  assert.deepEqual(stagingEntries(p), []);
});

test('adding the themes directory itself is a named self-copy refusal', async () => {
  const p = scratch();
  mkdirSync(p.userThemesDir, { recursive: true });
  await assert.rejects(addTheme({ paths: p, source: p.userThemesDir }),
    /inside the source/);
});

test('a held lock makes the second add fail by name, not race', async () => {
  const p = scratch();
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = addTheme({
    paths: p, source: writePack(),
    validate: async (dir) => {
      await gate;
      const { validateThemePack } = await import('familiar-theme');
      return validateThemePack(dir);
    },
  });
  // Wait until the first holds the lock (its staging run exists).
  while (stagingEntries(p).length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    await assert.rejects(
      addTheme({
        paths: p,
        source: writePack(),
        lockOpts: { retries: 0, staleMs: -1 },
      }),
      /another theme add or remove is running/
    );
  } finally {
    releaseFirst();
  }
  const result = await first;
  assert.equal(result.id, 'gate-fixture');
});

test('locked callback rejections pass through unchanged', async () => {
  for (const primitive of [false, true]) {
    const p = scratch();
    const rejection = primitive
      ? 'non-error rejection'
      : new Error(`could not acquire lock: ${lockPathFor(p)}`);
    let caught;
    try {
      await addTheme({
        paths: p,
        source: writePack(),
        validate: async () => { throw rejection; },
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, rejection);
  }
});

test('a cluttered working checkout installs exactly its pack content', async (t) => {
  const p = scratch();
  const src = writePack();
  symlinkSync('../../elsewhere/.worktrees', join(src, '.worktrees'));
  mkdirSync(join(src, '.superpowers'));
  symlinkSync('/etc/hostname', join(src, '.superpowers', 'link'));
  writeFileSync(join(src, 'README.md'), 'readme');
  writeFileSync(join(src, 'LICENSE'), 'MIT');
  for (let i = 0; i < 600; i++) mkdirSync(join(src, 'node_modules', `m${i}`), { recursive: true });
  t.after(() => rmSync(src, { recursive: true, force: true }));
  const { dir } = await addTheme({ paths: p, source: src });
  assert.deepEqual(readdirSync(dir).sort(), ['LICENSE', 'sprites', 'theme.yaml']);
  assert.deepEqual(stagingEntries(p), []);
});

test('a source reached through a symlink installs from its real path', async (t) => {
  const p = scratch();
  const src = writePack();
  const linkDir = mkdtempSync(join(tmpdir(), 'link-'));
  const link = join(linkDir, 'checkout');
  symlinkSync(src, link);
  t.after(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(linkDir, { recursive: true, force: true });
  });
  const { dir, provenance } = await addTheme({ paths: p, source: link });
  assert.equal(existsSync(join(dir, 'theme.yaml')), true);
  assert.equal(provenance.path, realpathSync(src));
});

test('a source without theme.yaml is refused by name and leaves no staging', async () => {
  const p = scratch();
  const src = writePack();
  rmSync(join(src, 'theme.yaml'));
  await assert.rejects(addTheme({ paths: p, source: src }), /has no theme\.yaml/);
  assert.deepEqual(stagingEntries(p), []);
});

// ---- theme remove

const OTHER_DESCRIPTOR = DESCRIPTOR.replace('id: gate-fixture', 'id: other-fixture');
const OLD_RECEIPT = {
  id: 'gate-fixture',
  source: { kind: 'local', path: '/old/copy' },
  installedAt: '2026-01-01T00:00:00.000Z',
};
const INSTANT = '2026-11-02T12:00:00.000Z';
const fixedNow = () => new Date(INSTANT);

// The theme a replacement must never lose: a pack directory whose bytes say "old",
// and a receipt naming where it came from.
async function installOld(p, { pack = true, receipt = true } = {}) {
  if (pack) {
    mkdirSync(join(p.userThemesDir, 'gate-fixture'), { recursive: true });
    writeFileSync(join(p.userThemesDir, 'gate-fixture', 'theme.yaml'), 'old');
  }
  if (receipt) await writeReceipt(p, OLD_RECEIPT);
}
const oldPackIntact = (p) => readFileSync(join(p.userThemesDir, 'gate-fixture', 'theme.yaml'), 'utf8') === 'old';
const receiptSource = (p) => JSON.parse(readFileSync(receiptPath(p, 'gate-fixture'), 'utf8')).source;
const backupRoot = (p) => join(p.userThemesDir, BACKUP_DIR_NAME);
const backupEntries = (p) => (existsSync(backupRoot(p)) ? readdirSync(backupRoot(p)) : []);

test('remove takes an installed pack and its receipt', async () => {
  const p = scratch();
  await addTheme({ paths: p, source: writePack() });
  const result = await removeTheme({ paths: p, id: 'gate-fixture' });
  assert.deepEqual(result, { id: 'gate-fixture', removed: { pack: true, receipt: true } });
  assert.equal(existsSync(join(p.userThemesDir, 'gate-fixture')), false);
  assert.equal(existsSync(receiptPath(p, 'gate-fixture')), false);
});

test('remove takes a manual install that has no receipt', async () => {
  const p = scratch();
  await installOld(p, { receipt: false });
  const result = await removeTheme({ paths: p, id: 'gate-fixture' });
  assert.deepEqual(result.removed, { pack: true, receipt: false });
  assert.equal(existsSync(join(p.userThemesDir, 'gate-fixture')), false);
});

test('remove takes an orphan receipt that describes no pack', async () => {
  const p = scratch();
  await installOld(p, { pack: false });
  const result = await removeTheme({ paths: p, id: 'gate-fixture' });
  assert.deepEqual(result.removed, { pack: false, receipt: true });
  assert.equal(existsSync(receiptPath(p, 'gate-fixture')), false);
});

test('remove of a theme with neither pack nor receipt refuses by name', async () => {
  const p = scratch();
  await assert.rejects(removeTheme({ paths: p, id: 'gate-fixture' }),
    /^Error: theme 'gate-fixture' is not installed$/);
});

test('remove refuses a symlinked pack directory and leaves both ends alone', async () => {
  const p = scratch();
  const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'));
  writeFileSync(join(elsewhere, 'theme.yaml'), 'kept');
  mkdirSync(p.userThemesDir, { recursive: true });
  const link = join(p.userThemesDir, 'gate-fixture');
  symlinkSync(elsewhere, link);
  await assert.rejects(removeTheme({ paths: p, id: 'gate-fixture' }),
    new RegExp(`theme remove: ${link} is a symlink — refusing`));
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(join(elsewhere, 'theme.yaml'), 'utf8'), 'kept');
});

test('remove unlinks a symlinked receipt and never touches what it points at', async () => {
  const p = scratch();
  const target = join(mkdtempSync(join(tmpdir(), 'receipt-target-')), 'real.json');
  writeFileSync(target, 'not even json');
  mkdirSync(p.themeReceiptsDir, { recursive: true });
  symlinkSync(target, receiptPath(p, 'gate-fixture'));
  const result = await removeTheme({ paths: p, id: 'gate-fixture' });
  assert.deepEqual(result.removed, { pack: false, receipt: true });
  assert.equal(existsSync(receiptPath(p, 'gate-fixture')), false);
  assert.equal(readFileSync(target, 'utf8'), 'not even json');
});

test('removing a user pack that shadows a shipped one leaves the shipped copy, unshadowed', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'add-'));
  const p = paths({ FAMILIAR_CONFIG_DIR: cfg, HOME: cfg, FAMILIAR_THEMES_DIR: join(cfg, 'shipped') });
  mkdirSync(join(p.themesDir, 'gate-fixture'), { recursive: true });
  await installOld(p);
  assert.deepEqual(listThemes(p).map((row) => [row.source, row.shadowed]), [['user', true]]);
  await removeTheme({ paths: p, id: 'gate-fixture' });
  assert.equal(existsSync(join(p.themesDir, 'gate-fixture')), true);
  assert.deepEqual(listThemes(p), [
    { id: 'gate-fixture', dir: join(p.themesDir, 'gate-fixture'), source: 'shipped', shadowed: false },
  ]);
});

test('remove of a shipped-only theme says there is nothing to remove', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'add-'));
  const p = paths({ FAMILIAR_CONFIG_DIR: cfg, HOME: cfg, FAMILIAR_THEMES_DIR: join(cfg, 'shipped') });
  mkdirSync(join(p.themesDir, 'gate-fixture'), { recursive: true });
  await assert.rejects(removeTheme({ paths: p, id: 'gate-fixture' }),
    /^Error: theme 'gate-fixture' is shipped, not installed — nothing to remove$/);
  assert.equal(existsSync(join(p.themesDir, 'gate-fixture')), true);
});

test('remove refuses an id that is not a theme id before touching anything', async () => {
  const p = scratch();
  await assert.rejects(removeTheme({ paths: p, id: '../x' }), /is invalid/);
  assert.equal(existsSync(p.userThemesDir), false);
});

test('remove waits for no one: a held install lock fails it by name', async () => {
  const p = scratch();
  await installOld(p);
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = addTheme({
    paths: p, source: writePack({ descriptor: OTHER_DESCRIPTOR }),
    validate: async (dir) => {
      await gate;
      const { validateThemePack } = await import('familiar-theme');
      return validateThemePack(dir);
    },
  });
  while (stagingEntries(p).length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    await assert.rejects(
      removeTheme({ paths: p, id: 'gate-fixture', lockOpts: { retries: 0 } }),
      /^Error: theme remove: another theme add or remove is running$/,
    );
  } finally {
    releaseFirst();
  }
  await first;
  assert.equal(oldPackIntact(p), true);
});

// ---- theme add --replace

test('replace over an installed pack keeps the new one with a fresh receipt, and no backup', async () => {
  const p = scratch();
  await installOld(p);
  const src = writePack();
  const result = await addTheme({ paths: p, source: src, replace: true, now: fixedNow });
  assert.equal(result.id, 'gate-fixture');
  assert.equal(readFileSync(join(result.dir, 'theme.yaml'), 'utf8'), DESCRIPTOR);
  const read = readReceipt(p, 'gate-fixture');
  assert.equal(read.verdict, 'validated');
  assert.equal(read.receipt.source.path, realpathSync(src));
  assert.equal(read.receipt.installedAt, INSTANT);
  assert.deepEqual(backupEntries(p), []);
  assert.deepEqual(stagingEntries(p), []);
});

test('replace over an orphan receipt installs and receipts the new pack', async () => {
  const p = scratch();
  await installOld(p, { pack: false });
  const src = writePack();
  await addTheme({ paths: p, source: src, replace: true });
  assert.equal(readFileSync(join(p.userThemesDir, 'gate-fixture', 'theme.yaml'), 'utf8'), DESCRIPTOR);
  assert.equal(receiptSource(p).path, realpathSync(src));
  assert.deepEqual(backupEntries(p), []);
});

test('replace with nothing installed is a plain install', async () => {
  const p = scratch();
  const { dir } = await addTheme({ paths: p, source: writePack(), replace: true });
  assert.equal(existsSync(join(dir, 'theme.yaml')), true);
  assert.equal(readReceipt(p, 'gate-fixture').verdict, 'validated');
  assert.deepEqual(backupEntries(p), []);
});

test('replace leaves an invalid source refused and the installed theme untouched', async () => {
  const p = scratch();
  await installOld(p);
  const src = writePack();
  writeFileSync(join(src, 'sprites', 'solo', 'idle.png'), 'junk');
  await assert.rejects(addTheme({ paths: p, source: src, replace: true }), /idle\.png/);
  assert.equal(oldPackIntact(p), true);
  assert.deepEqual(receiptSource(p), OLD_RECEIPT.source);
  assert.deepEqual(backupEntries(p), []);
});

// Review Focus 4: the old pack has been moved aside when the new one's rename fails.
test('replace whose promotion rename throws puts the old pack and receipt back, naming the cause', async () => {
  const p = scratch();
  await installOld(p);
  const target = join(p.userThemesDir, 'gate-fixture');
  const rename = (from, to) => {
    if (to === target && from.includes(STAGING_DIR_NAME)) {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    }
    renameSync(from, to);
  };
  await assert.rejects(
    addTheme({ paths: p, source: writePack(), replace: true, rename }),
    (error) => /EXDEV: cross-device link not permitted/.test(error.message)
      && /theme 'gate-fixture' is restored/.test(error.message)
      && error.cause?.code === 'EXDEV',
  );
  assert.equal(oldPackIntact(p), true);
  assert.deepEqual(receiptSource(p), OLD_RECEIPT.source);
  assert.deepEqual(backupEntries(p), []);
  assert.deepEqual(stagingEntries(p), []);
});

test('replace whose receipt write throws removes the new pack and restores the old pack and receipt', async () => {
  const p = scratch();
  await installOld(p);
  await assert.rejects(
    addTheme({
      paths: p, source: writePack(), replace: true,
      writeReceiptFn: async () => { throw new Error('disk full'); },
    }),
    (error) => /disk full/.test(error.message) && error.cause?.message === 'disk full',
  );
  assert.equal(oldPackIntact(p), true);
  assert.deepEqual(receiptSource(p), OLD_RECEIPT.source);
  assert.deepEqual(backupEntries(p), []);
  assert.deepEqual(stagingEntries(p), []);
});

test('a backup whose receipt move throws puts the pack back and rethrows', async () => {
  const p = scratch();
  await installOld(p);
  const receiptFile = receiptPath(p, 'gate-fixture');
  const refusal = new Error('EACCES: receipt is read-only');
  const rename = (from, to) => {
    if (from === receiptFile) throw refusal;
    renameSync(from, to);
  };
  await assert.rejects(addTheme({ paths: p, source: writePack(), replace: true, rename }),
    (error) => error === refusal);
  assert.equal(oldPackIntact(p), true);
  assert.deepEqual(receiptSource(p), OLD_RECEIPT.source);
  assert.deepEqual(backupEntries(p), []);
  assert.deepEqual(stagingEntries(p), []);
});

test('a restoration that fails keeps the backup, names it and the cause, and a later add leaves it alone', async () => {
  const p = scratch();
  await installOld(p);
  const backup = join(backupRoot(p), `gate-fixture-${INSTANT}`);
  const rename = (from, to) => {
    if (from.startsWith(backup)) throw new Error('EIO: i/o error');
    renameSync(from, to);
  };
  await assert.rejects(
    addTheme({
      paths: p, source: writePack(), replace: true, rename, now: fixedNow,
      writeReceiptFn: async () => { throw new Error('disk full'); },
    }),
    (error) => error.message.includes(backup) && /disk full/.test(error.message)
      && /EIO: i\/o error/.test(error.message) && error.cause?.message === 'disk full'
      && /move its pack to .* and its receipt\.json to /.test(error.message),
  );
  // The promoted pack went first, so the target is free for a person's restore.
  assert.equal(existsSync(join(p.userThemesDir, 'gate-fixture')), false);
  assert.equal(existsSync(receiptPath(p, 'gate-fixture')), false);
  assert.deepEqual(readdirSync(backup).sort(), ['pack', 'receipt.json']);
  assert.equal(readFileSync(join(backup, 'pack', 'theme.yaml'), 'utf8'), 'old');
  const receiptBytes = readFileSync(join(backup, 'receipt.json'), 'utf8');
  assert.deepEqual(JSON.parse(receiptBytes), OLD_RECEIPT);
  assert.deepEqual(stagingEntries(p), []);

  // A later add sweeps staging and completes; the backup is outside staging's reach.
  mkdirSync(join(p.userThemesDir, STAGING_DIR_NAME, 'run-dead'), { recursive: true });
  const later = await addTheme({ paths: p, source: writePack({ descriptor: OTHER_DESCRIPTOR }) });
  assert.equal(later.id, 'other-fixture');
  assert.deepEqual(stagingEntries(p), []);
  assert.deepEqual(readdirSync(backup).sort(), ['pack', 'receipt.json']);
  assert.equal(readFileSync(join(backup, 'pack', 'theme.yaml'), 'utf8'), 'old');
  assert.equal(readFileSync(join(backup, 'receipt.json'), 'utf8'), receiptBytes);

  // listThemes reserves the backup root: it is no theme id, and no error.
  assert.deepEqual(listThemes(p).map((row) => row.id), ['other-fixture']);
});

test('replace refuses a .replace-backup that is not a directory, before moving anything', async () => {
  const p = scratch();
  await installOld(p);
  writeFileSync(backupRoot(p), 'blocked');
  await assert.rejects(addTheme({ paths: p, source: writePack(), replace: true }),
    new RegExp(`theme add: ${backupRoot(p)} is not a directory — remove it`));
  assert.equal(oldPackIntact(p), true);
  assert.deepEqual(receiptSource(p), OLD_RECEIPT.source);
});

test('without --replace an installed theme still refuses, and nothing is backed up', async () => {
  const p = scratch();
  await installOld(p);
  await assert.rejects(addTheme({ paths: p, source: writePack() }), /already installed .* remove it first/);
  assert.equal(oldPackIntact(p), true);
  assert.deepEqual(backupEntries(p), []);
});

test('a restoration that puts the pack back but not the receipt names only the receipt left to move', async () => {
  const p = scratch();
  await installOld(p);
  const backup = join(backupRoot(p), `gate-fixture-${INSTANT}`);
  const rename = (from, to) => {
    if (from === join(backup, 'receipt.json')) throw new Error('EIO: i/o error');
    renameSync(from, to);
  };
  await assert.rejects(
    addTheme({
      paths: p, source: writePack(), replace: true, rename, now: fixedNow,
      writeReceiptFn: async () => { throw new Error('disk full'); },
    }),
    (error) => error.message.includes(`move its receipt.json to ${receiptPath(p, 'gate-fixture')}, or remove it`)
      && !/its pack to/.test(error.message),
  );
  assert.equal(oldPackIntact(p), true);
  assert.deepEqual(readdirSync(backup), ['receipt.json']);
});

test('a replace whose backup cannot be deleted says the new theme is installed and names the backup', async () => {
  const p = scratch();
  await installOld(p);
  const src = writePack();
  const backup = join(backupRoot(p), `gate-fixture-${INSTANT}`);
  const rm = (path, options) => {
    if (path === backup) throw new Error('EACCES: permission denied');
    rmSync(path, options);
  };
  await assert.rejects(
    addTheme({ paths: p, source: src, replace: true, now: fixedNow, rm }),
    (error) => error.message === `theme 'gate-fixture' installed; could not remove the replacement backup at ${backup}: EACCES: permission denied`
      && error.cause?.message === 'EACCES: permission denied',
  );
  assert.equal(readFileSync(join(p.userThemesDir, 'gate-fixture', 'theme.yaml'), 'utf8'), DESCRIPTOR);
  assert.equal(receiptSource(p).path, realpathSync(src));
  assert.deepEqual(readdirSync(backup).sort(), ['pack', 'receipt.json']);
});

test('a restoration whose only failure is the backup directory says the theme is restored and names the directory', async () => {
  const p = scratch();
  await installOld(p);
  const backup = join(backupRoot(p), `gate-fixture-${INSTANT}`);
  await assert.rejects(
    addTheme({
      paths: p, source: writePack(), replace: true, now: fixedNow,
      // A stray file in the backup leaves it non-empty after every move back succeeds.
      writeReceiptFn: async () => {
        writeFileSync(join(backup, 'stray'), 'x');
        throw new Error('disk full');
      },
    }),
    (error) => error.message.startsWith(`theme add: disk full — theme 'gate-fixture' is restored as it was, but its backup directory ${backup} could not be removed (`)
      && error.message.endsWith('); remove it')
      && !/restoring it failed/.test(error.message)
      && error.cause?.message === 'disk full',
  );
  assert.equal(oldPackIntact(p), true);
  assert.deepEqual(receiptSource(p), OLD_RECEIPT.source);
  assert.deepEqual(readdirSync(backup), ['stray']);
});
