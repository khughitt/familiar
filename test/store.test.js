import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../src/bus/store.js';

const dir = () => mkdtempSync(join(tmpdir(), 'familiar-store-'));

test('round-trips through an atomic write', async () => {
  const path = join(dir(), 'nested', 'agents.json');
  await writeJsonAtomic(path, { a: 1 });
  assert.deepEqual(await readJson(path), { a: 1 });
});

test('leaves no temp files behind — renderers must never see a partial file', async () => {
  const d = dir();
  const path = join(d, 'agents.json');
  await writeJsonAtomic(path, { a: 1 });
  assert.deepEqual(readdirSync(d), ['agents.json']);
});

test('a missing file reads as null, which means "no agents", not "error"', async () => {
  assert.equal(await readJson(join(dir(), 'absent.json')), null);
});

test('a CORRUPT file throws — we do not silently discard every live agent', async () => {
  const path = join(dir(), 'agents.json');
  writeFileSync(path, '{ not json');
  await assert.rejects(readJson(path), /corrupt JSON/);
});
