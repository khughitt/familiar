// The desktop attention coordinator, run in-process against a test-owned state
// directory with a fake clock, a fake Niri event stream, a fake watcher and a fake
// execFile standing in for `niri msg` and `noctalia msg`. Real files, the real lock
// and the real atomic writer; no host socket, signal, compositor or notification.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadThemePack } from 'familiar-theme';
import { reduceAttention } from '../src/attention/model.js';
import { healthStatus, mutateAttention, readAttention } from '../src/attention/store.js';
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
      while (io.size) await Promise.allSettled([...io]);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const clock = fakeClock(settle);
  const calls = { windows: 0, dnd: 0, toasts: [], locks: 0, eventStreams: 0 };
  const writes = [];
  // Per run: the window queries since the latest start, so a restart's boot waits on its own.
  let runWindows = 0;
  const execFile = async (file, args) => {
    if (file === 'niri' && args.join(' ') === 'msg -j windows') {
      calls.windows += 1;
      runWindows += 1;
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
  // Health writes: every record issued, in order; one may be held before it enters `io`
  // (so `settle` never waits on it), and every write after a budget may be made to fail.
  const healthWrites = [];
  let heldHealthWrite = null;
  let healthWritesLeft = null;
  const writeAtomic = async (path, value) => {
    if (path === paths.attentionHealthPath) {
      healthWrites.push(value);
      if (healthWritesLeft !== null) {
        if (healthWritesLeft === 0) throw new Error('health write refused by the test');
        healthWritesLeft -= 1;
      }
      if (heldHealthWrite !== null) {
        const held = heldHealthWrite;
        heldHealthWrite = null;
        await held;
      }
    }
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
    eventStream: () => {
      calls.eventStreams += 1;
      return h.stream;
    },
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
  // Each run gets its own event stream, created before the coordinator asks for it.
  const begin = (overrides) => {
    h.stream = fakeStream();
    runWindows = 0;
    h.running = runCoordinator({ ...deps, ...overrides });
    return h.running;
  };
  const start = () => begin({});
  const h = {
    dir, paths, clock, calls, writes, healthWrites, signals, settle, capture, until, touch, deps, start,
    stream: null, running: null,
    stderr: () => stderr, watcher: () => watcher,
    state: () => readAttention(paths),
    // The next run, as a new coordinator instance in the same state directory.
    restart: ({ instanceId }) => begin({ instanceId }),
    // The next health write waits until the returned function is called.
    holdHealthWrite() {
      let release;
      heldHealthWrite = new Promise((resolve) => { release = resolve; });
      return release;
    },
    // Every health write after the next `after` fails.
    failHealthWrites({ after }) {
      healthWritesLeft = after;
    },
    // Start (or, given an instance ID, restart), seed the topology, and wait for the
    // run's first resync to settle.
    async boot({ instanceId } = {}) {
      if (instanceId === undefined) start(); else h.restart({ instanceId });
      h.stream.push({ WorkspacesChanged: { workspaces: WORKSPACES } });
      await until(async () => runWindows > 0, 'the first resync');
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

// --- crash history ---------------------------------------------------------------------------

const readHealthFile = async (h) => JSON.parse(await readFile(h.paths.attentionHealthPath, 'utf8'));
const heartbeatsOf = (h, instanceId) => h.healthWrites.filter((record) => record.instanceId === instanceId);
const predecessor = (extra = {}) => ({
  schema: 2, instanceId: 'old-instance', epoch: EPOCH, owner: { pid: 66, start: '42' }, writtenAt: START - 1000,
  stopped: false, crashedAt: [], ...extra,
});
const unusableLines = (h) => h.stderr().split('health record unusable; crash history reset').length - 1;

test('an unclean predecessor is counted; a clean one is not', async (t) => {
  const h = await harness(t);
  await h.boot();
  h.stream.end();
  assert.equal(await h.exit(), 1);
  const run1 = await readHealthFile(h);
  assert.equal(run1.stopped, false);
  await h.boot({ instanceId: 'coordinator-2' });
  assert.deepEqual(heartbeatsOf(h, 'coordinator-2')[0].crashedAt, [run1.writtenAt]);
  assert.equal(await h.stop(), 0);
  const run2 = await readHealthFile(h);
  const lastPeriodic = heartbeatsOf(h, 'coordinator-2').filter((record) => !record.stopped).at(-1);
  assert.deepEqual(run2, { ...lastPeriodic, stopped: true });
  await h.boot({ instanceId: 'coordinator-3' });
  assert.deepEqual(heartbeatsOf(h, 'coordinator-3')[0].crashedAt, run2.crashedAt);
  assert.equal(await h.stop(), 0);
});

test('history from another boot, schema 1 or an invalid record starts empty', async (t) => {
  const { stopped, crashedAt, ...schemaOne } = predecessor({ schema: 1 });
  const cases = [
    ['another boot', predecessor({ epoch: { ...EPOCH, bootId: '22222222-2222-4222-8222-222222222222' }, crashedAt: [START - 2000] }), 0],
    ['another desktop session', predecessor({ epoch: { ...EPOCH, desktopSession: '/run/other.sock' }, crashedAt: [START - 2000] }), 0],
    ['schema 1', schemaOne, 1],
    ['invalid', predecessor({ crashedAt: [START - 1000, START - 2000] }), 1],
  ];
  for (const [name, record, lines] of cases) {
    const h = await harness(t);
    await writeJsonAtomic(h.paths.attentionHealthPath, record);
    await h.boot();
    assert.deepEqual(heartbeatsOf(h, 'coordinator-1')[0].crashedAt, [], name);
    assert.equal(unusableLines(h), lines, `${name}: ${h.stderr()}`);
    assert.equal(await h.stop(), 0);
  }
});

test('a backward clock step keeps the heartbeat valid', async (t) => {
  const h = await harness(t);
  const ahead = START + 60_000;
  await writeJsonAtomic(h.paths.attentionHealthPath, predecessor({ writtenAt: ahead, crashedAt: [ahead] }));
  await h.boot();
  await h.clock.advance(2000);
  const record = await readHealthFile(h);
  assert.equal(healthStatus(record, { now: h.clock.now(), instanceId: 'coordinator-1', ...EPOCH }), 'healthy');
  const own = heartbeatsOf(h, 'coordinator-1');
  assert.ok(own.length > 1);
  assert.ok(own.every((beat) => beat.crashedAt.every((at) => at <= beat.writtenAt)), JSON.stringify(own));
  assert.doesNotMatch(h.stderr(), /heartbeat:/);
  assert.equal(await h.stop(), 0);
});

test('entries age out of the window while the coordinator runs', async (t) => {
  const h = await harness(t);
  const old = START - 599_990;
  await writeJsonAtomic(h.paths.attentionHealthPath, predecessor({ writtenAt: START, stopped: true, crashedAt: [old, old] }));
  // Started without moving the clock, so the first heartbeat is written at START.
  h.start();
  for (let i = 0; i < 1000 && h.healthWrites.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual([h.healthWrites[0].writtenAt, h.healthWrites[0].crashedAt], [START, [old, old]]);
  h.stream.push({ WorkspacesChanged: { workspaces: WORKSPACES } });
  await h.clock.advance(20_000);
  assert.deepEqual((await readHealthFile(h)).crashedAt, []);
  assert.equal(await h.stop(), 0);
});

test('a failed final write leaves the crash countable', async (t) => {
  const h = await harness(t);
  await h.boot();
  h.failHealthWrites({ after: 0 });
  assert.equal(await h.stop(), 0);
  assert.equal((await readHealthFile(h)).stopped, false);
  assert.equal(h.healthWrites.at(-1).stopped, true);
  assert.match(h.stderr(), /final heartbeat: health write refused by the test/);
});

test('a stop before any successful heartbeat writes no final record', async (t) => {
  const h = await harness(t);
  h.failHealthWrites({ after: 0 });
  await h.boot();
  await h.clock.advance(2000);
  assert.equal(await h.stop(), 0);
  assert.ok(h.healthWrites.length > 1);
  assert.equal(h.healthWrites.some((record) => record.stopped), false);
  await assert.rejects(readFile(h.paths.attentionHealthPath), { code: 'ENOENT' });
});

test('toasts are still claimed and sent after a start with two carried crashes', async (t) => {
  const h = await harness(t, { windows: onWorkspace({ 101: 2 }) });
  await writeJsonAtomic(h.paths.attentionHealthPath, predecessor({ writtenAt: START - 1000, crashedAt: [START - 2000] }));
  await h.boot();
  assert.deepEqual(heartbeatsOf(h, 'coordinator-1')[0].crashedAt, [START - 2000, START - 1000]);
  await h.capture('codex', 'PermissionRequest', { session: 'a' }, 101);
  h.touch('attention.json');
  await h.until(async () => h.calls.toasts.length === 1, 'one toast');
  await h.until(async () => episodeOf(await h.state(), 'codex:a').delivery.toast.status === 'delivered', 'delivered');
  assert.equal(await h.stop(), 0);
});

test('a late heartbeat cannot overwrite the final record', async (t) => {
  const h = await harness(t);
  await h.boot();
  const before = h.healthWrites.length;
  const release = h.holdHealthWrite();
  await h.clock.advance(2000);
  assert.equal(h.healthWrites.length, before + 1);
  const held = h.healthWrites.at(-1);
  h.signals.emit('SIGTERM');
  await h.clock.advance(100);
  await h.settle();
  const finalIssuedWhileBeatHeld = h.healthWrites.some((record) => record.stopped);
  release();
  assert.equal(await h.exit(), 0);
  assert.equal(finalIssuedWhileBeatHeld, false);
  assert.deepEqual(h.healthWrites.slice(-2), [held, { ...held, stopped: true }]);
  assert.deepEqual(await readHealthFile(h), { ...held, stopped: true });
});

test('an unreadable health record resets the history and starts normally', async (t) => {
  const h = await harness(t);
  await mkdir(h.paths.attentionHealthPath, { recursive: true });
  await h.boot();
  assert.equal(unusableLines(h), 1, h.stderr());
  assert.ok(h.calls.windows > 0);
  const feed = JSON.parse(await readFile(niriWorkspacesPath(h.paths), 'utf8'));
  assert.equal(feed.connected, true);
  // Its own heartbeats cannot replace a directory either.
  assert.match(h.stderr(), /heartbeat:/);
  assert.equal(h.writes.some((write) => write.path === h.paths.attentionHealthPath), false);
  assert.equal(await h.stop(), 0);
});

test('a stop during recovery exits 0 with no heartbeat and leaves the predecessor record', async (t) => {
  const h = await harness(t);
  await writeJsonAtomic(h.paths.attentionHealthPath, predecessor());
  const seeded = await readFile(h.paths.attentionHealthPath, 'utf8');
  let release;
  const held = withLock(h.paths.presentationLockPath, () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const running = h.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const handlersDuringRecovery = h.signals.count();
  h.signals.emit('SIGTERM');
  release();
  await held;
  assert.equal(handlersDuringRecovery, 2);
  assert.equal(await h.exit(running), 0);
  assert.equal(await readFile(h.paths.attentionHealthPath, 'utf8'), seeded);
  assert.equal(h.healthWrites.length, 0);
  assert.equal(h.watcher(), null);
  assert.equal(h.calls.eventStreams, 0);
  assert.equal(h.clock.pending(), 0);
  assert.equal(h.signals.count(), 0);
  await assert.rejects(readFile(niriWorkspacesPath(h.paths)), { code: 'ENOENT' });
});

test('recovery logs what it gave up', async (t) => {
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
    const next = structuredClone(state);
    // a is only reserved, b only queued.
    next.episodes[episodeOf(state, 'codex:a').id].delivery.popup = { status: 'suppressed' };
    next.episodes[episodeOf(state, 'codex:b').id].delivery.toast = { status: 'eligible' };
    return { state: next, result: null };
  });
  await h.boot();
  assert.match(h.stderr(), /recover: suppressed 1 queued, 1 uncertain/);
  assert.equal(await h.stop(), 0);
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

test('the first heartbeat names the coordinator the saved state already records', async (t) => {
  const h = await harness(t);
  await mutateAttention({ paths: h.paths }, async (state) => reduceAttention(state, { type: 'desktop', instanceId: 'old-instance',
    status: 'known', dnd: 'off', workspaces: [], origins: {}, enrichment: {}, now: h.clock.now() }));
  const instances = [];
  const write = h.deps.writeAtomic;
  h.deps.writeAtomic = async (path, value) => {
    if (path === h.paths.attentionHealthPath) instances.push(JSON.parse(readFileSync(h.paths.attentionPath, 'utf8')).desktop.instanceId);
    return write(path, value);
  };
  await h.boot();
  assert.ok(instances.length > 0);
  assert.ok(instances.every((instance) => instance === 'coordinator-1'), JSON.stringify(instances));
  await h.stop();
});

test('an unknown DND is reported when it starts, not on every pass', async (t) => {
  const h = await harness(t, { dnd: () => 'maybe', windows: onWorkspace({ 101: 2 }) });
  await h.boot();
  for (let i = 0; i < 5; i++) {
    h.touch('sessions.json');
    await h.clock.advance(300);
  }
  await h.quiesce();
  assert.equal(h.stderr().split('do not disturb status unavailable').length - 1, 1, h.stderr());
  await h.stop();
});
