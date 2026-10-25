// The one desktop attention coordinator: a singleton that owns Niri attribution, the
// lock-free workspace feed, the heartbeat, and toast delivery. Its parts run on
// separate paths on purpose. The workspace feed is published straight from Niri's
// event stream, so a switcher never waits on the presentation lock, the theme or
// notification IPC. The heartbeat has its own file and timer, so a held lock or a
// quiet desktop never looks like a dead coordinator. Attention work is debounced,
// takes the lock only for a real change, and does its IPC outside it.
// Spec: docs/specs/2026-10-24-desktop-attention-design.md.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { reduceAttention } from '../../src/attention/model.js';
import {
  carriedCrashes, mutateAttention, normaliseCrashes, readAttention, readHealthRecord, writeHealth,
} from '../../src/attention/store.js';
import { readJson, writeJsonAtomic } from '../../src/bus/store.js';
import { withLock } from '../../src/bus/lock.js';
import { readDnd, sendToast } from '../noctalia/adapter.js';
import { projectDesktop, resolvePresentations } from './attention.js';
import { createLatestWriter, niriWorkspacesPath, reduceTopology } from './topology.js';
import { shouldResync } from './window.js';

const DEBOUNCE_MS = 100;
const FRESHNESS_MS = 1000;
const HEARTBEAT_MS = 2000;
const WINDOWS_TIMEOUT_MS = 2000;

const SUMMARY = {
  'needs-input': 'Agent needs input',
  'needs-approval': 'Approval requested — response unconfirmed',
  error: 'Agent error',
  completion: 'Agent finished its turn',
};

const queuedIds = (state) => Object.values(state.episodes)
  .filter((episode) => ['popup', 'toast'].some((surface) => ['pending', 'eligible'].includes(episode.delivery[surface].status)))
  .map((episode) => episode.id);

// What attribution depends on. Focus and activity flags change constantly and are the
// focus path's business, so they never make a resync rewrite the attention file.
const attribution = (desktop) => JSON.stringify({
  instanceId: desktop.instanceId, status: desktop.status, dnd: desktop.dnd, origins: desktop.origins,
  enrichment: desktop.enrichment,
  workspaces: desktop.workspaces.map(({ id, idx, name, output }) => ({ id, idx, name, output })),
});
const unclassified = (state) => Object.values(state.episodes).some((episode) => !episode.closed
  && episode.delivery.popup.status === 'pending' && episode.delivery.toast.status === 'pending');

// Generic text only: kinds, counts, project labels and the workspace label.
function toastFor(state, ids) {
  const episodes = ids.map((id) => state.episodes[id]);
  const kinds = new Set(episodes.map((episode) => episode.kind));
  const onlyCompletions = kinds.size === 1 && kinds.has('completion');
  const summary = episodes.length === 1 ? SUMMARY[episodes[0].kind]
    : onlyCompletions ? `${episodes.length} agent turns finished` : `${episodes.length} agents need attention`;
  const projects = [...new Set(episodes.map((episode) => state.desktop.enrichment[episode.id]?.project ?? 'agent session'))];
  const origin = episodes[0].rootKey === null ? undefined : state.desktop.origins[episodes[0].rootKey];
  const workspace = origin && state.desktop.workspaces.find((row) => row.id === origin.workspaceId);
  const where = workspace ? `workspace ${workspace.name ?? workspace.idx}` : 'workspace unknown';
  return { app_name: 'familiar', summary, body: `${projects.join(', ')} · ${where}`, urgency: onlyCompletions ? 'low' : 'normal' };
}

// One attention pass: windows, DND and identity are read outside the lock; the desktop
// projection is written under it only when attribution actually changed; then toasts.
function attentionPass({ paths, execFile, lockWith, loadContext, relay, clock, instanceId, log, syncWindows, topology, stopped }) {
  const mutate = (fn) => mutateAttention({ paths, lockWith }, fn);
  let dnd;
  let dndError = null;
  let lastDiagnostics = '';

  const resync = async () => {
    if (stopped()) return;
    let windows = [];
    try {
      const { stdout } = await execFile('niri', ['msg', '-j', 'windows'], { timeout: WINDOWS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
      windows = JSON.parse(stdout);
      if (!Array.isArray(windows)) throw new Error('reply is not a list');
    } catch (error) {
      // No mapping is better than a stale one: attribution is withdrawn, not kept.
      windows = [];
      log(`windows: ${error.message}`);
    }
    if (syncWindows) await syncWindows(windows).catch((error) => log(error.message));
    dnd = await readDnd({ execFile }).then((answer) => {
      dndError = null;
      return answer;
    }, (error) => {
      if (error.message !== dndError) log(error.message);
      dndError = error.message;
      return 'unknown';
    });
    const intent = (await readJson(paths.intentPath).catch(() => null)) ?? {};
    const view = await readAttention(paths);
    const { presentations, diagnostics } = await resolvePresentations({ state: view, intent, loadContext });
    if (diagnostics.join('\n') !== lastDiagnostics) {
      lastDiagnostics = diagnostics.join('\n');
      for (const line of diagnostics) log(line);
    }
    const current = topology();
    const workspaces = current?.connected ? current.workspaces : null;
    const desktopFor = (state) => projectDesktop({
      state, windows, workspaces, presentations, dnd, instanceId, now: clock.now(), ancestors: relay.ancestors,
    });
    const projected = desktopFor(view);
    if (attribution(view.desktop) !== attribution(projected) || (projected.status === 'known' && unclassified(view))) {
      // Re-projected from the locked state, so a source captured meanwhile is
      // classified with its own origin rather than as unmapped.
      await mutate(async (state) => reduceAttention(state, desktopFor(state)));
    }
    await dispatchToasts();
  };

  // One claim reserves every eligible toast before any IPC; then one summary per
  // workspace, each rechecked just before its send so dismissed or closed work is
  // never announced. A send already started is allowed to finish.
  const dispatchToasts = async () => {
    if (dnd !== 'off' || stopped()) return;
    const view = await readAttention(paths);
    if (view.desktop.instanceId !== instanceId || view.desktop.status !== 'known' || view.desktop.dnd !== 'off') return;
    if (!Object.values(view.episodes).some((episode) => !episode.closed && !episode.dismissed && episode.delivery.toast.status === 'eligible')) return;
    const token = randomUUID();
    const { state, result } = await mutate(async (locked) => reduceAttention(locked, {
      type: 'claim', surface: 'toast', consumerId: instanceId, token, now: clock.now(),
    }));
    if (result.token === null) return;
    const groups = new Map();
    for (const id of result.ids) {
      const rootKey = state.episodes[id].rootKey;
      const where = (rootKey === null ? undefined : state.desktop.origins[rootKey]?.workspaceId) ?? '';
      groups.set(where, [...(groups.get(where) ?? []), id]);
    }
    const settle = (ids, outcome) => mutate(async (locked) => reduceAttention(locked, {
      type: 'finish', surface: 'toast', token, outcome, ids, now: clock.now(),
    }));
    for (const ids of groups.values()) {
      const current = await readAttention(paths);
      const live = ids.filter((id) => {
        const episode = current.episodes[id];
        return episode && !episode.closed && !episode.dismissed && episode.delivery.toast.token === token;
      });
      const dropped = ids.filter((id) => !live.includes(id));
      if (dropped.length) await settle(dropped, 'suppressed');
      if (live.length === 0) continue;
      let outcome = 'delivered';
      try {
        await sendToast({ payload: toastFor(current, live), execFile });
      } catch (error) {
        log(error.message);
        outcome = 'failed';
      }
      await settle(live, outcome);
    }
  };

  // DND has no event of its own: it is polled, and a change triggers a pass.
  const dndChanged = async () => {
    const answer = await readDnd({ execFile }).catch(() => 'unknown');
    return answer !== dnd;
  };

  return { resync, dndChanged };
}

// Whatever an earlier instance reserved may or may not have been shown, and what it
// had queued is history now. Neither is replayed.
const recover = ({ paths, lockWith, instanceId, clock }) => mutateAttention({ paths, lockWith }, async (state) => reduceAttention(state, {
  type: 'recover', instanceId, ids: queuedIds(state), now: clock.now(),
}));
// What a start gave up, so the journal shows what each crash cost.
const recovered = ({ result }) => `recover: suppressed ${result.suppressedIds.length} queued, ${result.uncertainIds.length} uncertain`;

const SINGLETON = { staleMs: Infinity, retries: 1 };
const refused = (error) => /could not acquire lock/.test(error.message);

export async function runCoordinator({
  paths, relay, execFile, watch, clock, signals, writeAtomic = writeJsonAtomic, stderr,
  eventStream, lockWith = withLock, loadContext, liveEpoch, instanceId = randomUUID(), owner,
  syncWindows = null,
}) {
  try {
    // Held for the coordinator's whole life. Only a dead holder is reclaimed: a live
    // one is never stale however long it has run.
    return await lockWith(paths.attentionCoordinatorLockPath, () => lifetime({
      paths, relay, execFile, watch, clock, signals, writeAtomic, stderr, eventStream, lockWith,
      loadContext, liveEpoch, instanceId, owner, syncWindows,
    }), SINGLETON);
  } catch (error) {
    if (refused(error)) throw new Error('attention: another coordinator is already running');
    throw error;
  }
}

async function lifetime({
  paths, relay, execFile, watch, clock, signals, writeAtomic, stderr, eventStream, lockWith,
  loadContext, liveEpoch, instanceId, owner, syncWindows,
}) {
  const log = (message) => stderr.write(`familiar-niri: ${message}\n`);
  const epoch = liveEpoch();
  let exitCode = null;
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const stop = (code) => {
    if (exitCode !== null) return;
    exitCode = code;
    finished();
  };
  // Registered before recovery, which can wait on the presentation lock: a stop that
  // arrives meanwhile takes effect when recovery returns, before anything has started.
  const onSignal = () => stop(0);
  const unregister = () => {
    signals.off('SIGTERM', onSignal);
    signals.off('SIGINT', onSignal);
  };
  signals.on('SIGTERM', onSignal);
  signals.on('SIGINT', onSignal);
  try {
    // Read under the singleton lock and before recovery, so no other coordinator can
    // change the record meanwhile.
    const carried = carriedCrashes(await readHealthRecord(paths), epoch);
    if (carried.unusable) log('health record unusable; crash history reset');
    const history = carried.crashedAt;
    log(recovered(await recover({ paths, lockWith, instanceId, clock })));
    if (exitCode !== null) return 0;

    const feed = createLatestWriter({ path: niriWorkspacesPath(paths), writeAtomic, onError: (error) => log(`workspace feed: ${error.message}`) });
    let topology = null;
    const mutate = (fn) => mutateAttention({ paths, lockWith }, fn);
    const pass = attentionPass({
      paths, execFile, lockWith, loadContext, relay, clock, instanceId, log, syncWindows,
      topology: () => topology, stopped: () => exitCode !== null,
    });
    const resync = pass.resync;
    const pollDnd = async () => {
      if (await pass.dndChanged() && exitCode === null) schedule();
    };

    // Each heartbeat restates the carried history against the clock reading that becomes
    // its `writtenAt`. Every write still in flight is tracked, and the last one that
    // landed is what a clean stop marks stopped.
    let lastWritten = null;
    let inFlight = Promise.resolve();
    const beat = () => {
      const now = clock.now();
      const health = { schema: 2, instanceId, epoch, owner, writtenAt: now, stopped: false, crashedAt: normaliseCrashes(history, now) };
      const write = writeHealth({ paths, writeAtomic, health })
        .then(() => { lastWritten = health; }, (error) => log(`heartbeat: ${error.message}`));
      inFlight = Promise.all([inFlight, write]).then(() => {});
    };

    let chain = Promise.resolve();
    let pending = null;
    const run = (task) => {
      chain = chain.then(task).catch((error) => log(`attention: ${error.message}`));
      return chain;
    };
    function schedule() {
      if (exitCode !== null) return;
      clock.clearTimeout(pending);
      pending = clock.setTimeout(() => {
        pending = null;
        run(resync);
      }, DEBOUNCE_MS);
    }

    // A visit marks seen only what it found unseen there, rechecked under the lock; with
    // nothing unseen on the focused workspace no lock is taken at all.
    let focusChain = Promise.resolve();
    const onFocus = async (workspaceId) => {
      const view = await readAttention(paths);
      const seenIds = Object.values(view.episodes).filter((episode) => !episode.closed && !episode.seen && !episode.dismissed
        && episode.rootKey !== null && view.desktop.origins[episode.rootKey]?.workspaceId === workspaceId).map((episode) => episode.id);
      if (seenIds.length === 0) return;
      const rows = topology?.connected ? topology.workspaces : null;
      await mutate(async (state) => reduceAttention(state, {
        type: 'desktop', ...state.desktop, ...(rows ? { workspaces: rows } : {}), seenIds, now: clock.now(),
      }));
    };

    const watched = new Set([basename(paths.sessionsPath), basename(paths.intentPath), basename(paths.attentionPath)]);
    const watcher = watch(paths.stateDir, (_event, file) => {
      if (watched.has(file)) schedule();
    });

    beat();
    const heartbeat = clock.setInterval(() => {
      beat();
      pollDnd();
    }, HEARTBEAT_MS);
    const freshness = clock.setInterval(() => {
      if (topology !== null) feed.publish({ ...topology, writtenAt: clock.now() });
    }, FRESHNESS_MS);
    run(resync);

    const stream = eventStream();
    const consumed = (async () => {
      for await (const line of stream.lines) {
        if (exitCode !== null) return null;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // a non-JSON banner line
        }
        try {
          const next = reduceTopology(topology, event, { now: clock.now(), instanceId, epoch });
          if (next !== topology) {
            topology = next;
            feed.publish(topology);
          }
        } catch (error) {
          return error.message;
        }
        const activated = event.WorkspaceActivated;
        if (activated?.focused === true) {
          focusChain = focusChain.then(() => onFocus(String(activated.id))).catch((error) => log(`focus: ${error.message}`));
        }
        if (shouldResync(event)) schedule();
      }
      return 'niri event stream closed';
    })();
    consumed.then((reason) => {
      if (reason === null || exitCode !== null) return;
      log(reason);
      stop(1);
    });

    await done;
    clock.clearInterval(heartbeat);
    clock.clearInterval(freshness);
    clock.clearTimeout(pending);
    watcher.close();
    stream.close();
    unregister();
    // A heartbeat already started lands before anything that follows, so it can never
    // replace the final record.
    await inFlight;
    if (exitCode !== 0 && topology !== null) await feed.publish({ ...topology, connected: false, writtenAt: clock.now() });
    await chain;
    await focusChain;
    await feed.idle();
    // A clean stop marks the last heartbeat that landed as stopped, its `writtenAt` and
    // history unchanged, so a stopped coordinator is not refreshed into looking healthy.
    // With none, the predecessor's record stands. A failed write leaves `stopped` false,
    // counted as the crash it then looks like.
    if (exitCode === 0 && lastWritten !== null) {
      await writeHealth({ paths, writeAtomic, health: { ...lastWritten, stopped: true } })
        .catch((error) => log(`final heartbeat: ${error.message}`));
    }
    return exitCode;
  } finally {
    // Also on a stop during recovery and on a throw before the main loop.
    unregister();
  }
}

// `familiar-niri sync`: one attention pass from a workspace query, as a short-lived
// coordinator. It recovers like any other instance, so it never replays a queue; while
// a long-running coordinator holds the singleton it leaves attention to that one.
export async function syncOnce({
  paths, relay, execFile, clock, stderr, lockWith = withLock, loadContext, liveEpoch,
  instanceId = randomUUID(),
}) {
  const log = (message) => stderr.write(`familiar-niri: ${message}\n`);
  try {
    return await lockWith(paths.attentionCoordinatorLockPath, async () => {
      await recover({ paths, lockWith, instanceId, clock });
      let topology = null;
      try {
        const { stdout } = await execFile('niri', ['msg', '-j', 'workspaces'], { timeout: WINDOWS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
        topology = reduceTopology(null, { WorkspacesChanged: { workspaces: JSON.parse(stdout) } }, { now: clock.now(), instanceId, epoch: liveEpoch() });
      } catch (error) {
        log(`workspaces: ${error.message}`);
      }
      const pass = attentionPass({
        paths, execFile, lockWith, loadContext, relay, clock, instanceId, log, syncWindows: null,
        topology: () => topology, stopped: () => false,
      });
      await pass.resync();
      return 0;
    }, SINGLETON);
  } catch (error) {
    if (!refused(error)) throw error;
    log('a coordinator is running; it keeps attention current');
    return 0;
  }
}
