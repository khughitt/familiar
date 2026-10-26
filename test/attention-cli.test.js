// The attention CLI leaves, run as real subprocesses against a test-owned state
// directory whose path is hostile on purpose: spaces, quotes and shell metacharacters
// must stay values. Every subprocess gets an environment built key by key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessOps } from 'relay';
import { reduceAttention } from '../src/attention/model.js';
import { mutateAttention, readAttention, writeHealth } from '../src/attention/store.js';
import { paths as familiarPaths } from '../src/bus/paths.js';
import { createRegistry, nativeEvent, snapshotOf } from './helpers/attention.js';

const BIN = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const SOCKET = '/run/user/1000/niri.wayland-1.sock';
const BOOT = createProcessOps().handleOf(process.pid).bootId;
// A healthy coordinator needs this boot's identity, which relay reads on Linux only: on
// Darwin a process handle carries a null boot ID, and health never matches an unknown
// identity. The scenarios that need a healthy coordinator are Linux scenarios.
const requiresLinuxBoot = process.platform !== 'linux' ? 'requires a Linux boot ID' : false;
const requiresDarwin = process.platform !== 'darwin' ? 'requires Darwin' : false;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'familiar-attention-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, `state dir 'quoted' "double" $(touch pwned) ; & |`);
  const home = join(root, 'home');
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH, HOME: home, USER: 'tester', FAMILIAR_STATE_DIR: state,
    FAMILIAR_CONFIG_DIR: join(root, 'config'), NIRI_SOCKET: SOCKET,
  };
  const paths = familiarPaths(env);
  const run = (args, input) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env, input });
  return { root, state, paths, run };
}

const step = (paths, input) => mutateAttention({ paths }, async (state) => reduceAttention(state, input));

// Two live approvals and a finished turn, classified by a healthy coordinator on a
// workspace the user is not looking at.
async function seed(paths, { health = true, crashesAgo = [] } = {}) {
  const registry = createRegistry({ now: () => 1000 });
  await step(paths, { type: 'observe', snapshot: snapshotOf([], { revision: 1 }), envelope: null, now: 1 });
  registry.apply(nativeEvent('codex', 'PermissionRequest', { session: 'a' }));
  registry.apply(nativeEvent('codex', 'PermissionRequest', { session: 'b' }));
  registry.apply(nativeEvent('codex', 'UserPromptSubmit', { session: 'c' }));
  registry.apply(nativeEvent('codex', 'Stop', { session: 'c' }));
  const { state } = await step(paths, { type: 'observe', snapshot: snapshotOf(registry.rows(), { revision: 2 }), envelope: null, now: 2 });
  const roots = Object.keys(state.sources);
  await step(paths, {
    type: 'desktop', instanceId: 'coordinator-1', status: 'known', dnd: 'off',
    workspaces: [
      { id: '1', idx: 1, output: 'DP-1', is_active: true, is_focused: true, is_urgent: false, occupied: true },
      { id: '7', idx: 2, name: 'code', output: 'DP-1', is_active: false, is_focused: false, is_urgent: false, occupied: true },
    ],
    origins: Object.fromEntries(roots.map((key) => [key, { workspaceId: '7', output: 'DP-1' }])),
    enrichment: {}, now: 3,
  });
  if (health) {
    const writtenAt = Date.now();
    await writeHealth({ paths, health: {
      schema: 2, instanceId: 'coordinator-1', epoch: { bootId: BOOT, desktopSession: SOCKET },
      owner: { pid: 77, start: '1' }, writtenAt, stopped: false, crashedAt: crashesAgo.map((ago) => writtenAt - ago),
    } });
  }
  const saved = await readAttention(paths);
  const byAgent = (agentId) => Object.values(saved.episodes).find((episode) => saved.sources[episode.sourceKey].agentId === agentId);
  return { saved, a: byAgent('codex:a'), b: byAgent('codex:b'), c: byAgent('codex:c') };
}

const json = (result) => {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
};

test('status prints the whole view in every output mode and changes nothing', { skip: requiresLinuxBoot }, async (t) => {
  const f = fixture(t);
  const { saved } = await seed(f.paths);
  const before = readFileSync(f.paths.attentionPath, 'utf8');
  const views = [[], ['--json'], ['--pretty'], ['--color', 'always']].map((flags) => json(f.run([...flags, 'attention', 'status'])));
  for (const view of views.slice(1)) assert.deepEqual(view, views[0]);
  assert.deepEqual({ ...views[0], health: undefined }, { ...saved, health: undefined });
  assert.equal(views[0].health.status, 'healthy');
  assert.equal(views[0].health.crashes, 0);
  assert.equal(readFileSync(f.paths.attentionPath, 'utf8'), before);
  assert.equal(existsSync(join(f.root, 'pwned')), false);
});

test('status on a first run prints the initial state with missing health and writes nothing', (t) => {
  const f = fixture(t);
  const view = json(f.run(['attention', 'status']));
  assert.equal(view.schema, 1);
  assert.deepEqual(view.episodes, {});
  assert.deepEqual(view.health, { status: 'missing', record: null, crashes: null });
  assert.equal(existsSync(f.state), false);
});

test('status reports the crashes in the window beside the health status', { skip: requiresLinuxBoot }, async (t) => {
  const f = fixture(t);
  await seed(f.paths, { crashesAgo: [120_000, 60_000] });
  const { health } = json(f.run(['attention', 'status']));
  assert.equal(health.status, 'healthy');
  assert.equal(health.crashes, 2);
});

test('dismiss acts on the captured IDs only and reports the rest missing', async (t) => {
  const f = fixture(t);
  const { a, b } = await seed(f.paths);
  const clickedEpisodeId = a.id;
  const hostile = ['$(touch pwned)', '__proto__', 'constructor', "it's; rm -rf ~"];
  const reply = json(f.run(['attention', 'dismiss', clickedEpisodeId, ...hostile]));
  assert.deepEqual(reply.dismissedIds, [clickedEpisodeId]);
  assert.deepEqual(reply.missingIds, hostile);
  const saved = await readAttention(f.paths);
  const nextRequest = saved.episodes[b.id];
  assert.equal(saved.episodes[clickedEpisodeId].dismissed, true);
  assert.equal(nextRequest.dismissed, false);
  assert.equal(existsSync(join(f.root, 'pwned')), false);
  assert.equal(f.run(['attention', 'dismiss']).status, 2);
});

const popup = (f, request) => f.run(['attention', 'popup'], typeof request === 'string' ? request : JSON.stringify(request));

test('a popup claim reserves one episode that a competing renderer cannot claim again', { skip: requiresLinuxBoot }, async (t) => {
  const f = fixture(t);
  const { a, b, c } = await seed(f.paths);
  const firstClaim = json(popup(f, { op: 'claim', consumerId: 'popup-1' }));
  assert.equal(firstClaim.token === null, false);
  assert.equal(firstClaim.job.episodeId, a.id);
  assert.equal(firstClaim.job.kind, 'needs-approval');
  assert.equal(firstClaim.job.pose, 'needs-approval');
  assert.equal(firstClaim.job.seen, false);
  assert.deepEqual(firstClaim.job.origin, { workspaceId: '7', label: 'code', output: 'DP-1' });
  json(popup(f, { op: 'claim', consumerId: 'popup-2' }));
  const third = json(popup(f, { op: 'claim', consumerId: 'popup-2' }));
  assert.equal(third.job.episodeId, c.id);
  assert.equal(third.job.kind, 'completion');
  assert.equal(third.job.pose, 'done');
  const secondClaim = json(popup(f, { op: 'claim', consumerId: 'popup-2' }));
  assert.equal(secondClaim.job, null); // a competing renderer cannot claim it again
  assert.equal(secondClaim.token, null);
  const saved = await readAttention(f.paths);
  assert.deepEqual([a, b, c].map((episode) => saved.episodes[episode.id].delivery.popup.status), ['reserved', 'reserved', 'reserved']);
});

test('finish records the outcome for its own token only', { skip: requiresLinuxBoot }, async (t) => {
  const f = fixture(t);
  const { a } = await seed(f.paths);
  const claim = json(popup(f, { op: 'claim', consumerId: 'popup-1' }));
  assert.deepEqual(json(popup(f, { op: 'finish', consumerId: 'popup-0', token: 'old-token', outcome: 'delivered' })), { finishedIds: [] });
  assert.equal((await readAttention(f.paths)).episodes[a.id].delivery.popup.status, 'reserved');
  assert.deepEqual(json(popup(f, { op: 'finish', consumerId: 'popup-1', token: claim.token, outcome: 'interrupted' })), { finishedIds: [a.id] });
  assert.equal((await readAttention(f.paths)).episodes[a.id].delivery.popup.status, 'interrupted');
});

// Unstable is a warning, not a gate: the popup keeps claiming between crashes.
test('a popup claim succeeds while the record carries two crashes', { skip: requiresLinuxBoot }, async (t) => {
  const f = fixture(t);
  const { a } = await seed(f.paths, { crashesAgo: [120_000, 60_000] });
  const claim = json(popup(f, { op: 'claim', consumerId: 'popup-1' }));
  assert.equal(claim.job.episodeId, a.id);
  assert.equal(typeof claim.token, 'string');
});

test('a claim finds nothing while the coordinator is not healthy', async (t) => {
  const f = fixture(t);
  await seed(f.paths, { health: false });
  assert.deepEqual(json(popup(f, { op: 'claim', consumerId: 'popup-1' })), { token: null, job: null });
});

test('without a readable boot ID a saved health record never reads healthy and claims nothing', { skip: requiresDarwin }, async (t) => {
  const f = fixture(t);
  assert.equal(BOOT, null);
  await seed(f.paths);
  const { health } = json(f.run(['attention', 'status']));
  assert.equal(health.status, 'mismatched');
  assert.equal(health.crashes, null);
  assert.deepEqual(json(popup(f, { op: 'claim', consumerId: 'popup-1' })), { token: null, job: null });
});

test('initialise suppresses the attached IDs while a concurrently arriving one survives', async (t) => {
  const f = fixture(t);
  const { a, b } = await seed(f.paths);
  const reply = json(popup(f, { op: 'initialise', consumerId: 'popup-1', ids: [a.id, 'e999', '__proto__'] }));
  assert.deepEqual(reply, { suppressedIds: [a.id] });
  const saved = await readAttention(f.paths);
  assert.equal(saved.episodes[a.id].delivery.popup.status, 'suppressed');
  assert.equal(saved.episodes[b.id].delivery.popup.status, 'eligible');
});

test('malformed popup requests fail by field without mutation or echoing what was sent', async (t) => {
  const f = fixture(t);
  await seed(f.paths);
  const before = readFileSync(f.paths.attentionPath, 'utf8');
  const secret = 'sk-live-SECRET-value';
  const cases = [
    [{ op: 'patch', consumerId: 'p' }, /attention.*unknown operation/],
    [{ op: 'claim', consumerId: 'p', [secret]: 1 }, /attention.*unknown field/],
    [{ op: 'claim', consumerId: secret.repeat(10) }, /attention.*consumerId.*128/],
    [{ op: 'claim' }, /attention.*consumerId/],
    [{ op: 'claim', consumerId: '' }, /attention.*consumerId/],
    [{ op: 'finish', consumerId: 'p', token: secret, outcome: 'pending' }, /attention.*outcome/],
    [{ op: 'finish', consumerId: 'p', outcome: 'delivered' }, /attention.*token/],
    [{ op: 'initialise', consumerId: 'p', ids: Array.from({ length: 513 }, (_, i) => `e${i}`) }, /attention.*ids.*512/],
    [{ op: 'initialise', consumerId: 'p', ids: [secret, 7] }, /attention.*ids/],
    [[{ op: 'claim', consumerId: 'p' }], /attention.*request/],
    [`${JSON.stringify({ op: 'claim', consumerId: 'p' })}\n${JSON.stringify({ op: 'claim', consumerId: 'p' })}`, /attention.*JSON/],
    [`{"op":"claim","consumerId":"${secret}"`, /attention.*JSON/],
    ['', /attention.*empty/],
    [JSON.stringify({ op: 'claim', consumerId: 'p', pad: 'x'.repeat(70_000) }), /attention.*65536/],
  ];
  for (const [request, pattern] of cases) {
    const result = popup(f, request);
    assert.equal(result.status, 1, JSON.stringify(request).slice(0, 80));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, pattern);
    assert.equal(result.stderr.includes('SECRET'), false, result.stderr);
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
  }
  assert.equal(readFileSync(f.paths.attentionPath, 'utf8'), before);
  assert.deepEqual(readdirSync(f.state).sort(), ['attention-health.json', 'attention.json']);
});
