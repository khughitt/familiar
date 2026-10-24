// The desktop attention coordinator, run in-process against a test-owned state
// directory with a fake clock, a fake Niri event stream, a fake watcher and a fake
// execFile standing in for `niri msg` and `noctalia msg`. Real files, the real lock
// and the real atomic writer; no host socket, signal, compositor or notification.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadThemePack } from 'familiar-theme';
import { reduceAttention } from '../src/attention/model.js';
import { mutateAttention, readAttention } from '../src/attention/store.js';
import { paths as familiarPaths } from '../src/bus/paths.js';
import { withLock } from '../src/bus/lock.js';
import { writeJsonAtomic } from '../src/bus/store.js';
import { runCoordinator, syncOnce } from '../integrations/niri/coordinator.js';

const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);
import { niriWorkspacesPath } from '../integrations/niri/topology.js';
import { createRegistry, handle, nativeEvent, snapshotOf } from './helpers/attention.js';

const pack = await loadThemePack(new URL('./fixtures/theme-pack', import.meta.url).pathname);
const EPOCH = { bootId: '11111111-1111-4111-8111-111111111111', desktopSession: '/run/niri-test.sock' };
const START = 1_000_000;

// Timers fire only when the test advances time. `settle` waits for the real file
// writes the coordinator started, so fake-time measurements are deterministic.
function fakeClock(settle) {
  let now = START;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, repeat) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, ms), fn, repeat: repeat ? ms : null });
    return id;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => add(fn, ms, true),
    clearInterval: (id) => timers.delete(id),
    pending: () => timers.size,
    sleep: (ms) => new Promise((resolve) => add(resolve, ms, false)),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        now = timer.at;
        if (timer.repeat) timer.at += timer.repeat; else timers.delete(id);
        timer.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

// A pushable stand-in for `niri msg -j event-stream`.
function fakeStream() {
  const queue = [];
  let wake = null;
  let ended = false;
  const stream = {
    closed: false,
    push(event) { queue.push(JSON.stringify(event)); wake?.(); },
    end() { ended = true; wake?.(); },
    close() { stream.closed = true; ended = true; wake?.(); },
    lines: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift();
          if (ended) return;
          await new Promise((resolve) => { wake = resolve; });
          wake = null;
        }
      },
    },
  };
  return stream;
}

const ws = (id, idx, output, extra = {}) => ({
  id, idx, name: null, output, is_urgent: false, is_active: false, is_focused: false, active_window_id: 1, ...extra,
});
const WORKSPACES = [ws(1, 1, 'DP-1', { is_active: true, is_focused: true }), ws(2, 2, 'DP-1'), ws(3, 3, 'DP-1')];
const chainsFor = (pid) => [{ pid, ppid: pid - 1, starttime: '9000' }, { pid: pid - 1, ppid: 1, starttime: '1' }];

async function harness(t, { dnd = () => 'off', send = async () => {}, windows = () => [], writeDelayMs = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-coordinator-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = familiarPaths({ HOME: dir, FAMILIAR_STATE_DIR: join(dir, 'state'), FAMILIAR_CONFIG_DIR: join(dir, 'config') });
  const io = new Set();
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      while (io.size) await Promise.all([...io]);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const clock = fakeClock(settle);
  const stream = fakeStream();
  const calls = { windows: 0, dnd: 0, toasts: [], locks: 0 };
  const writes = [];
  const execFile = async (file, args) => {
    if (file === 'niri' && args.join(' ') === 'msg -j windows') {
      calls.windows += 1;
      return { stdout: JSON.stringify(windows()), stderr: '' };
    }
    if (file === 'noctalia' && args[1] === 'notification-dnd-status') {
      calls.dnd += 1;
      return { stdout: `${dnd()}\n`, stderr: '' };
    }
    if (file === 'noctalia' && args[1] === 'notification-show') {
      calls.toasts.push(args);
      return send(args);
    }
    throw new Error(`unexpected exec ${file} ${args.join(' ')}`);
  };
  let watcher = null;
  const watch = (path, listener) => {
    watcher = { path, listener, closed: false, close() { watcher.closed = true; } };
    return watcher;
  };
  const listeners = new Map();
  const signals = {
    on: (name, fn) => listeners.set(name, fn),
    off: (name) => listeners.delete(name),
    emit: (name) => listeners.get(name)?.(),
    count: () => listeners.size,
  };
  const writeAtomic = async (path, value) => {
    if (writeDelayMs) await clock.sleep(writeDelayMs);
    const done = writeJsonAtomic(path, value);
    io.add(done);
    try { await done; } finally { io.delete(done); }
    writes.push({ path, value, at: clock.now() });
  };
  const lockWith = (path, fn, options) => {
    if (path === paths.presentationLockPath) calls.locks += 1;
    return withLock(path, fn, options);
  };
  let stderr = '';
  const deps = {
    paths, execFile, watch, clock, signals, writeAtomic, lockWith,
    stderr: { write: (text) => { stderr += text; } },
    relay: { ancestors: chainsFor },
    eventStream: () => stream,
    loadContext: async () => ({ pack, tone: { mode: 'dark', satScale: 1 }, motionPolicy: 'full' }),
    liveEpoch: () => EPOCH, instanceId: 'coordinator-1', owner: { pid: 77, start: '123' },
  };
  const registry = createRegistry({ now: () => clock.now() });
  let revision = 1;
  // What relay and the observer would do: publish a row and capture it.
  const capture = async (harnessName, native, ids, pid) => {
    const event = nativeEvent(harnessName, native, ids);
    registry.apply(event, { process: handle(pid) });
    revision += 1;
    await mutateAttention({ paths }, async (state) => reduceAttention(state, {
      type: 'observe', snapshot: snapshotOf(registry.rows(), { revision }), envelope: null, now: clock.now(),
    }));
  };
  await mutateAttention({ paths }, async (state) => reduceAttention(state, {
    type: 'observe', snapshot: snapshotOf([], { revision: 1 }), envelope: null, now: clock.now(),
  }));
  const until = async (predicate, what) => {
    for (let i = 0; i < 400; i++) {
      if (await predicate()) return;
      await clock.advance(1);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail(`timed out waiting for ${what}; stderr: ${stderr}`);
  };
  const touch = (file) => watcher.listener('rename', file);
  const start = () => runCoordinator(deps);
  const h = {
    dir, paths, clock, stream, calls, writes, signals, settle, capture, until, touch, deps, start,
    stderr: () => stderr, watcher: () => watcher,
    state: () => readAttention(paths),
    // Start, seed the topology, and wait for the first resync to settle.
    async boot() {
      h.running = start();
      stream.push({ WorkspacesChanged: { workspaces: WORKSPACES } });
      await until(async () => calls.windows > 0, 'the first resync');
      await clock.advance(200);
      await h.quiesce();
    },
    // The coordinator's chained work (locks, reads) runs in real time behind the fake
    // clock: before reading a counter, wait until its observable effects stop moving.
    async quiesce() {
      let last = '';
      let stable = 0;
      for (let i = 0; i < 1000 && stable < 10; i++) {
        await clock.advance(1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const seen = JSON.stringify([calls, writes.length, stderr.length]);
        stable = seen === last ? stable + 1 : 0;
        last = seen;
      }
    },
    // Exits are awaited with the clock still moving: a write may be sleeping on it.
    async exit(running = h.running) {
      let settled = false;
      running.then(() => { settled = true; }, () => { settled = true; });
      for (let i = 0; i < 500 && !settled; i++) {
        await clock.advance(10);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return running;
    },
    async stop() {
      signals.emit('SIGTERM');
      return h.exit();
    },
  };
  return h;
}

const episodeOf = (state, agentId) => Object.values(state.episodes)
  .find((episode) => state.sources[episode.sourceKey].agentId === agentId);
const onWorkspace = (pidToWorkspace) => () => Object.entries(pidToWorkspace)
  .map(([pid, workspace], i) => ({ id: 100 + i, pid: Number(pid) - 1, workspace_id: workspace }));

// --- singleton and lifecycle ---------------------------------------------------------------

test('a second coordinator refuses to start while one runs', async (t) => {
  const h = await harness(t);
  await h.boot();
  let secondCoordinatorStarted = true;
  await assert.rejects(runCoordinator({ ...h.deps, eventStream: () => fakeStream(), instanceId: 'coordinator-2' }), /already running/)
    .then(() => { secondCoordinatorStarted = false; });
  assert.equal(secondCoordinatorStarted, false);
  assert.equal(await h.stop(), 0);
});

test('TERM reaps the event stream, the watcher and every timer, and exits 0', async (t) => {
  const h = await harness(t);
  await h.boot();
  assert.equal(await h.stop(), 0);
  assert.equal(h.stream.closed, true);
  assert.equal(h.watcher().closed, true);
  assert.equal(h.clock.pending(), 0);
  assert.equal(h.signals.count(), 0);
});

test('a compositor disconnect publishes a disconnected feed and exits nonzero for supervision', async (t) => {
  const h = await harness(t);
  await h.boot();
  h.stream.end();
  assert.equal(await h.exit(), 1);
  const feed = JSON.parse(await readFile(niriWorkspacesPath(h.paths), 'utf8'));
  assert.equal(feed.connected, false);
  assert.equal(h.watcher().closed, true);
  assert.equal(h.clock.pending(), 0);
  assert.match(h.stderr(), /event stream closed/);
});

test('a workspace delta before the full snapshot fails the stream rather than guessing', async (t) => {
  const h = await harness(t);
  const running = h.start();
  h.stream.push({ WorkspaceActivated: { id: 2, focused: true } });
  assert.equal(await h.exit(running), 1);
  assert.match(h.stderr(), /before a full workspace snapshot/);
});

// --- recovery and delivery ------------------------------------------------------------------

test('startup recovers: a previous reservation is uncertain, queued IDs are suppressed, nothing is sent', async (t) => {
  const h = await harness(t, { windows: onWorkspace({ 101: 2, 201: 2 }) });
  await h.capture('codex', 'PermissionRequest', { session: 'a' }, 101);
  await h.capture('codex', 'PermissionRequest', { session: 'b' }, 201);
  await mutateAttention({ paths: h.paths }, async (state) => {
    let next = reduceAttention(state, { type: 'desktop', instanceId: 'old-instance', status: 'known', dnd: 'off',
      workspaces: [], origins: {}, enrichment: {}, now: h.clock.now() }).state;
    next = reduceAttention(next, { type: 'claim', surface: 'toast', consumerId: 'old-instance', token: 'old', now: h.clock.now() }).state;
    return { state: next, result: null };
  });
  await mutateAttention({ paths: h.paths }, async (state) => {
    const b = episodeOf(state, 'codex:b');
    const next = structuredClone(state);
    next.episodes[b.id].delivery.toast = { status: 'eligible' };
    return { state: next, result: null };
  });
  await h.boot();
  const afterRestartUncertain = { state: await h.state(), toastSends: h.calls.toasts.length };
  assert.equal(episodeOf(afterRestartUncertain.state, 'codex:a').delivery.toast.status, 'uncertain');
  assert.equal(episodeOf(afterRestartUncertain.state, 'codex:b').delivery.toast.status, 'suppressed');
  assert.equal(afterRestartUncertain.toastSends, 0);
  await h.stop();
});

test('a new request is reserved before its one toast, which is never sent again', async (t) => {
  let h;
  let reservationWasPersistedBeforeExec = null;
  h = await harness(t, {
    windows: onWorkspace({ 101: 2 }),
    send: async () => {
      const saved = JSON.parse(readFileSync(h.paths.attentionPath, 'utf8'));
      reservationWasPersistedBeforeExec = Object.values(saved.episodes)[0].delivery.toast.status === 'reserved';
    },
  });
  await h.boot();
  await h.capture('codex', 'PermissionRequest', { session: 'a' }, 101);
  h.touch('attention.json');
  await h.until(async () => h.calls.toasts.length === 1, 'one toast');
  const notifyArgv = h.calls.toasts[0];
  assert.deepEqual(notifyArgv.slice(0, 2), ['msg', 'notification-show']);
  const payload = JSON.parse(notifyArgv[2]);
  assert.equal(payload.app_name, 'familiar');
  assert.deepEqual([payload.summary, payload.urgency], ['Approval requested — response unconfirmed', 'normal']);
  assert.match(payload.body, /workspace 2/);
  assert.equal(reservationWasPersistedBeforeExec, true);
  await h.until(async () => episodeOf(await h.state(), 'codex:a').delivery.toast.status === 'delivered', 'delivered');
  h.touch('attention.json');
  await h.clock.advance(500);
  await h.quiesce();
  assert.equal(h.calls.toasts.length, 1);
  await h.stop();
});

test('an unknown DND drops the queue for good; known/off later sends only new events', async (t) => {
  let answer = 'maybe';
  const h = await harness(t, { dnd: () => answer, windows: onWorkspace({ 101: 2, 201: 2 }) });
  await h.boot();
  await h.capture('codex', 'PermissionRequest', { session: 'a' }, 101);
  h.touch('attention.json');
  await h.until(async () => episodeOf(await h.state(), 'codex:a').delivery.toast.status === 'suppressed', 'suppression');
  answer = 'off';
  await h.clock.advance(2500);
  h.touch('attention.json');
  await h.clock.advance(500);
  await h.quiesce();
  const afterUnknownThenOff = { toastSends: h.calls.toasts.length };
  assert.equal(afterUnknownThenOff.toastSends, 0);
  await h.capture('codex', 'PermissionRequest', { session: 'b' }, 201);
  h.touch('attention.json');
  await h.until(async () => h.calls.toasts.length === 1, 'the new toast');
  await h.stop();
});

test('DND on suppresses and stops queued work without a send', async (t) => {
  const h = await harness(t, { dnd: () => 'on', windows: onWorkspace({ 101: 2 }) });
  await h.boot();
  await h.capture('codex', 'PermissionRequest', { session: 'a' }, 101);
  h.touch('attention.json');
  await h.until(async () => episodeOf(await h.state(), 'codex:a').delivery.popup.status === 'suppressed', 'suppression');
  assert.equal(h.calls.toasts.length, 0);
  assert.equal((await h.state()).desktop.dnd, 'on');
  await h.stop();
});

test('a failed send is recorded and not retried', async (t) => {
  const h = await harness(t, { windows: onWorkspace({ 101: 2 }), send: async () => { throw Object.assign(new Error('timed out'), { killed: true }); } });
  await h.boot();
  await h.capture('codex', 'PermissionRequest', { session: 'a' }, 101);
  h.touch('attention.json');
  await h.until(async () => episodeOf(await h.state(), 'codex:a').delivery.toast.status === 'failed', 'failed');
  h.touch('attention.json');
  await h.clock.advance(500);
  await h.quiesce();
  assert.equal(h.calls.toasts.length, 1);
  assert.match(h.stderr(), /notification-show failed/);
  await h.stop();
});

test('a burst is summarised per workspace, and work dismissed before its send is not announced', async (t) => {
  let h;
  h = await harness(t, {
    windows: onWorkspace({ 101: 2, 201: 2, 301: 2, 401: 3 }),
    send: async () => {
      if (h.calls.toasts.length !== 1) return;
      await mutateAttention({ paths: h.paths }, async (state) => reduceAttention(state, {
        type: 'dismiss', ids: [episodeOf(state, 'codex:d').id], now: h.clock.now(),
      }));
    },
  });
  await h.boot();
  for (const [session, pid] of [['a', 101], ['b', 201], ['c', 301], ['d', 401]]) await h.capture('codex', 'PermissionRequest', { session }, pid);
  h.touch('attention.json');
  await h.until(async () => episodeOf(await h.state(), 'codex:d').delivery.toast.status === 'suppressed', 'the second group settled');
  assert.equal(h.calls.toasts.length, 1);
  const payload = JSON.parse(h.calls.toasts[0][2]);
  assert.equal(payload.summary, '3 agents need attention');
  const state = await h.state();
  assert.deepEqual(['a', 'b', 'c'].map((s) => episodeOf(state, `codex:${s}`).delivery.toast.status), ['delivered', 'delivered', 'delivered']);
  await h.stop();
});

test('an unfocused completion gets one low-urgency toast; a focused one gets none', async (t) => {
  const h = await harness(t, { windows: onWorkspace({ 101: 2, 201: 1 }) });
  await h.boot();
  await h.capture('codex', 'UserPromptSubmit', { session: 'a' }, 101);
  await h.capture('codex', 'Stop', { session: 'a' }, 101);
  await h.capture('codex', 'UserPromptSubmit', { session: 'b' }, 201);
  await h.capture('codex', 'Stop', { session: 'b' }, 201);
  h.touch('attention.json');
  await h.until(async () => h.calls.toasts.length === 1, 'one toast');
  const payload = JSON.parse(h.calls.toasts[0][2]);
  assert.deepEqual([payload.summary, payload.urgency], ['Agent finished its turn', 'low']);
  const state = await h.state();
  assert.equal(episodeOf(state, 'codex:b').delivery.toast.status, 'suppressed');
  assert.equal(episodeOf(state, 'codex:b').seen, true);
  await h.stop();
});

test('a failed window query removes attribution instead of keeping a stale workspace', async (t) => {
  let fail = false;
  const h = await harness(t, { windows: () => { if (fail) throw new Error('niri gone'); return onWorkspace({ 101: 2 })(); } });
  await h.boot();
  await h.capture('codex', 'PermissionRequest', { session: 'a' }, 101);
  h.touch('attention.json');
  await h.until(async () => Object.keys((await h.state()).desktop.origins).length === 1, 'attribution');
  fail = true;
  h.touch('sessions.json');
  await h.until(async () => Object.keys((await h.state()).desktop.origins).length === 0, 'attribution removed');
  await h.stop();
});

// --- heartbeat, topology and locks ------------------------------------------------------------

test('the heartbeat and the workspace feed keep going while the presentation lock is held', async (t) => {
  const h = await harness(t);
  await h.boot();
  let release;
  const held = withLock(h.paths.presentationLockPath, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = h.writes.length;
  h.stream.push({ WorkspaceActivated: { id: 3, focused: true } });
  await h.clock.advance(2000);
  const health = JSON.parse(await readFile(h.paths.attentionHealthPath, 'utf8'));
  const healthyQuietHeartbeatAgeMs = h.clock.now() - health.writtenAt;
  const feed = JSON.parse(await readFile(niriWorkspacesPath(h.paths), 'utf8'));
  const topologyWrittenWhilePresentationLockHeld = feed.workspaces.find((row) => row.is_focused).id === '3';
  release();
  await held;
  assert.equal(healthyQuietHeartbeatAgeMs <= 2000, true);
  assert.equal(topologyWrittenWhilePresentationLockHeld, true);
  assert.ok(h.writes.length > before);
  assert.deepEqual(health.epoch, EPOCH);
  assert.equal(health.instanceId, 'coordinator-1');
  await h.stop();
});

test('a hundred focus changes with nothing unseen take no presentation lock', async (t) => {
  const h = await harness(t, { windows: onWorkspace({ 101: 2 }) });
  await h.boot();
  await h.capture('codex', 'PermissionRequest', { session: 'a' }, 101);
  h.touch('attention.json');
  await h.until(async () => (await h.state()).desktop.origins && Object.keys((await h.state()).desktop.origins).length === 1, 'attribution');
  await mutateAttention({ paths: h.paths }, async (state) => reduceAttention(state, { type: 'dismiss', ids: Object.keys(state.episodes), now: h.clock.now() }));
  await h.quiesce();
  h.calls.locks = 0;
  for (let i = 0; i < 100; i++) {
    h.stream.push({ WorkspaceActivated: { id: i % 2 ? 2 : 3, focused: true } });
    await h.clock.advance(5);
  }
  await h.quiesce();
  const lockAcquisitionsFor100FocusChangesWithoutUnseenEpisodes = h.calls.locks;
  assert.equal(lockAcquisitionsFor100FocusChangesWithoutUnseenEpisodes, 0);
  await h.stop();
});

test('one seen transition takes one lock; repeated focus takes none', async (t) => {
  const h = await harness(t, { windows: onWorkspace({ 101: 2 }) });
  await h.boot();
  await h.capture('codex', 'PermissionRequest', { session: 'a' }, 101);
  h.touch('attention.json');
  await h.until(async () => Object.keys((await h.state()).desktop.origins).length === 1, 'attribution');
  await h.quiesce();
  h.calls.locks = 0;
  h.stream.push({ WorkspaceActivated: { id: 2, focused: true } });
  await h.until(async () => episodeOf(await h.state(), 'codex:a').seen, 'seen');
  for (let i = 0; i < 6; i++) {
    h.stream.push({ WorkspaceActivated: { id: i % 2 ? 2 : 3, focused: true } });
    await h.clock.advance(5);
  }
  await h.quiesce();
  const lockAcquisitionsForOneSeenTransitionThenRepeatedFocus = h.calls.locks;
  assert.equal(lockAcquisitionsForOneSeenTransitionThenRepeatedFocus, 1);
  await h.stop();
});

test('a workspace event is published within 20 ms behind an older in-flight freshness write', async (t) => {
  const h = await harness(t, { writeDelayMs: 10 });
  await h.boot();
  const feedPath = niriWorkspacesPath(h.paths);
  // The 1000 ms freshness refresh starts its 10 ms write; the event lands mid-write.
  const nextRefresh = 1000 - ((h.clock.now() - START) % 1000);
  await h.clock.advance(nextRefresh + 5);
  const eventAt = h.clock.now();
  h.stream.push({ WorkspaceActivated: { id: 2, focused: true } });
  await h.settle();
  await h.until(async () => h.writes.some((w) => w.path === feedPath && w.at >= eventAt
    && w.value.workspaces.find((row) => row.is_focused)?.id === '2'), 'the new feed');
  const published = h.writes.find((w) => w.path === feedPath && w.at >= eventAt && w.value.workspaces.find((row) => row.is_focused)?.id === '2');
  const eventToTopologyPublishMs = published.at - eventAt;
  assert.equal(eventToTopologyPublishMs <= 20, true, `${eventToTopologyPublishMs} ms`);
  await h.stop();
});

test('a burst of focus events ends on the newest focus', async (t) => {
  const h = await harness(t);
  await h.boot();
  for (let i = 0; i < 50; i++) h.stream.push({ WorkspaceActivated: { id: (i % 3) + 1, focused: true } });
  await h.clock.advance(100);
  const feed = JSON.parse(await readFile(niriWorkspacesPath(h.paths), 'utf8'));
  assert.equal(feed.workspaces.find((row) => row.is_focused).id, String((49 % 3) + 1));
  await h.stop();
});

test('heartbeat and feed renames never trigger a resync, and a rename burst coalesces', async (t) => {
  const h = await harness(t);
  await h.boot();
  const before = h.calls.windows;
  h.touch('attention-health.json');
  h.touch('niri-workspaces.json');
  await h.clock.advance(300);
  await h.quiesce();
  assert.equal(h.calls.windows, before);
  for (let i = 0; i < 10; i++) {
    h.touch(i % 2 ? 'sessions.json' : 'attention.json');
    await h.clock.advance(5);
  }
  await h.clock.advance(300);
  await h.quiesce();
  assert.equal(h.calls.windows, before + 1);
  await h.stop();
});

// --- one-shot sync ----------------------------------------------------------------------------

const withWorkspaces = (execFile) => async (file, args, options) => (file === 'niri' && args.join(' ') === 'msg -j workspaces'
  ? { stdout: JSON.stringify(WORKSPACES), stderr: '' } : execFile(file, args, options));

test('a one-shot sync recovers, attributes from a workspace query and delivers once', async (t) => {
  const h = await harness(t, { windows: onWorkspace({ 101: 2 }) });
  await h.capture('codex', 'PermissionRequest', { session: 'old' }, 101);
  assert.equal(await syncOnce({ ...h.deps, execFile: withWorkspaces(h.deps.execFile) }), 0);
  let state = await h.state();
  assert.equal(episodeOf(state, 'codex:old').delivery.toast.status, 'suppressed');
  assert.deepEqual(Object.values(state.desktop.origins), [{ workspaceId: '2', output: 'DP-1' }]);
  assert.equal(h.calls.toasts.length, 0);
  await h.capture('codex', 'PermissionRequest', { session: 'new' }, 101);
  await syncOnce({ ...h.deps, execFile: withWorkspaces(h.deps.execFile) });
  state = await h.state();
  assert.equal(episodeOf(state, 'codex:new').delivery.toast.status, 'suppressed');
  assert.equal(h.calls.toasts.length, 0);
});

test('a one-shot sync leaves attention to a running coordinator', async (t) => {
  const h = await harness(t);
  await h.boot();
  const before = await readFile(h.paths.attentionPath, 'utf8');
  assert.equal(await syncOnce({ ...h.deps, execFile: withWorkspaces(h.deps.execFile), instanceId: 'sync-1' }), 0);
  assert.match(h.stderr(), /a coordinator is running; it keeps attention current/);
  assert.equal(await readFile(h.paths.attentionPath, 'utf8'), before);
  await h.stop();
});
