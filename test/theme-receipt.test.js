import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/bus/paths.js';
import { receiptPath, writeReceipt, readReceipt } from '../src/theme/receipt.js';

const scratch = () => {
  const cfg = mkdtempSync(join(tmpdir(), 'receipt-'));
  return paths({ FAMILIAR_CONFIG_DIR: cfg, HOME: cfg });
};

const VALID = {
  id: 'gate-fixture',
  source: { kind: 'https', url: 'https://example.test/repo', commit: 'a'.repeat(40) },
  installedAt: '2026-08-18T00:00:00.000Z',
};

test('paths exposes themeReceiptsDir beside the themes dir', () => {
  const p = scratch();
  assert.equal(p.themeReceiptsDir, join(p.configDir, 'theme-receipts'));
});

test('a written receipt reads back validated', async () => {
  const p = scratch();
  await writeReceipt(p, VALID);
  assert.deepEqual(readReceipt(p, 'gate-fixture'), { verdict: 'validated', receipt: VALID });
});

test('a local-source receipt round-trips without a commit field', async () => {
  const p = scratch();
  const receipt = { ...VALID, source: { kind: 'local', path: '/somewhere/pack' } };
  await writeReceipt(p, receipt);
  assert.deepEqual(readReceipt(p, 'gate-fixture'), { verdict: 'validated', receipt });
});

test('a missing receipt is absent', () => {
  assert.deepEqual(readReceipt(scratch(), 'gate-fixture'), { verdict: 'absent' });
});

test('corrupt JSON is an invalid verdict, not a throw', () => {
  const p = scratch();
  mkdirSync(p.themeReceiptsDir, { recursive: true });
  writeFileSync(receiptPath(p, 'gate-fixture'), '{nope');
  const result = readReceipt(p, 'gate-fixture');
  assert.equal(result.verdict, 'invalid');
  assert.ok(result.reason.length > 0);
});

test('a wrong-shaped source is invalid', () => {
  const p = scratch();
  mkdirSync(p.themeReceiptsDir, { recursive: true });
  writeFileSync(receiptPath(p, 'gate-fixture'),
    JSON.stringify({ ...VALID, source: { kind: 'ftp' } }));
  assert.equal(readReceipt(p, 'gate-fixture').verdict, 'invalid');
});

test('an https source must contain a valid https URL', () => {
  const p = scratch();
  mkdirSync(p.themeReceiptsDir, { recursive: true });
  writeFileSync(receiptPath(p, 'gate-fixture'),
    JSON.stringify({ ...VALID, source: { ...VALID.source, url: 'https://' } }));
  assert.equal(readReceipt(p, 'gate-fixture').verdict, 'invalid');
});

test('an unparseable installedAt is invalid', () => {
  const p = scratch();
  mkdirSync(p.themeReceiptsDir, { recursive: true });
  writeFileSync(receiptPath(p, 'gate-fixture'),
    JSON.stringify({ ...VALID, installedAt: 'yesterday-ish' }));
  assert.equal(readReceipt(p, 'gate-fixture').verdict, 'invalid');
});

test('a parseable non-ISO or normalized installedAt is invalid', () => {
  const p = scratch();
  mkdirSync(p.themeReceiptsDir, { recursive: true });
  for (const installedAt of ['08/18/2026', '2026-02-30T00:00:00.000Z']) {
    writeFileSync(receiptPath(p, 'gate-fixture'),
      JSON.stringify({ ...VALID, installedAt }));
    assert.equal(readReceipt(p, 'gate-fixture').verdict, 'invalid');
  }
});

test('an embedded id that differs from the filename is invalid', () => {
  const p = scratch();
  mkdirSync(p.themeReceiptsDir, { recursive: true });
  writeFileSync(receiptPath(p, 'gate-fixture'),
    JSON.stringify({ ...VALID, id: 'other' }));
  const result = readReceipt(p, 'gate-fixture');
  assert.equal(result.verdict, 'invalid');
  assert.match(result.reason, /id/);
});
