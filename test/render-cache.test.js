import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RENDER_TTL_MS, pruneRenders, readRender, renderCachePath, renderKey, validUntil, writeRender,
} from '../src/render/term/render-cache.js';
import { ledgerPaths } from '../src/render/term/ledger.js';
import { paths as resolvePaths } from '../src/bus/paths.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'familiar-render-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = resolvePaths({ FAMILIAR_CONFIG_DIR: join(root, 'cfg'), FAMILIAR_STATE_DIR: join(root, 'state') });
  mkdirSync(p.configDir, { recursive: true });
  mkdirSync(p.stateDir, { recursive: true });
  const sessions = (records) => writeFileSync(p.sessionsPath, JSON.stringify({ schema: 1, sessions: records }));
  return { p, sessions };
}

const FIELDS = { project: 'familiar', branch: 'main', claim: null, model: 'Opus', usedPercent: 12 };

test('the key moves with every input it covers, and only with them', (t) => {
  const { p, sessions } = fixture(t);
  sessions({ s: { state: 'idle', updatedAt: 1 }, other: { state: 'idle', updatedAt: 1 } });
  const key = () => renderKey({ paths: p, sessionId: 's', fields: FIELDS });
  const base = key();
  assert.equal(key(), base, 'a key is a pure function of what it reads');

  sessions({ s: { state: 'idle', updatedAt: 1 }, other: { state: 'working', updatedAt: 2 } });
  assert.equal(key(), base, 'another session\'s record is not this line\'s input');

  assert.notEqual(renderKey({ paths: p, sessionId: 's', fields: { ...FIELDS, usedPercent: 13 } }), base);
  sessions({ s: { state: 'working', updatedAt: 2 } });
  const working = key();
  assert.notEqual(working, base, 'this session\'s record');

  let last = working;
  const ledger = ledgerPaths(p.transmitDir, 's').entryPath;
  mkdirSync(dirname(ledger), { recursive: true });
  for (const write of [
    () => writeFileSync(ledger, JSON.stringify({ seq: 1, held: { transport: 'direct' } })),
    () => writeFileSync(p.configPath, 'motion: off\n'),
    () => writeFileSync(p.schemePath, JSON.stringify({ mode: 'dark', satScale: 1 })),
    () => writeFileSync(p.identitiesPath, 'identities: []\n'),
  ]) {
    write();
    const next = key();
    assert.notEqual(next, last);
    last = next;
  }
});

test('the key moves with each installed theme\'s descriptor, in both roots, and not with its other files', (t) => {
  const { p, sessions } = fixture(t);
  const roots = { user: p.userThemesDir, shipped: join(p.configDir, 'shipped') };
  const q = { ...p, themesDir: roots.shipped };
  sessions({ s: { state: 'idle', updatedAt: 1 } });
  const key = () => renderKey({ paths: q, sessionId: 's', fields: FIELDS });
  for (const root of Object.values(roots)) mkdirSync(root, { recursive: true });
  const absent = key();
  for (const root of Object.values(roots)) {
    mkdirSync(join(root, 'forest', 'sprites'), { recursive: true });
    writeFileSync(join(root, 'stray.txt'), 'not a theme');
  }
  assert.equal(key(), absent, 'an entry with no theme.yaml stamps as absent');
  let last = absent;
  for (const root of Object.values(roots)) {
    writeFileSync(join(root, 'forest', 'theme.yaml'), 'id: forest\n');
    const added = key();
    assert.notEqual(added, last, `a descriptor written under ${root}`);
    writeFileSync(join(root, 'forest', 'theme.yaml'), 'id: forest\nrows: 3\n');
    const edited = key();
    assert.notEqual(edited, added, `a descriptor edited under ${root}`);
    writeFileSync(join(root, 'forest', 'sprites', 'idle.png'), 'png');
    assert.equal(key(), edited, 'a pack\'s other files are bounded by the TTL, not keyed');
    last = edited;
  }
  rmSync(join(roots.user, 'forest'), { recursive: true });
  assert.notEqual(key(), last, 'a removed theme');
});

test('an unparseable sessions file leaves the render unkeyed, for the renderer to report', (t) => {
  const { p } = fixture(t);
  writeFileSync(p.sessionsPath, '{not json');
  assert.equal(renderKey({ paths: p, sessionId: 's', fields: FIELDS }), null);
});

test('a provisional or unparseable ledger leaves the render unkeyed, so its settle is retried', (t) => {
  const { p, sessions } = fixture(t);
  sessions({ s: { state: 'idle', updatedAt: 1 } });
  const ledger = ledgerPaths(p.transmitDir, 's').entryPath;
  mkdirSync(dirname(ledger), { recursive: true });
  writeFileSync(ledger, JSON.stringify({ seq: 1, held: { provisional: true, transport: 'direct' } }));
  assert.equal(renderKey({ paths: p, sessionId: 's', fields: FIELDS }), null);
  writeFileSync(ledger, '{torn');
  assert.equal(renderKey({ paths: p, sessionId: 's', fields: FIELDS }), null);
});

test('an entry is served for its key inside its window, and missed outside it', async (t) => {
  const { p } = fixture(t);
  const path = renderCachePath(p.stateDir, 's');
  assert.equal(readRender(path, 'k', 1000), null, 'no entry');
  await writeRender(path, { key: 'k', output: 'line\n', renderedAt: 1000, until: 5000 });
  assert.equal(readRender(path, 'k', 1000), 'line\n');
  assert.equal(readRender(path, 'k', 4999), 'line\n');
  assert.equal(readRender(path, 'k', 5000), null, 'at its deadline');
  assert.equal(readRender(path, 'k', 999), null, 'a clock stepped back before the render');
  assert.equal(readRender(path, 'other', 2000), null, 'another key');
  writeFileSync(path, '{torn');
  assert.equal(readRender(path, 'k', 2000), null, 'an unreadable entry is a miss');
});

test('an entry lives until the TTL, or until the intent decays when that comes first', () => {
  assert.equal(validUntil(1000, null), 1000 + RENDER_TTL_MS);
  assert.equal(validUntil(1000, 9000), 9000);
  assert.equal(validUntil(1000, 1000 + RENDER_TTL_MS + 1), 1000 + RENDER_TTL_MS);
  assert.equal(validUntil(1000, 500), 1000 + RENDER_TTL_MS, 'an intent already decayed holds still');
});

test('reap\'s pruning keeps entries of sessions on the bus and removes the rest', async (t) => {
  const { p } = fixture(t);
  assert.deepEqual(await pruneRenders({ stateDir: p.stateDir, sessions: {} }), { removed: [] },
    'no cache directory yet');
  for (const sid of ['live', 'gone']) {
    await writeRender(renderCachePath(p.stateDir, sid), { key: 'k', output: '', renderedAt: 0, until: 1 });
  }
  const { removed } = await pruneRenders({ stateDir: p.stateDir, sessions: { live: {} } });
  assert.equal(removed.length, 1);
  assert.ok(existsSync(renderCachePath(p.stateDir, 'live')));
  assert.equal(existsSync(renderCachePath(p.stateDir, 'gone')), false);
  assert.equal(readdirSync(dirname(renderCachePath(p.stateDir, 'live'))).length, 1);
});
