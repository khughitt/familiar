import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepTemps } from '../src/bus/temp-sweep.js';

const UUID = '0b6f6c1e-8a3e-4d2a-9a51-3c1f0e2b7d44';
const NOW = Date.parse('2026-10-07T12:00:00Z');

const setup = () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'sweep-'));
  const transmitDir = join(stateDir, 'transmit');
  mkdirSync(transmitDir);
  const put = (dir, name, ageMs = 0) => {
    const path = join(dir, name);
    writeFileSync(path, '');
    const t = (NOW - ageMs) / 1000;
    utimesSync(path, t, t);
    return path;
  };
  return { stateDir, transmitDir, put };
};

test('a temp whose writer is dead is removed; a fresh one from a live writer is kept', async () => {
  const { stateDir, put } = setup();
  const dead = put(stateDir, `agents.lock.tmp.111.${UUID}`);
  const live = put(stateDir, `agents.json.tmp.222.${UUID}`);
  const result = await sweepTemps({
    dirs: [stateDir], pidExists: (pid) => pid === 222, now: () => NOW,
  });
  assert.deepEqual(result.removed, [dead]);
  assert.ok(!existsSync(dead) && existsSync(live));
});

test('a temp older than the bound is removed even when its pid is alive (recycled)', async () => {
  const { stateDir, put } = setup();
  const old = put(stateDir, `intent.json.tmp.222.${UUID}`, 10 * 60_000);
  const result = await sweepTemps({ dirs: [stateDir], pidExists: () => true, now: () => NOW });
  assert.deepEqual(result.removed, [old]);
});

test('every listed dir is swept, and files outside the temp pattern are never touched', async () => {
  const { stateDir, transmitDir, put } = setup();
  const keep = [
    put(stateDir, 'agents.json', 10 * 60_000),
    put(stateDir, 'agents.lock', 10 * 60_000),
    put(stateDir, 'notes.tmp.txt', 10 * 60_000),
    put(stateDir, 'agents.json.tmp.abc.def', 10 * 60_000),
  ];
  const gone = put(transmitDir, `x.lock.tmp.333.${UUID}`);
  const result = await sweepTemps({
    dirs: [stateDir, transmitDir], pidExists: () => false, now: () => NOW,
  });
  assert.deepEqual(result.removed, [gone]);
  for (const path of keep) assert.ok(existsSync(path), path);
});

test('a missing dir is not an error, and a temp that vanishes mid-sweep is not either', async () => {
  const { stateDir, put } = setup();
  put(stateDir, `agents.lock.tmp.111.${UUID}`);
  const result = await sweepTemps({
    dirs: [join(stateDir, 'absent'), stateDir], pidExists: () => false, now: () => NOW,
    unlink: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); },
  });
  assert.deepEqual(result.removed, []);
});
