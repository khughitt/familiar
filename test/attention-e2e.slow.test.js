// Desktop attention end to end: relay's public applyEvent/readSnapshot publish real
// rows for real (stand-in) agent processes; familiar's observer captures them; the real
// `familiar-niri watch` coordinator attributes them through fake `niri` and `noctalia`
// executables; the real CLI serves the popup protocol to the production QML logic; and
// the production Luau presentation draws the markers. Every subprocess environment is
// built key by key. This proves the pipeline's contracts, not Wayland layout, native
// gestures, notification display or native scheduling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { applyEvent, createProcessOps, normalizeEvent, readSnapshot } from 'relay';
import { loadThemePack } from 'familiar-theme';
import { observe } from '../src/observe/run.js';
import { paths as familiarPaths } from '../src/bus/paths.js';
import { writeJsonAtomic } from '../src/bus/store.js';
import { runLuau } from './helpers/luau.mjs';

const skip = process.platform !== 'linux' ? 'requires Linux /proc ancestry' : false;
const FAMILIAR = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const NIRI_BIN = fileURLToPath(new URL('../bin/familiar-niri', import.meta.url));
const THEME = fileURLToPath(new URL('fixtures/theme-pack', import.meta.url));
const LOGIC = fileURLToPath(new URL('../integrations/niri-desktop/logic.js', import.meta.url));
const SOCKET = '/run/user/1000/niri-e2e.sock';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processOps = createProcessOps();

const niriRow = (id, idx, output, extra = {}) => ({
  id, idx, name: null, output, is_urgent: false, is_active: false, is_focused: false, active_window_id: 1, ...extra,
});
const WORKSPACES = [niriRow(10, 1, 'DP-1', { is_active: true, is_focused: true }), niriRow(11, 2, 'DP-1'),
  niriRow(20, 1, 'HDMI-A-1', { is_active: true }), niriRow(21, 2, 'HDMI-A-1')];

const FAKE_NIRI = `#!${process.execPath}
import { readFileSync } from 'node:fs';
const fake = JSON.parse(readFileSync(process.env.FAKE_DESKTOP, 'utf8'));
const args = process.argv.slice(2).join(' ');
if (args === 'msg -j windows') process.stdout.write(JSON.stringify(fake.windows));
else if (args === 'msg -j workspaces') process.stdout.write(JSON.stringify(fake.workspaces));
else if (args === 'msg -j event-stream') {
  process.stdout.write(JSON.stringify({ WorkspacesChanged: { workspaces: fake.workspaces } }) + '\\n');
  const parent = process.ppid;
  // An orphaned stream exits instead of outliving its coordinator.
  setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 100);
} else process.exit(0);
`;
const FAKE_NOCTALIA = `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const fake = JSON.parse(readFileSync(process.env.FAKE_DESKTOP, 'utf8'));
const [, command, payload] = process.argv.slice(2);
if (command === 'notification-dnd-status') process.stdout.write(fake.dnd + '\\n');
else if (command === 'notification-show') {
  appendFileSync(process.env.FAKE_TOASTS, payload + '\\n');
  if (fake.toastDelayMs) setTimeout(() => {}, fake.toastDelayMs);
} else process.exit(2);
`;

async function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'familiar-attention-e2e-'));
  const relayDir = join(root, 'relay');
  const fakeBin = join(root, 'bin');
  const themes = join(root, 'themes');
  const config = join(root, 'config');
  for (const dir of [relayDir, fakeBin, themes, config]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  cpSync(THEME, join(themes, 'cats'), { recursive: true });
  writeFileSync(join(config, 'config.yaml'), 'theme: cats\nmotion: full\n');
  writeFileSync(join(config, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(fakeBin, 'niri'), FAKE_NIRI, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'noctalia'), FAKE_NOCTALIA, { mode: 0o755 });
  const fakePath = join(root, 'desktop.json');
  const toastsPath = join(root, 'toasts.log');
  writeFileSync(toastsPath, '');
  const env = {
    PATH: fakeBin, HOME: root, FAMILIAR_STATE_DIR: join(root, 'state'), FAMILIAR_CONFIG_DIR: config,
    FAMILIAR_THEMES_DIR: themes, NIRI_SOCKET: SOCKET, FAKE_DESKTOP: fakePath, FAKE_TOASTS: toastsPath,
  };
  const paths = familiarPaths(env);
  const relayPaths = { stateDir: relayDir, agentsPath: join(relayDir, 'agents.json'), lockPath: join(relayDir, 'agents.lock') };
  const owned = [];
  const agents = [];
  const kill = async (child, signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    await once(child, 'exit');
  };
  t.after(async () => {
    for (const pid of agents) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    for (const child of owned) await kill(child);
    rmSync(root, { recursive: true, force: true });
  });
  // A terminal (sh) hosting an agent (sleep), so ancestry is real /proc ancestry.
  const terminal = async () => {
    // The agent gets no stdout, so killing it closes everything this test holds.
    const shell = spawn('sh', ['-c', 'sleep 600 >/dev/null 2>&1 & echo $!; wait'], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] });
    owned.push(shell);
    const [chunk] = await once(shell.stdout, 'data');
    const agent = Number(String(chunk).trim());
    agents.push(agent);
    return { terminal: shell.pid, agent };
  };
  const t1 = await terminal();
  const t2 = await terminal();
  const desktop = { workspaces: WORKSPACES, dnd: 'off', windows: [
    { id: 7, pid: t1.terminal, workspace_id: 21 }, { id: 8, pid: t2.terminal, workspace_id: 11 },
  ] };
  const setDesktop = (change) => writeFileSync(fakePath, JSON.stringify(Object.assign(desktop, change)));
  setDesktop({});
  const pack = await loadThemePack(join(themes, 'cats'));
  const deps = {
    paths, relay: { readSnapshot: () => readSnapshot({ paths: relayPaths }) }, relayProcess: processOps,
    renderProcess: { startTimeOf: () => 20, ownerAlive: () => true, lockHolderAlive: () => true, pidExists: () => true },
    adapterFor: () => ({ resolveSessionPid: () => t1.agent, resolveTerminalPid: () => t1.terminal }),
    gitContext: async () => ({ remote: null, repoRoot: null, repositoryRoot: null }),
    lookupProjectColor: async () => ({ color: null, warnings: [] }),
    loadContext: async () => ({ paths, pack, catalog: { identities: [] }, tone: { mode: 'dark', satScale: 1 }, motionPolicy: 'full' }),
    emitTransition: async (args) => ({ kind: args.next ? 'unchanged' : 'ended' }),
  };
  // A harness hook: relay publishes the row, then familiar's observer runs.
  const hook = async (harness, native, ids, host) => {
    const data = { session_id: ids.session, cwd: root, ...(ids.worker ? { agent_id: ids.worker } : {}) };
    if (native === 'PreToolUse') Object.assign(data, { tool_name: 'Read', tool_input: {} });
    const event = normalizeEvent(harness, native, JSON.stringify(data));
    const result = await applyEvent(event, { paths: relayPaths, processOps, resolveSessionPid: () => host.agent,
      gitContext: async () => ({ remote: null, repoRoot: null }) });
    const envelope = { schema: 1, type: 'event', subscriber: 'familiar', event: { ...event, tool: event.tool ? { name: event.tool.name } : null },
      registry: { generation: result.snapshot?.generation ?? null, revision: result.snapshot?.revision ?? null }, changed: true, reaped: [] };
    return observe({ text: JSON.stringify(envelope), deps });
  };
  const reconcile = async () => {
    const snapshot = await readSnapshot({ paths: relayPaths });
    return observe({ text: JSON.stringify({ schema: 1, type: 'reconcile', subscriber: 'familiar', event: null,
      registry: { generation: snapshot?.generation ?? null, revision: snapshot?.revision ?? null }, changed: false, reaped: [] }), deps });
  };
  const cli = (args, input) => new Promise((resolve) => {
    const child = execFile(process.execPath, [FAMILIAR, ...args], { encoding: 'utf8', env: { ...env, PATH: '/usr/bin:/bin' } },
      (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
  });
  const status = async () => {
    const result = await cli(['attention', 'status']);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  let coordinator = null;
  let coordinatorLog = '';
  const startCoordinator = async () => {
    coordinator = spawn(process.execPath, [NIRI_BIN, 'watch'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    owned.push(coordinator);
    coordinator.stderr.on('data', (chunk) => { coordinatorLog += chunk; });
    await until(async () => existsSync(paths.attentionHealthPath) && (await status()).health.status === 'healthy', 'a healthy coordinator');
  };
  const stopCoordinator = (signal) => kill(coordinator, signal);
  const until = async (predicate, what, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await sleep(50);
    }
    assert.fail(`${what} within ${ms} ms; coordinator: ${coordinatorLog}`);
  };
  const toasts = () => readFileSync(toastsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, env, paths, t1, t2, hook, reconcile, cli, status, startCoordinator, stopCoordinator, until, toasts, setDesktop, coordinatorLog: () => coordinatorLog };
}

// The production popup logic, driven exactly as the QML shell drives it.
function popupConsumer(w) {
  const source = readFileSync(LOGIC, 'utf8').replace(/^\s*\.pragma\s+library\s*$/m, '');
  const L = {};
  vm.runInNewContext(source, L);
  const consumerId = 'popup-e2e';
  let active;
  const live = () => ({ now: Date.now(), bootId: processOps.handleOf(process.pid).bootId, desktopSession: SOCKET });
  const request = async (body) => {
    const result = await w.cli(['attention', 'popup'], L.encodeRequest(body));
    const parsed = L.parseReply(result.stdout, body.op);
    assert.equal(parsed.error, null, `${body.op}: ${result.stderr}`);
    return parsed.reply;
  };
  return {
    // One pass of the shell's evaluate(): attach, or claim, play and finish one moment.
    async step() {
      const state = JSON.parse(readFileSync(w.paths.attentionPath, 'utf8'));
      const health = existsSync(w.paths.attentionHealthPath) ? readFileSync(w.paths.attentionHealthPath, 'utf8') : '';
      const decision = L.nextMoment(L.viewOf(state, health, live()), active);
      if (decision.action === 'initialise') {
        for (const ids of L.initialBatches(state)) await request({ op: 'initialise', consumerId, ids });
        active = null;
        return 'attached';
      }
      if (decision.action !== 'claim') return decision.action;
      const reply = await request({ op: 'claim', consumerId });
      if (reply.job === null) return 'none';
      const playback = L.playbackFor(reply.job);
      // As the shell does: missing art fails the popup, motion off draws nothing.
      const outcome = playback.error !== null ? 'failed' : playback.draw ? 'delivered' : 'suppressed';
      await request({ op: 'finish', consumerId, token: reply.token, outcome });
      return reply.job.episodeId;
    },
    async drain() {
      const played = [];
      for (;;) {
        const outcome = await this.step();
        if (outcome === 'none') return played;
        if (outcome !== 'attached') played.push(outcome);
      }
    },
  };
}

const settled = (state) => Object.values(state.episodes).every((e) => e.closed
  || !['pending', 'eligible', 'reserved'].includes(e.delivery.toast.status));

test('one marker, one popup and one toast per episode, through repeat, rename, reconcile and restart', { skip, timeout: 120_000 }, async (t) => {
  const w = await world(t);
  await w.hook('claude-code', 'SessionStart', { session: 'boot' }, w.t1);
  await w.startCoordinator();
  const popup = popupConsumer(w);
  assert.equal(await popup.step(), 'attached');
  // One event per capability each harness actually reports.
  const events = [
    ['claude-code', 'Notification:permission_prompt', { session: 'a' }, w.t1],
    ['claude-code', 'Notification:idle_prompt', { session: 'b' }, w.t1],
    ['codex', 'UserPromptSubmit', { session: 'c' }, w.t2],
    ['codex', 'SubagentStart', { session: 'c', worker: 'w1' }, w.t2],
    ['codex', 'PermissionRequest', { session: 'c', worker: 'w1' }, w.t2],
    ['opencode', 'session.error', { session: 'o' }, w.t2],
    ['codex', 'UserPromptSubmit', { session: 'd' }, w.t2],
    ['codex', 'Stop', { session: 'd' }, w.t2],
  ];
  for (const [harness, native, ids, host] of events) await w.hook(harness, native, ids, host);
  await w.until(async () => {
    const view = await w.status();
    return Object.keys(view.episodes).length === 5 && settled(view);
  }, 'classification and delivery');
  const first = await w.status();
  const played = await popup.drain();
  assert.deepEqual(played.sort(), Object.keys(first.episodes).sort(), 'one popup per episode');
  const drained = await w.status();
  for (const episode of Object.values(drained.episodes)) {
    assert.ok(['delivered', 'failed'].includes(episode.delivery.popup.status), `${episode.kind}: ${episode.delivery.popup.status}`);
  }
  // A burst may be summarised over several passes; together the summaries represent
  // each episode exactly once.
  const represented = (toasts) => toasts.reduce((sum, toast) => sum + (Number(toast.summary.match(/^(\d+) /)?.[1]) || 1), 0);
  const sent = w.toasts();
  assert.equal(represented(sent), 5);
  assert.ok(sent.every((toast) => toast.app_name === 'familiar'));
  for (const episode of Object.values(first.episodes)) {
    assert.equal(episode.delivery.toast.status, 'delivered', `${first.sources[episode.sourceKey].agentId} ${episode.kind} seen=${episode.seen}`);
  }
  const markers = runLuau(`
    local P = Host.module("presentation")
    local view = fixture("view")
    local pills = P.pillsFor(view, { workspaces = fixture("rows") }, nil, { now = 0 })
    local marked = {}
    for _, pill in pills do if pill.kind then marked[pill.workspaceId] = { kind = pill.kind, count = pill.count } end end
    emit(marked)
  `, { fixtures: { view: first, rows: first.desktop.workspaces } }).emitted[0];
  assert.deepEqual(markers, { 11: { kind: 'error', count: 3 }, 21: { kind: 'needs-approval', count: 2 } });

  // Duplicate delivery, rename, reconcile and a coordinator restart change nothing visible.
  for (const [harness, native, ids, host] of events.slice(4, 6)) await w.hook(harness, native, ids, host);
  await writeJsonAtomic(w.paths.attentionPath, JSON.parse(readFileSync(w.paths.attentionPath, 'utf8')));
  await w.reconcile();
  await w.stopCoordinator('SIGTERM');
  await w.startCoordinator();
  await sleep(1500);
  const after = await w.status();
  assert.deepEqual(Object.keys(after.episodes).sort(), Object.keys(first.episodes).sort());
  assert.equal(w.toasts().length, sent.length);
  assert.equal(represented(w.toasts()), 5);
  assert.deepEqual(await popup.drain(), []);
  for (const id of Object.keys(first.episodes)) {
    assert.deepEqual(after.episodes[id].delivery, drained.episodes[id].delivery, `${id} changed across repeat and restart`);
  }
});

test('unknown DND, a missing worker stop and a crash mid-send never replay; health stays independent', { skip, timeout: 120_000 }, async (t) => {
  const w = await world(t);
  await w.hook('claude-code', 'SessionStart', { session: 'boot' }, w.t1);
  await w.startCoordinator();
  // Unknown DND: dropped for good, and known/off later replays nothing.
  w.setDesktop({ dnd: 'maybe' });
  await sleep(2500);
  await w.hook('claude-code', 'Notification:permission_prompt', { session: 'a' }, w.t1);
  await w.until(async () => Object.values((await w.status()).episodes).some((e) => e.delivery.toast.status === 'suppressed'), 'suppression');
  w.setDesktop({ dnd: 'off' });
  await sleep(2500);
  assert.equal(w.toasts().length, 0);
  // A Codex root finishing while its worker never reported stopping: withheld, diagnosed, no toast.
  await w.hook('codex', 'UserPromptSubmit', { session: 'c' }, w.t2);
  await w.hook('codex', 'SubagentStart', { session: 'c', worker: 'w1' }, w.t2);
  await w.hook('codex', 'Stop', { session: 'c' }, w.t2);
  await w.until(async () => Object.keys((await w.status()).diagnostics).length === 1, 'the withheld-completion diagnostic');
  assert.equal(Object.values((await w.status()).episodes).some((e) => e.kind === 'completion'), false);
  // A crash after the reservation, mid-send: the restarted coordinator calls it uncertain.
  w.setDesktop({ toastDelayMs: 4000 });
  await w.hook('codex', 'PermissionRequest', { session: 'e' }, w.t2);
  await w.until(async () => w.toasts().length === 1, 'the send to start');
  await w.stopCoordinator('SIGKILL');
  w.setDesktop({ toastDelayMs: 0 });
  await w.startCoordinator();
  await sleep(1500);
  const view = await w.status();
  const reserved = Object.values(view.episodes).find((e) => view.sources[e.sourceKey].agentId === 'codex:e');
  assert.equal(reserved.delivery.toast.status, 'uncertain');
  assert.equal(w.toasts().length, 1, 'no replay after the crash');
  assert.equal(reserved.closed, false, 'the pending request survives the crash');
  // A corrupt attention file is never overwritten; the heartbeat goes on regardless.
  writeFileSync(w.paths.attentionPath, '{"schema":');
  const result = await w.hook('codex', 'PermissionRequest', { session: 'f' }, w.t2);
  assert.match(result.lines.join('\n'), /attention: corrupt attention state/);
  const beat = JSON.parse(readFileSync(w.paths.attentionHealthPath, 'utf8')).writtenAt;
  await sleep(2500);
  assert.ok(JSON.parse(readFileSync(w.paths.attentionHealthPath, 'utf8')).writtenAt > beat, 'heartbeat continues');
  assert.equal(readFileSync(w.paths.attentionPath, 'utf8'), '{"schema":');
});
