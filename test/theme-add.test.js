import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, symlinkSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/bus/paths.js';
import { addTheme, STAGING_DIR_NAME } from '../src/theme/add.js';
import { readReceipt, receiptPath, writeReceipt } from '../src/theme/receipt.js';
import { writePack } from './helpers/fixture.js';

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
  rmSync(join(src, 'theme.yaml'));
  await assert.rejects(addTheme({ paths: p, source: src }));
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
      /another theme add is running/
    );
  } finally {
    releaseFirst();
  }
  const result = await first;
  assert.equal(result.id, 'gate-fixture');
});
