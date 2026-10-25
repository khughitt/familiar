import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { STATES as PROTOCOL_STATES } from 'familiar-theme';
import { healthStatus as nodeHealthStatus } from '../../src/attention/store.js';
import { createRegistry, nativeEvent, traceAttention } from '../../test/helpers/attention.js';

function loadLogic() {
  const path = fileURLToPath(new URL('./logic.js', import.meta.url));
  const source = readFileSync(path, 'utf8').replace(/^\s*\.pragma\s+library\s*$/m, '');
  const context = {};
  vm.runInNewContext(source, context);
  return context;
}

const L = loadLogic();
const plain = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const view = (state, status = 'healthy') => plain({ ...state, health: { status } });

// Attention states come from the production reducer, through a real trace.
function scene() {
  const t = traceAttention();
  const r = createRegistry({ now: () => t.now });
  t.observe([]);
  const send = (harness, native, ids = {}) => {
    const event = nativeEvent(harness, native, ids);
    r.apply(event);
    t.observe(r.rows(), event);
  };
  return { t, r, send };
}
const episodeOf = (t, agentId) => t.episodesOf(agentId)[0];
const job = (episode, { seen = false, motionPolicy = 'full', sprite = '/art/x.png', token = 'tok' } = {}) => ({
  episodeId: episode.id, kind: episode.kind, pose: episode.kind === 'completion' ? 'done' : episode.kind, seen, token,
  presentation: { sprite, motionPolicy },
});

test('the QML state vocabulary matches the portable protocol', () => {
  assert.deepEqual(Object.keys(L.STATES).sort(), [...PROTOCOL_STATES].sort());
});

test('parseAttention accepts the reducer state and rejects malformed or unknown schemas', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 'a' });
  const text = JSON.stringify(t.state);
  assert.deepEqual(plain(L.parseAttention(text)), { snapshot: plain(t.state), error: null });
  assert.equal(L.parseAttention('').error, 'attention.json: empty');
  assert.equal(L.parseAttention('{broken').error, 'attention.json: invalid json');
  assert.match(L.parseAttention(JSON.stringify({ ...t.state, schema: 2 })).error, /schema/);
  const bad = plain(t.state);
  bad.episodes[Object.keys(bad.episodes)[0]].kind = 'mystery';
  assert.match(L.parseAttention(JSON.stringify(bad)).error, /kind/);
  const badDelivery = plain(t.state);
  badDelivery.episodes[Object.keys(badDelivery.episodes)[0]].delivery.popup.status = 'maybe';
  assert.match(L.parseAttention(JSON.stringify(badDelivery)).error, /delivery/);
});

test('healthStatus is the same rule as the Node store', () => {
  const live = { now: 55_000, instanceId: 'c1', bootId: 'b1', desktopSession: '/s' };
  const health = { schema: 2, instanceId: 'c1', epoch: { bootId: 'b1', desktopSession: '/s' }, owner: { pid: 7, start: '1' }, writtenAt: 50_000, stopped: false, crashedAt: [] };
  const cases = [
    [health, live], [null, live], [health, { ...live, now: 60_001 }], [{ ...health, writtenAt: 55_001 }, live],
    [health, { ...live, instanceId: 'c2' }], [health, { ...live, bootId: null }],
    [health, { ...live, desktopSession: '' }], [{ ...health, extra: 1 }, live],
    [{ ...health, schema: 1 }, live], [{ ...health, schema: 3 }, live], [{ ...health, stopped: 'no' }, live],
    [{ ...health, stopped: true }, live], [{ ...health, crashedAt: [10, 50_000] }, live], [{ ...health, crashedAt: [5, 4] }, live],
    [{ ...health, crashedAt: [50_001] }, live], [{ ...health, crashedAt: [1.5] }, live], [{ ...health, crashedAt: [-1] }, live],
    [{ ...health, crashedAt: Array.from({ length: 9 }, () => 1) }, live], [{ ...health, crashedAt: Array.from({ length: 8 }, () => 1) }, live],
    [{ ...health, writtenAt: 700_000, crashedAt: [99_999] }, { ...live, now: 700_000 }],
    [{ ...health, writtenAt: 700_000, crashedAt: [100_000, 700_000] }, { ...live, now: 700_000 }],
  ];
  for (const [record, options] of cases) assert.equal(L.healthStatus(record, options), nodeHealthStatus(record, options), JSON.stringify([record, options]));
});

test('viewOf reads health against the live boot and session, never the saved ones alone', () => {
  const { t } = scene();
  t.desktop({ focused: '1' });
  const health = { schema: 2, instanceId: 'coordinator-1', epoch: { bootId: 'b1', desktopSession: '/s' }, owner: { pid: 7, start: '1' }, writtenAt: 100, stopped: false, crashedAt: [] };
  assert.equal(L.viewOf(t.state, JSON.stringify(health), { now: 200, bootId: 'b1', desktopSession: '/s' }).health.status, 'healthy');
  assert.equal(L.viewOf(t.state, JSON.stringify(health), { now: 200, bootId: 'b2', desktopSession: '/s' }).health.status, 'mismatched');
  assert.equal(L.viewOf(t.state, '', { now: 200, bootId: 'b1', desktopSession: '/s' }).health.status, 'missing');
  assert.equal(L.viewOf(t.state, '{oops', { now: 200, bootId: 'b1', desktopSession: '/s' }).health.status, 'invalid');
});

// Unstable changes no gate: the popup logic validates the history and keeps claiming.
test('a record with two crashes is healthy to the popup logic and still leads to a claim', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  const health = { schema: 2, instanceId: 'coordinator-1', epoch: { bootId: 'b1', desktopSession: '/s' }, owner: { pid: 7, start: '1' },
    writtenAt: 700_000, stopped: false, crashedAt: [580_000, 640_000] };
  const snapshot = plain(L.viewOf(t.state, JSON.stringify(health), { now: 700_100, bootId: 'b1', desktopSession: '/s' }));
  assert.deepEqual(snapshot.health, { status: 'healthy' });
  assert.equal(L.nextMoment(snapshot, undefined).action, 'initialise');
  assert.equal(L.nextMoment(snapshot, null).action, 'claim');
});

test('the first snapshot attaches by suppressing what it already shows, in bounded batches', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  const firstSnapshot = L.nextMoment(view(t.state), undefined);
  assert.equal(firstSnapshot.action, 'initialise');
  assert.deepEqual(plain(L.initialBatches(view(t.state))), [[episodeOf(t, 'codex:a').id]]);
  const many = { episodes: {} };
  for (let i = 0; i < 1100; i++) many.episodes[`e${i}`] = { id: `e${i}`, closed: false, delivery: { popup: { status: 'eligible' }, toast: { status: 'pending' } } };
  assert.deepEqual(plain(L.initialBatches(many)).map((batch) => batch.length), [512, 512, 76]);
});

test('after attaching, each eligible kind leads to a claim; nothing eligible leads nowhere', () => {
  for (const [harness, native, kind] of [
    ['claude-code', 'Notification:idle_prompt', 'needs-input'], ['codex', 'PermissionRequest', 'needs-approval'],
    ['opencode', 'session.error', 'error'],
  ]) {
    const { t, send } = scene();
    send(harness, native, { session: 's' });
    t.desktop({ focused: '1', origins: { [`${harness}:s`]: '2' } });
    assert.equal(episodeOf(t, `${harness}:s`).kind, kind);
    assert.equal(L.nextMoment(view(t.state), null).action, 'claim');
  }
  const { t, send } = scene();
  send('codex', 'UserPromptSubmit', { session: 's' });
  send('codex', 'Stop', { session: 's' });
  t.desktop({ focused: '1', origins: { 'codex:s': '2' } });
  assert.equal(L.nextMoment(view(t.state), null).action, 'claim');
  t.claim('popup', 'popup-1', 'p');
  assert.equal(L.nextMoment(view(t.state), null).action, 'none');
});

test('no claim while DND is on or unknown, or the coordinator is unhealthy; a playing moment stops', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  const playing = job(episodeOf(t, 'codex:a'));
  for (const status of ['missing', 'stale', 'mismatched', 'invalid']) {
    assert.equal(L.nextMoment(view(t.state, status), null).action, 'none');
    assert.equal(L.nextMoment(view(t.state, status), playing).action, 'cancel');
  }
  for (const dnd of ['on', 'unknown']) {
    const quiet = plain(t.state);
    quiet.desktop.dnd = dnd;
    assert.equal(L.nextMoment(view(quiet), null).action, 'none');
    assert.equal(L.nextMoment(view(quiet), playing).action, 'cancel');
  }
});

test('an initially seen arrival plays through; a later visit or dismissal cancels it', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '2', origins: { 'codex:a': '2' } });
  const seenAtClaim = job(episodeOf(t, 'codex:a'), { seen: true });
  assert.equal(L.nextMoment(view(t.state), seenAtClaim).action, 'none');
  const { t: u, send: sendU } = scene();
  sendU('codex', 'PermissionRequest', { session: 'a' });
  u.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  const unseen = job(episodeOf(u, 'codex:a'));
  assert.equal(L.nextMoment(view(u.state), unseen).action, 'none');
  u.desktop({ focused: '2', origins: { 'codex:a': '2' } });
  assert.deepEqual(plain(L.nextMoment(view(u.state), unseen)), { action: 'cancel', episodeId: unseen.episodeId });
  const { t: w, send: sendW } = scene();
  sendW('codex', 'PermissionRequest', { session: 'a' });
  w.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  const dismissed = job(episodeOf(w, 'codex:a'));
  w.dismiss([dismissed.episodeId]);
  assert.equal(L.nextMoment(view(w.state), dismissed).action, 'cancel');
});

test('a source closing its request cancels the moment', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  const playing = job(episodeOf(t, 'codex:a'));
  send('codex', 'PreToolUse', { session: 'a' });
  assert.equal(L.nextMoment(view(t.state), playing).action, 'cancel');
});

test('a new error preempts a lower-priority moment and the queued request stays pending', () => {
  const { t, send } = scene();
  send('codex', 'UserPromptSubmit', { session: 'c' });
  send('codex', 'Stop', { session: 'c' });
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:c': '2', 'codex:a': '2' } });
  const claimed = t.claim('popup', 'popup-1', 'p1');
  const approval = episodeOf(t, 'codex:a');
  assert.deepEqual(claimed.ids, [approval.id]);
  send('opencode', 'session.error', { session: 'o' });
  t.desktop({ focused: '1', origins: { 'codex:c': '2', 'codex:a': '2', 'opencode:o': '2' } });
  const errorPreemptsCompletion = L.nextMoment(view(t.state), job(approval));
  assert.equal(errorPreemptsCompletion.action, 'preempt');
  assert.equal(errorPreemptsCompletion.episodeId, episodeOf(t, 'opencode:o').id);
  t.finish('popup', 'p1', 'interrupted');
  assert.equal(episodeOf(t, 'codex:c').delivery.popup.status, 'eligible');
  assert.equal(t.state.episodes[approval.id].closed, false);
  assert.equal(L.nextMoment(view(t.state), job(episodeOf(t, 'opencode:o'))).action, 'none');
  const errorPlaying = job(episodeOf(t, 'opencode:o'));
  send('opencode', 'session.error', { session: 'p' });
  t.desktop({ focused: '1', origins: { 'codex:c': '2', 'codex:a': '2', 'opencode:o': '2', 'opencode:p': '2' } });
  assert.equal(L.nextMoment(view(t.state), errorPlaying).action, 'none');
});

test('a late idle-input for a delivered completion and a worker finishing start nothing', () => {
  const { t, send } = scene();
  send('claude-code', 'UserPromptSubmit', { session: 's' });
  send('claude-code', 'Stop', { session: 's' });
  t.desktop({ focused: '1', origins: { 'claude-code:s': '1' } });
  t.claim('popup', 'popup-1', 'p');
  t.finish('popup', 'p', 'delivered');
  send('claude-code', 'Notification:idle_prompt', { session: 's' });
  t.desktop({ focused: '1', origins: { 'claude-code:s': '1' } });
  const lateSameTurnInput = L.nextMoment(view(t.state), null);
  assert.equal(lateSameTurnInput.action, 'none');
  const { t: u, r, send: sendU } = scene();
  sendU('codex', 'UserPromptSubmit', { session: 'root' });
  sendU('codex', 'SubagentStart', { session: 'root', worker: 'w' });
  sendU('codex', 'SubagentStop', { session: 'root', worker: 'w' });
  u.observe(r.rows());
  u.desktop({ focused: '1', origins: { 'codex:root': '2' } });
  assert.equal(L.nextMoment(view(u.state), null).action, 'none');
});

test('playback follows the motion policy, and off draws no popup', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 'a' });
  const episode = episodeOf(t, 'codex:a');
  assert.deepEqual(plain(L.playbackFor(job(episode))), { draw: true, mode: 'full', choreography: 'peek', sprite: '/art/x.png', error: null });
  assert.equal(L.playbackFor(job(episode, { motionPolicy: 'reduced' })).mode, 'reduced');
  const offPolicyDrawsPopup = L.playbackFor(job(episode, { motionPolicy: 'off' })).draw;
  assert.equal(offPolicyDrawsPopup, false);
  assert.equal(L.playbackFor({ ...job(episode), kind: 'error', pose: 'error' }).choreography, 'error');
  assert.equal(L.playbackFor({ ...job(episode), kind: 'completion', pose: 'done' }).choreography, 'done');
  const missing = L.playbackFor({ ...job(episode), presentation: { sprite: null, motionPolicy: 'full' } });
  assert.deepEqual([missing.draw, missing.error], [false, `art unavailable for episode ${episode.id}`]);
  assert.equal(L.playbackFor({ ...job(episode), presentation: null }).draw, false);
});

test('a finish reply for an old token does not change the current job', () => {
  const current = { episodeId: 'e2', token: 'new' };
  const oldTokenFinishChangedCurrentJob = L.jobAfterFinish(current, 'old') !== current;
  assert.equal(oldTokenFinishChangedCurrentJob, false);
  assert.equal(L.jobAfterFinish(current, 'new'), null);
  assert.equal(L.jobAfterFinish(null, 'new'), null);
});

test('control requests are one line each, and replies are validated per operation', () => {
  assert.equal(L.encodeRequest({ op: 'claim', consumerId: 'p' }), '{"op":"claim","consumerId":"p"}\n');
  assert.deepEqual(plain(L.parseReply('{"token":null,"job":null}\n', 'claim')), { reply: { token: null, job: null }, error: null });
  assert.equal(L.parseReply('{"token":"t","job":{"episodeId":"e1","kind":"error","pose":"error","seen":false}}', 'claim').reply.job.episodeId, 'e1');
  assert.match(L.parseReply('{"token":"t","job":null}', 'claim').error, /claim/);
  assert.deepEqual(plain(L.parseReply('{"suppressedIds":["e1"]}', 'initialise').reply), { suppressedIds: ['e1'] });
  assert.match(L.parseReply('{"finishedIds":"e1"}', 'finish').error, /finish/);
  assert.match(L.parseReply('', 'finish').error, /empty/);
});

test('focused-output parsing requires one non-empty name', () => {
  assert.deepEqual(plain(L.parseFocusedOutput('{"name":"DP-1"}')), { name: 'DP-1', error: null });
  assert.match(L.parseFocusedOutput('').error, /empty/);
  assert.match(L.parseFocusedOutput('{}').error, /name/);
  assert.match(L.parseFocusedOutput('[]').error, /object/);
});

test('the folded-intent detector is gone', () => {
  for (const name of ['parseIntent', 'observe', 'decidePlayback']) assert.equal(typeof L[name], 'undefined', name);
});

// The QML itself runs only under Quickshell; its wiring is held to the contract here,
// statically. Runtime behaviour is the approved headless/native pilot's to show.
test('the shell consumes shared attention through one serialized, EOF-closed control process', () => {
  const qml = readFileSync(fileURLToPath(new URL('./shell.qml', import.meta.url)), 'utf8');
  assert.equal(qml.includes('intent.json'), false);
  for (const fragment of [
    'path: root.stateDir === "" ? "" : root.stateDir + "/attention.json"',
    'path: root.stateDir === "" ? "" : root.stateDir + "/attention-health.json"',
    'path: "/proc/sys/kernel/random/boot_id"', 'command: ["familiar", "attention", "popup"]',
    'WlrLayershell.namespace: "familiar:desktop-moments"', 'WlrLayershell.keyboardFocus: WlrKeyboardFocus.None',
    'mask: Region { item: null }', 'onStarted: root.controlStarted()',
  ]) assert.ok(qml.includes(fragment), fragment);
  const start = qml.slice(qml.indexOf('function startNextRequest()'), qml.indexOf('function controlStarted()'));
  assert.ok(start.indexOf('control.stdinEnabled = true') < start.indexOf('control.running = true'), 'stdin is enabled before the process starts');
  assert.match(start, /if \(currentRequest !== null \|\| requests\.length === 0\) return;/);
  const started = qml.slice(qml.indexOf('function controlStarted()'), qml.indexOf('function controlExited('));
  assert.ok(started.indexOf('control.write(') < started.indexOf('control.stdinEnabled = false'), 'one write, then EOF');
  assert.match(qml, /id: controlTimeout\s+interval: 2000/);
  assert.match(qml, /id: watchdog[\s\S]*?interval: 6000/);
});

test('a failed or empty claim backs off instead of spinning, and a request that never starts is released', () => {
  const qml = readFileSync(fileURLToPath(new URL('./shell.qml', import.meta.url)), 'utf8');
  assert.match(qml, /id: claimBackoff\s+interval: 2000/);
  const claim = qml.slice(qml.indexOf('function claim()'), qml.indexOf('function finish('));
  assert.match(claim, /if \(claimHeld/);
  const attach = qml.slice(qml.indexOf('function attach('), qml.indexOf('function claim()'));
  assert.match(attach, /if \(attaching \|\| claimHeld\) return;/);
  const reply = qml.slice(qml.indexOf('function handleReply('), qml.indexOf('function startJob('));
  assert.match(reply, /holdClaims\(\)/);
  const timeout = qml.slice(qml.indexOf('id: controlTimeout'), qml.indexOf('id: controlTimeout') + 600);
  assert.match(timeout, /root\.controlTimedOut\(\)/);
  const timedOut = qml.slice(qml.indexOf('function controlTimedOut()'), qml.indexOf('function handleReply('));
  assert.match(timedOut, /did not start/);
});

test('the shell reads the same state directory as the CLI it drives, refusing a relative one', () => {
  const qml = readFileSync(fileURLToPath(new URL('./shell.qml', import.meta.url)), 'utf8');
  assert.match(qml, /Quickshell\.env\("FAMILIAR_STATE_DIR"\)/);
  assert.match(qml, /FAMILIAR_STATE_DIR must be an absolute path/);
  const evaluate = qml.slice(qml.indexOf('function evaluate()'), qml.indexOf('function attach('));
  assert.match(evaluate, /if \(stateDirError !== ""\) return;/);
});
