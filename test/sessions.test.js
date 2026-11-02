import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_SESSIONS, readSessions, writeSessions, sameBasis, sessionIdOf } from '../src/bus/sessions.js';
import { HARNESSES } from '../src/bus/harnesses.js';

const processHandle = { platform: 'linux', host: 'host', bootId: 'boot', pid: 42, start: '123' };
const basis = { generation: 'generation', agentId: 'codex:a', process: processHandle, cwd: '/repo' };
const session = {
  sessionId: 'a', agentId: 'codex:a', harness: 'codex', basis,
  cwd: '/repo', projectKey: '/repo', project: 'repo', remote: null,
  repoRoot: '/repo', repositoryRoot: '/repo', projectColor: null,
  pid: 100, starttime: 200, seq: 1, state: 'working', updatedAt: 1000,
};
const ended = { sessionId: 'b', harness: 'codex', project: 'repo', pid: 101, starttime: 201, seq: 2 };
const valid = () => structuredClone({ schema: 1, registry: { generation: 'generation', revision: 1 }, sessions: { a: session }, ended: { b: ended } });

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'sessions.json');
}

test('absent sessions file returns a fresh empty sessions value', async (t) => {
  const path = await fixture(t);
  const a = await readSessions(path);
  assert.deepEqual(a, EMPTY_SESSIONS);
  a.sessions.changed = {};
  assert.deepEqual(await readSessions(path), EMPTY_SESSIONS);
});

test('corrupt sessions never empties intent: reading throws before projection', async (t) => {
  const path = await fixture(t);
  await writeFile(path, '{broken');
  await assert.rejects(readSessions(path), /invalid sessions file at .*: /);
});

test('sessions round trip with numeric terminal starttime', async (t) => {
  const path = await fixture(t);
  await writeSessions(path, valid());
  assert.deepEqual(await readSessions(path), valid());
});

test('every accepted harness round trips, agy included', async (t) => {
  const path = await fixture(t);
  assert.ok(HARNESSES.includes('agy'));
  for (const harness of HARNESSES) {
    const value = valid();
    const a = value.sessions.a;
    a.harness = harness; a.agentId = `${harness}:a`; a.basis.agentId = a.agentId;
    value.ended.b.harness = harness;
    await writeSessions(path, value);
    assert.deepEqual(await readSessions(path), value, harness);
  }
});

test('wrong schema and malformed sessions or ended records fail closed', async (t) => {
  const path = await fixture(t);
  const mutations = [
    (v) => { v.schema = 2; },
    (v) => { v.registry.revision = -1; },
    (v) => { v.sessions = []; },
    (v) => { v.ended = null; },
    (v) => { delete v.sessions.a.cwd; },
    (v) => { v.sessions.a.sessionId = 'other'; },
    (v) => { v.sessions.a.agentId = 'claude-code:a'; },
    (v) => { v.sessions.a.basis.agentId = 'codex:other'; },
    (v) => { v.sessions.a.basis.process.start = 123; },
    (v) => { v.sessions.a.basis.process.host = null; },
    (v) => { v.sessions.a.state = 'unknown'; },
    (v) => { v.sessions.a.starttime = '200'; },
    (v) => { v.sessions.a.remote = 3; },
    (v) => { v.ended.b.pid = 0; },
    (v) => { v.ended.b.harness = 'unknown'; },
    (v) => { delete v.ended.b.seq; },
  ];
  for (const mutate of mutations) {
    const value = valid();
    mutate(value);
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readSessions(path), /invalid sessions file/);
  }
  for (const value of [null, [], {}]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readSessions(path), /invalid sessions file/);
  }
});

// A record written before family, role and admission existed must still read: the file
// validator checks those fields' shape only when present (spec §3, §5.6), or the first
// hook after the upgrade would refuse the whole file and nothing would ever rewrite it.
test('family, role and admitted are optional, and checked as ids and a seq when present', async (t) => {
  const path = await fixture(t);
  const without = valid();
  for (const key of ['family', 'role', 'admitted']) assert.equal(Object.hasOwn(without.sessions.a, key), false);
  await writeSessions(path, without);
  assert.deepEqual(await readSessions(path), without);
  for (const fields of [
    { family: null, role: null, admitted: 0 },
    { family: 'guild', role: 'reviewer', admitted: 7 },
    { family: 'verifiably', role: 'lead-2' },
  ]) {
    const value = valid();
    Object.assign(value.sessions.a, fields);
    await writeSessions(path, value);
    assert.deepEqual(await readSessions(path), value, JSON.stringify(fields));
  }
  for (const fields of [
    { family: 'Guild' }, { family: '' }, { family: 'guild/x' }, { family: 3 },
    { role: 'Reviewer' }, { role: 'reviewer/lead' }, { role: '' },
    // `default` is reserved for an agent with no role: a record carries null instead.
    { role: 'default' },
    { admitted: -1 }, { admitted: 1.5 }, { admitted: '3' }, { admitted: null },
  ]) {
    const value = valid();
    Object.assign(value.sessions.a, fields);
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readSessions(path), /invalid sessions file at .*: malformed sessions entry a/, JSON.stringify(fields));
  }
});

test('a session record may carry a positive agents count', async (t) => {
  const path = await fixture(t);
  for (const agents of [1, 2, 40]) {
    const value = valid();
    value.sessions.a.agents = agents;
    await writeSessions(path, value);
    assert.deepEqual(await readSessions(path), value, String(agents));
  }
});

test('agents of 0, -1, 1.5 or \'2\' is malformed', async (t) => {
  const path = await fixture(t);
  for (const agents of [0, -1, 1.5, '2', null]) {
    const value = valid();
    value.sessions.a.agents = agents;
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readSessions(path), /invalid sessions file.*malformed sessions entry a/, JSON.stringify(agents));
  }
});

test('sameBasis requires equal generation, agent, cwd and every non-null process field', () => {
  assert.equal(sameBasis(basis, structuredClone(basis)), true);
  assert.equal(sameBasis({ ...basis, process: null }, basis), false);
  assert.equal(sameBasis(basis, { ...basis, process: null }), false);
  assert.equal(sameBasis({ ...basis, process: null }, { ...basis, process: null }), false);
  for (const key of ['generation', 'agentId', 'cwd']) {
    assert.equal(sameBasis(basis, { ...basis, [key]: 'different' }), false, key);
  }
  for (const [key, value] of Object.entries({ platform: 'darwin', host: 'other', bootId: null, pid: 43, start: '124' })) {
    assert.equal(sameBasis(basis, { ...basis, process: { ...processHandle, [key]: value } }), false, key);
  }
});

test('sessionIdOf splits only at the first colon', () => {
  assert.equal(sessionIdOf('opencode:opencode:42'), 'opencode:42');
});
