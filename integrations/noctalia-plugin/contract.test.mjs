// The Noctalia plugin's contract, executed: every production Luau entry and module runs
// under the pinned Luau 0.743 runtime inside test/fixtures/noctalia-host.luau, a mock of
// Noctalia 5.3.0's host. Fixtures are real: attention states from the production reducer
// and store writer, `familiar attention status` output from the real CLI, and workspace
// feeds from the coordinator's own reducer and latest-value writer. Mocked host
// contracts do not prove Wayland layout, gestures or native latency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthStatus as nodeHealthStatus } from '../../src/attention/store.js';
import { writeJsonAtomic } from '../../src/bus/store.js';
import { attentionByWorkspace } from '../niri/attention.js';
import { createLatestWriter, reduceTopology } from '../niri/topology.js';
import { createRegistry, nativeEvent, traceAttention } from '../../test/helpers/attention.js';
import { LUAU, requireLuau, runLuau } from '../../test/helpers/luau.mjs';

const BIN = fileURLToPath(new URL('../../bin/familiar', import.meta.url));
const MANIFEST = fileURLToPath(new URL('./plugin.toml', import.meta.url));
const HOME = '/home/tester';
const STATE = `${HOME}/.local/state/familiar`;
const BOOT = '11111111-1111-4111-8111-111111111111';
const SOCKET = '/run/user/1000/niri.wayland-1.sock';
const T0 = 1_000_000;
const EPOCH = { bootId: BOOT, desktopSession: SOCKET };
const bytesOf = (value) => `${JSON.stringify(value, null, 2)}\n`;

// --- fixtures -------------------------------------------------------------------------------

const niriRow = (id, idx, output, extra = {}) => ({
  id, idx, name: null, output, is_urgent: false, is_active: false, is_focused: false, active_window_id: 1, ...extra,
});
// Output A (DP-1) is focused on 10; output B (HDMI-A-1) also has a workspace at index 2.
const OUTPUTS = [
  niriRow(10, 1, 'DP-1', { is_active: true, is_focused: true }), niriRow(11, 2, 'DP-1', { name: 'code' }),
  niriRow(20, 1, 'HDMI-A-1', { is_active: true }), niriRow(21, 2, 'HDMI-A-1', { is_urgent: true }),
];
const topologyAt = (writtenAt, rows = OUTPUTS, extra = {}) => ({
  ...reduceTopology(null, { WorkspacesChanged: { workspaces: rows } }, { now: writtenAt, instanceId: 'coordinator-1', epoch: EPOCH }),
  ...extra,
});
const healthAt = (writtenAt, extra = {}) => ({ schema: 1, instanceId: 'coordinator-1', epoch: EPOCH, owner: { pid: 77, start: '1' }, writtenAt, ...extra });

// A live desktop: an approval from codex root `a` on output B's workspace 21, a Claude
// input on output A's 11, a Codex worker approval and a withheld completion on 11.
function attentionScene() {
  const t = traceAttention({ start: T0 - 100_000 });
  const r = createRegistry({ now: () => t.now });
  t.observe([]);
  const send = (harness, native, ids) => {
    const event = nativeEvent(harness, native, ids);
    r.apply(event);
    t.observe(r.rows(), event);
  };
  send('codex', 'PermissionRequest', { session: 'a' });
  send('claude-code', 'Notification:idle_prompt', { session: 'b' });
  send('codex', 'UserPromptSubmit', { session: 'c' });
  send('codex', 'SubagentStart', { session: 'c', worker: 'w1' });
  send('codex', 'PermissionRequest', { session: 'c', worker: 'w1' });
  send('codex', 'Stop', { session: 'c' });
  t.desktop({ focused: '10', origins: { 'codex:a': '21', 'claude-code:b': '11', 'codex:c': '11' } });
  return { t, send, r };
}

// Files, decoded literals and environment for one Luau run. `events` replace a file's
// bytes at a virtual time; every byte string gets its decoded literal.
function desktop({ state, topology, health, events = [], env = {}, extraDecoded = [] }) {
  const files = { '/proc/sys/kernel/random/boot_id': `${BOOT}\n` };
  const decoded = {};
  const put = (target, path, value) => {
    if (value === undefined) return;
    const bytes = typeof value === 'string' ? value : bytesOf(value);
    target[path] = bytes;
    if (typeof value !== 'string') decoded[bytes] = value;
  };
  put(files, `${STATE}/attention.json`, state);
  put(files, `${STATE}/niri-workspaces.json`, topology);
  put(files, `${STATE}/attention-health.json`, health);
  const timed = events.map(({ at, file, value }) => {
    const bytes = value === null ? null : (typeof value === 'string' ? value : bytesOf(value));
    if (value !== null && typeof value !== 'string') decoded[bytes] = value;
    return { at, path: `${STATE}/${file}`, ...(bytes === null ? { remove: true } : { bytes }) };
  });
  for (const value of extraDecoded) decoded[JSON.stringify(value)] = value;
  return { files, decoded, events: timed, env: { HOME, NIRI_SOCKET: SOCKET, ...env } };
}

const PRELUDE = `
local D = fixture("desktop")
for path, bytes in D.files do Host.files[path] = bytes end
for bytes, value in D.decoded do Host.decoded[bytes] = value end
for name, value in D.env do Host.env[name] = value end
for _, event in D.events do
  Host.at(event.at - Host.now, function()
    if event.remove then Host.files[event.path] = nil else Host.files[event.path] = event.bytes end
  end)
end
local P = Host.module("presentation")
local function argvOf(record) return record.argv end
`;
const luau = (body, fixtures) => runLuau(`${PRELUDE}\n${body}`, { fixtures: { desktop: desktop(fixtures) } });
const out = (result) => result.emitted;

// A steady, healthy desktop: feed refreshed every second, heartbeat every two.
function steady(state, until = 30_000, rows = OUTPUTS) {
  const events = [];
  for (let at = T0 + 1000; at <= T0 + until; at += 1000) events.push({ at, file: 'niri-workspaces.json', value: topologyAt(at, rows) });
  for (let at = T0 + 2000; at <= T0 + until; at += 2000) events.push({ at, file: 'attention-health.json', value: healthAt(at) });
  return { state, topology: topologyAt(T0, rows), health: healthAt(T0), events };
}

// --- prerequisites ----------------------------------------------------------------------------

test('the pinned Luau runtime is provisioned, and a missing one fails with its setup route', () => {
  assert.equal(requireLuau(), LUAU);
  const probe = spawnSync(LUAU, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(probe.error, undefined);
});

test('the manifest declares the plugin, its three entries and API level 34', () => {
  const manifest = readFileSync(MANIFEST, 'utf8');
  for (const line of ['id = "khughitt/familiar"', 'plugin_api = 34', 'id = "workspaces"', 'entry = "widget.luau"',
    'id = "alerts"', 'entry = "panel.luau"', 'id = "attention"', 'entry = "service.luau"']) {
    assert.ok(manifest.includes(line), line);
  }
  assert.match(manifest, /^version = "\d+\.\d+\.\d+"$/m);
  assert.match(manifest, /^dependencies = \["familiar"\]$/m);
  assert.equal(/middle\s*=/.test(manifest), false, 'middle click stays the host settings gesture');
});

// --- pure presentation, against the real producers ------------------------------------------------

test('validateView accepts the real CLI status JSON with its nulls dropped, and rejects bad schemas', async () => {
  const { t } = attentionScene();
  const dir = mkdtempSync(join(tmpdir(), 'familiar-plugin-status-'));
  try {
    await writeJsonAtomic(join(dir, 'attention.json'), t.state);
    const status = spawnSync(process.execPath, [BIN, 'attention', 'status'], { encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, FAMILIAR_STATE_DIR: dir, NIRI_SOCKET: SOCKET } });
    assert.equal(status.status, 0, status.stderr);
    const view = JSON.parse(status.stdout);
    assert.equal(view.health.record, null);
    const [result] = out(runLuau(`
      local P = Host.module("presentation")
      local view = fixture("view")
      local ok, err = P.validateView(view)
      local bad = table.clone(view)
      bad.schema = 2
      local _, badErr = P.validateView(bad)
      emit({ ok = ok ~= nil, err = err, badErr = badErr, recordDropped = view.health.record == nil,
        instanceKept = view.desktop.instanceId == "coordinator-1" })
    `, { fixtures: { view } }));
    assert.deepEqual(result, { ok: true, badErr: 'attention view: expected schema 1', recordDropped: true, instanceKept: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('healthStatus in Luau is the Node rule', () => {
  const live = { now: 55_000, instanceId: 'c1', bootId: 'b1', desktopSession: '/s' };
  const health = { schema: 1, instanceId: 'c1', epoch: { bootId: 'b1', desktopSession: '/s' }, owner: { pid: 7, start: '1' }, writtenAt: 50_000 };
  const cases = [
    [health, live], [null, live], [health, { ...live, now: 60_001 }], [{ ...health, writtenAt: 55_001 }, live],
    [{ ...health, schema: 2 }, live], [health, { ...live, instanceId: 'c2' }], [health, { ...live, bootId: null }],
    [{ ...health, extra: 1 }, live], [{ ...health, owner: { pid: 7, start: '01' } }, live],
  ];
  const expected = cases.map(([record, options]) => nodeHealthStatus(record, options));
  const [actual] = out(runLuau(`
    local P = Host.module("presentation")
    local results = {}
    for i, case in fixture("cases") do results[i] = P.healthStatus(case.record, case.live) end
    emit(results)
  `, { fixtures: { cases: cases.map(([record, options]) => ({ record, live: { ...options, bootId: options.bootId ?? undefined } })) } }));
  assert.deepEqual(actual, expected);
});

test('Luau marker rules agree with the Node statement of them on the same state', () => {
  const { t } = attentionScene();
  const node = attentionByWorkspace(t.state);
  const [luauView] = out(luau(`
    local view = Host.decoded[Host.files["${STATE}/attention.json"]]
    emit(P.attentionByWorkspace(view))
  `, { state: t.state }));
  // The fixture's encoder writes an empty table as {}; an empty ID list is still a list.
  const list = (ids) => (Array.isArray(ids) ? ids : []);
  const shape = (group) => ({ kind: group.kind ?? null, winnerId: group.winnerId ?? null, count: group.count,
    episodeIds: list(group.episodeIds), diagnosticIds: list(group.diagnosticIds) });
  for (const [workspace, group] of Object.entries(node.workspaces)) {
    assert.deepEqual(shape({ kind: null, winnerId: null, ...luauView.workspaces[workspace] }), shape(group), workspace);
  }
  assert.deepEqual(Object.keys(luauView.workspaces).sort(), Object.keys(node.workspaces).sort());
  assert.equal(node.workspaces['11'].kind, 'needs-approval'); // the worker's approval outranks the input
  assert.equal(node.workspaces['11'].diagnosticIds.length, 1);
});

test('pills are scoped to their output, keep native urgency apart and explain themselves', () => {
  const { t } = attentionScene();
  const [result] = out(luau(`
    local view = Host.decoded[Host.files["${STATE}/attention.json"]]
    local topology = Host.decoded[Host.files["${STATE}/niri-workspaces.json"]]
    local b = P.pillsFor(view, topology, "HDMI-A-1", { now = Host.now })
    local a = P.pillsFor(view, topology, "DP-1", { now = Host.now })
    local ids = {}
    for _, pill in b do table.insert(ids, pill.workspaceId) end
    local by = {}
    for _, pill in b do by[pill.workspaceId] = pill end
    for _, pill in a do by[pill.workspaceId] = pill end
    emit({ outputB = ids, urgent21 = by["21"].urgent, kind21 = by["21"].kind, accent21 = by["21"].accent,
      tooltip21 = by["21"].tooltip, tooltip11 = by["11"].tooltip, withheld11 = by["11"].withheld, label11 = by["11"].label,
      dismiss21 = P.dismissIds(by["21"]), dismiss11 = P.dismissIds(by["11"]), empty20 = by["20"].kind == nil })
  `, { state: t.state, topology: topologyAt(T0) }));
  const outputAWorkspace = '11';
  const pillsForOutputB = result.outputB.map((workspaceId) => ({ workspaceId }));
  assert.equal(pillsForOutputB.some((p) => p.workspaceId === outputAWorkspace), false);
  assert.deepEqual(result.outputB, ['20', '21']);
  assert.equal(result.urgent21, true);
  assert.equal(result.kind21, 'needs-approval');
  const view = { approvalLabel: result.tooltip21.split(' — ')[0] };
  assert.equal(view.approvalLabel, 'Approval requested — response unconfirmed'.split(' — ')[0]);
  assert.match(result.tooltip21, /^Approval requested — response unconfirmed — agent session, observed \d+ (s|min|h) ago/);
  assert.match(result.tooltip21, /Right-click to dismiss current alerts/);
  assert.match(result.tooltip11, /Claude sub-agents share one session here/);
  assert.match(result.tooltip11, /Completion withheld — worker status unconfirmed: codex:w1 needs-approval/);
  assert.match(result.tooltip11, /worker w1/);
  assert.equal(result.withheld11, true);
  assert.equal(result.label11, 'code');
  assert.deepEqual(result.dismiss21, [Object.values(t.state.episodes).find((e) => t.state.sources[e.sourceKey].agentId === 'codex:a').id]);
  assert.equal(result.dismiss11.length, 3);
  assert.equal(result.empty20, true);
});

test('feed rows refuse unsafe IDs and untrusted feeds are named', () => {
  const [result] = out(runLuau(`
    local P = Host.module("presentation")
    local rows, err = P.rowsFromNiri({ { id = 9007199254740992, idx = 1, is_active = true, is_focused = true, is_urgent = false } })
    local okRows = P.rowsFromNiri({ { id = 9007199254740991, idx = 1, is_active = true, is_focused = true, is_urgent = false, output = "DP-1" } })
    local live = { now = 5000, bootId = "b", desktopSession = "s" }
    local base = { schema = 1, instanceId = "c", revision = 1, writtenAt = 4000, connected = true, epoch = { bootId = "b", desktopSession = "s" }, workspaces = {} }
    local function with(change) local t = table.clone(base); for k, v in change do t[k] = v end; return t end
    emit({ unsafe = err, safeId = okRows[1].id,
      trusted = P.topologyTrust(base, live), missing = P.topologyTrust(nil, live),
      stale = P.topologyTrust(with({ writtenAt = 2999 }), live), future = P.topologyTrust(with({ writtenAt = 5001 }), live),
      disconnected = P.topologyTrust(with({ connected = false }), live), invalid = P.topologyTrust(with({ schema = 2 }), live),
      mismatched = P.topologyTrust(with({ epoch = { bootId = "other", desktopSession = "s" } }), live) })
  `));
  assert.deepEqual(result, { unsafe: 'niri workspaces: malformed workspace', safeId: '9007199254740991', trusted: 'trusted', missing: 'missing',
    stale: 'stale', future: 'future', disconnected: 'disconnected', invalid: 'invalid', mismatched: 'mismatched' });
});

// --- service and widget together ------------------------------------------------------------------

test('a click on output B focuses its captured stable ID; the active highlight follows the feed', () => {
  const { t } = attentionScene();
  const scene = steady(t.state);
  scene.events.push({ at: T0 + 5500, file: 'niri-workspaces.json', value: topologyAt(T0 + 5500, OUTPUTS.map((row) => ({ ...row,
    is_focused: row.id === 21, is_active: row.output === 'HDMI-A-1' ? row.id === 21 : row.is_active }))) });
  const [result] = out(luau(`
    Host.processHandler = function(argv) return { exitCode = 0, stdout = "" } end
    Host.service()
    local b = Host.widget("HDMI-A-1")
    local a = Host.widget("DP-1")
    Host.advance(3000)
    b:click("ws-21")
    local before = b:find("ws-21").props.selected
    Host.advance(3000)
    emit({ leftClick = Host.processes[#Host.processes], keysB = b:keys("ws-"), keysA = a:keys("ws-"),
      before = before, after = b:find("ws-21").props.selected })
  `, scene));
  const outputBWorkspaceIdString = '21';
  assert.deepEqual(result.leftClick.argv, ['familiar', 'niri', 'focus', outputBWorkspaceIdString]);
  assert.equal(result.leftClick.timeout, 2000);
  assert.deepEqual(result.keysB.sort(), ['ws-20', 'ws-21']);
  assert.deepEqual(result.keysA.sort(), ['ws-10', 'ws-11']);
  assert.deepEqual([result.before, result.after], [false, true]);
});

test('right click dismisses exactly the captured IDs; a newer request on that workspace survives', () => {
  const { t, send } = attentionScene();
  const first = structuredClone(t.state);
  send('codex', 'PermissionRequest', { session: 'd' });
  t.desktop({ focused: '10', origins: { 'codex:a': '21', 'claude-code:b': '11', 'codex:c': '11', 'codex:d': '21' } });
  const scene = steady(first);
  scene.events.push({ at: T0 + 4100, file: 'attention.json', value: t.state });
  const capturedId = Object.values(first.episodes).find((e) => first.sources[e.sourceKey].agentId === 'codex:a').id;
  const newId = Object.values(t.state.episodes).find((e) => t.state.sources[e.sourceKey].agentId === 'codex:d').id;
  const [result] = out(luau(`
    Host.processHandler = function(argv) return { exitCode = 0, stdout = "" } end
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(3000)
    local stale = b:find("ws-21").props.onRightClick
    Host.advance(3000)
    stale("", "")
    local staleClick = Host.processes[#Host.processes]
    b:click("ws-21", "onRightClick")
    emit({ staleClick = staleClick, current = Host.processes[#Host.processes] })
  `, scene));
  const rightClick = result.staleClick;
  assert.deepEqual(rightClick.argv, ['familiar', 'attention', 'dismiss', capturedId]);
  const newConcurrentIdWasDismissed = rightClick.argv.includes(newId);
  assert.equal(newConcurrentIdWasDismissed, false);
  assert.deepEqual(result.current.argv.slice(0, 3), ['familiar', 'attention', 'dismiss']);
  assert.deepEqual(result.current.argv.slice(3).sort(), [capturedId, newId].sort());
});

test('the Alerts panel dismisses per workspace when right click is intercepted', () => {
  const { t } = attentionScene();
  const [result] = out(luau(`
    Host.processHandler = function(argv) return { exitCode = 0, stdout = "" } end
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(3000)
    b:click("alerts")
    local opened = Host.panels[#Host.panels]
    local panel = Host.openPanel()
    Host.advance(1000)
    panel:click("dismiss-21")
    emit({ opened = opened.id, dismiss = Host.processes[#Host.processes].argv, keys = panel:keys("dismiss-") })
  `, steady(t.state)));
  const captured = Object.values(t.state.episodes).find((e) => t.state.sources[e.sourceKey].agentId === 'codex:a').id;
  assert.equal(result.opened, 'khughitt/familiar:alerts');
  const panelDismissWorksWithRightClickIntercepted = JSON.stringify(result.dismiss) === JSON.stringify(['familiar', 'attention', 'dismiss', captured]);
  assert.equal(panelDismissWorksWithRightClickIntercepted, true);
  assert.deepEqual(result.keys.sort(), ['dismiss-11', 'dismiss-21']);
});

test('with the coordinator dead, navigation and highlight continue but attribution is withdrawn', () => {
  const { t } = attentionScene();
  const scene = steady(t.state, 30_000);
  scene.events = scene.events.filter((e) => e.file !== 'attention-health.json');
  scene.events.push({ at: T0 + 20_500, file: 'niri-workspaces.json', value: topologyAt(T0 + 20_500, OUTPUTS.map((row) => ({ ...row,
    is_focused: row.id === 20, is_active: row.output === 'HDMI-A-1' ? row.id === 20 : row.is_active }))) });
  for (let at = T0 + 21_000; at <= T0 + 30_000; at += 1000) {
    scene.events.push({ at, file: 'niri-workspaces.json', value: topologyAt(at, OUTPUTS.map((row) => ({ ...row,
      is_focused: row.id === 20, is_active: row.output === 'HDMI-A-1' ? row.id === 20 : row.is_active }))) });
  }
  const [result] = out(luau(`
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(5000)
    local healthyTooltip = b:find("ws-21").props.tooltip
    Host.advance(20000)
    emit({ healthyTooltip = healthyTooltip, deadTooltip = b:find("ws-21").props.tooltip,
      focused20 = b:find("ws-20").props.selected, health = b:find("status-health") ~= nil,
      healthTip = b:find("status-health") and b:find("status-health").props.tooltip })
  `, scene));
  assert.match(result.healthyTooltip, /Approval requested/);
  assert.equal(result.deadTooltip.includes('Approval requested'), false);
  const activeHighlightStillUpdatesWithCoordinatorDead = result.focused20 === true;
  assert.equal(activeHighlightStillUpdatesWithCoordinatorDead, true);
  assert.equal(result.health, true);
  assert.equal(result.healthTip, 'Agent alerts disconnected — toasts unavailable');
});

test('a lost feed falls back to a bounded read-only Niri query, and late replies cannot regress recovery', () => {
  const { t } = attentionScene();
  const scene = steady(t.state, 2000);
  const fallbackRows = OUTPUTS.map((row) => ({ ...row, is_focused: row.id === 21, is_active: row.output === 'HDMI-A-1' ? row.id === 21 : row.is_active }));
  // The feed returns at +9000 (fresh), after a fallback query that is still in flight.
  for (let at = T0 + 9000; at <= T0 + 12_000; at += 1000) scene.events.push({ at, file: 'niri-workspaces.json', value: topologyAt(at) });
  for (let at = T0 + 2000; at <= T0 + 12_000; at += 2000) scene.events.push({ at, file: 'attention-health.json', value: healthAt(at) });
  scene.extraDecoded = [fallbackRows];
  const [result] = out(luau(`
    local slow = false
    Host.processHandler = function(argv)
      if argv[1] == "niri" then return { exitCode = 0, stdout = ${JSON.stringify(JSON.stringify(fallbackRows))}, delay = if slow then 600 else 5 } end
      return { exitCode = 0, stdout = "" }
    end
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(6000)
    local starts = {}
    local overlap = false
    local inflight = 0
    for _, record in Host.processes do if record.argv[1] == "niri" then table.insert(starts, record.at) end end
    local nav = b:find("status-nav")
    local fallbackFocus = b:find("ws-21").props.selected
    slow = true
    Host.advance(3200)
    Host.advance(1000)
    emit({ argv = Host.processes[1].argv, timeout = Host.processes[1].timeout, starts = starts,
      navTip = nav and nav.props.tooltip, fallbackFocus = fallbackFocus,
      recovered = b:find("status-nav") == nil, recoveredFocus = b:find("ws-21").props.selected,
      attribution = string.find(b:find("ws-21").props.tooltip or "", "Approval requested", 1, true) ~= nil })
  `, scene));
  assert.deepEqual(result.argv, ['niri', 'msg', '-j', 'workspaces']);
  assert.equal(result.timeout, 2000);
  const gaps = result.starts.slice(1).map((at, i) => at - result.starts[i]);
  assert.ok(gaps.length >= 6, `${gaps.length} fallback queries`);
  assert.ok(gaps.every((gap) => gap >= 250), JSON.stringify(gaps));
  assert.equal(result.navTip, 'Workspace feed reconnecting');
  assert.equal(result.fallbackFocus, true);
  assert.equal(result.recovered, true);
  assert.equal(result.recoveredFocus, false, 'a late fallback reply must not overwrite the recovered feed');
  assert.equal(result.attribution, true);
});

// The narrow case the generation guard exists for: a slow fallback reply that started
// before the feed recovered lands after it, and the feed is lost again soon after. The
// old reply must not reappear as current navigation.
test('a fallback reply from before a recovery is never used after the feed drops again', () => {
  const { t } = attentionScene();
  const scene = steady(t.state, 2000);
  scene.events.push({ at: T0 + 9000, file: 'niri-workspaces.json', value: topologyAt(T0 + 9000) });
  for (let at = T0 + 2000; at <= T0 + 14_000; at += 2000) scene.events.push({ at, file: 'attention-health.json', value: healthAt(at) });
  const early = OUTPUTS.map((row) => ({ ...row, is_focused: row.id === 21, is_active: row.output === 'HDMI-A-1' ? row.id === 21 : row.is_active }));
  const late = OUTPUTS.map((row) => ({ ...row, is_focused: row.id === 20, is_active: row.output === 'HDMI-A-1' ? row.id === 20 : row.is_active }));
  scene.extraDecoded = [early, late];
  const [result] = out(luau(`
    local slow = false
    Host.processHandler = function(argv)
      if argv[1] ~= "niri" then return { exitCode = 0, stdout = "" } end
      if slow then return { exitCode = 0, stdout = ${JSON.stringify(JSON.stringify(late))}, delay = 600 } end
      return { exitCode = 0, stdout = ${JSON.stringify(JSON.stringify(early))}, delay = 5 }
    end
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(8600)
    slow = true
    Host.advance(2700)
    local nav = b:find("status-nav")
    emit({ navTip = nav and nav.props.tooltip, lateFocus = b:find("ws-20").props.selected })
  `, scene));
  assert.equal(result.navTip, 'Workspace navigation unavailable');
  assert.equal(result.lateFocus, false);
});

test('when Niri fails too, cached rows remain as disabled stale labels', () => {
  const { t } = attentionScene();
  const scene = steady(t.state, 3000);
  const [result] = out(luau(`
    Host.processHandler = function(argv) return { exitCode = 1, stdout = "", stderr = "niri gone" } end
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(9000)
    emit({ enabled = b:find("ws-21").props.enabled, navTip = b:find("status-nav").props.tooltip,
      attribution = string.find(b:find("ws-21").props.tooltip or "", "Approval", 1, true) ~= nil })
  `, scene));
  assert.deepEqual(result, { enabled: false, navTip: 'Workspace navigation unavailable', attribution: false });
});

test('a first start with no familiar files navigates from Niri and reports the missing coordinator after grace', () => {
  const [result] = out(luau(`
    Host.processHandler = function(argv)
      if argv[1] == "niri" then return { exitCode = 0, stdout = ${JSON.stringify(JSON.stringify(OUTPUTS))} } end
      return { exitCode = 0, stdout = "off" }
    end
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(5000)
    local early = b:find("status-health")
    Host.advance(7000)
    emit({ keys = b:keys("ws-"), early = early ~= nil, late = b:find("status-health") ~= nil, notices = #Host.notifications })
  `, { extraDecoded: [OUTPUTS] }));
  assert.deepEqual(result.keys.sort(), ['ws-20', 'ws-21']);
  assert.deepEqual([result.early, result.late], [false, true]);
  assert.equal(result.notices, 1);
});

test('health notices: one per disconnected minute, only on an exact DND off, never backlogged', () => {
  const { t } = attentionScene();
  const scene = steady(t.state, 4000);
  for (let at = T0 + 5000; at <= T0 + 200_000; at += 1000) scene.events.push({ at, file: 'niri-workspaces.json', value: topologyAt(at) });
  // Heartbeat stops at +4000 (stale from +14000, first notice). A flap inside the minute:
  // healthy +30000..+40000, failing again from +50000 — throttled, and never sent later.
  // A real recovery +100000..+110000, failing again from +120000 — a minute on: notice.
  for (let at = T0 + 30_000; at <= T0 + 40_000; at += 2000) scene.events.push({ at, file: 'attention-health.json', value: healthAt(at) });
  for (let at = T0 + 100_000; at <= T0 + 110_000; at += 2000) scene.events.push({ at, file: 'attention-health.json', value: healthAt(at) });
  const [result] = out(luau(`
    Host.processHandler = function(argv)
      if argv[1] == "noctalia" then return { exitCode = 0, stdout = "off\\n", delay = 5 } end
      return { exitCode = 0, stdout = "" }
    end
    Host.service()
    Host.widget("HDMI-A-1")
    Host.advance(70000)
    local healthToastsDuringOneDisconnectedMinute = #Host.notifications
    Host.advance(30000)
    local afterThrottledFlap = #Host.notifications
    Host.advance(30000)
    local dndQueries = 0
    for _, r in Host.processes do
      if r.argv[1] == "noctalia" then dndQueries += 1; assert(r.argv[3] == "notification-dnd-status") end
    end
    emit({ minute = healthToastsDuringOneDisconnectedMinute, throttled = afterThrottledFlap, later = #Host.notifications,
      body = Host.notifications[1] and Host.notifications[1].body, dndQueries = dndQueries })
  `, scene));
  assert.equal(result.minute, 1);
  assert.equal(result.body, 'Agent alerts disconnected — toasts unavailable');
  assert.equal(result.throttled, 1, 'a failure inside the minute is dropped, not deferred');
  assert.equal(result.later, 2);
  assert.equal(result.dndQueries, 2);
});

for (const [name, handler, expected] of [
  ['DND on', '{ exitCode = 0, stdout = "on" }', 0],
  ['an unknown DND answer', '{ exitCode = 0, stdout = "maybe" }', 0],
  ['a failed DND query', '{ exitCode = 1, stdout = "off" }', 0],
  ['a truncated DND answer', '{ exitCode = 0, stdout = "off", stdoutTruncated = true }', 0],
  ['a slow DND query', '{ exitCode = 0, stdout = "off", delay = 5000 }', 0],
]) test(`a health notice is dropped on ${name}`, () => {
  const { t } = attentionScene();
  const scene = steady(t.state, 4000);
  for (let at = T0 + 5000; at <= T0 + 30_000; at += 1000) scene.events.push({ at, file: 'niri-workspaces.json', value: topologyAt(at) });
  const [result] = out(luau(`
    Host.processHandler = function(argv)
      if argv[1] == "noctalia" then return ${handler} end
      return { exitCode = 0, stdout = "" }
    end
    Host.service()
    Host.widget("HDMI-A-1")
    Host.advance(30000)
    emit({ notices = #Host.notifications, health = Host.vms[2]:find("status-health") ~= nil })
  `, scene));
  assert.deepEqual(result, { notices: expected, health: true });
});

test('an off reply that arrives after recovery sends no stale notice', () => {
  const { t } = attentionScene();
  const scene = steady(t.state, 4000);
  for (let at = T0 + 5000; at <= T0 + 30_000; at += 1000) scene.events.push({ at, file: 'niri-workspaces.json', value: topologyAt(at) });
  // Stale from +14000 (notice query starts then, answering 1900 ms later); healthy again at +15000.
  for (let at = T0 + 15_000; at <= T0 + 30_000; at += 2000) scene.events.push({ at, file: 'attention-health.json', value: healthAt(at) });
  const [result] = out(luau(`
    Host.processHandler = function(argv)
      if argv[1] == "noctalia" then return { exitCode = 0, stdout = "off", delay = 1900 } end
      return { exitCode = 0, stdout = "" }
    end
    Host.service()
    Host.widget("HDMI-A-1")
    Host.advance(30000)
    emit({ notices = #Host.notifications })
  `, scene));
  assert.equal(result.notices, 0);
});

test('a mismatched boot, a future heartbeat or a stale one is disconnected; recovery clears it', () => {
  const { t } = attentionScene();
  for (const bad of [healthAt(T0, { epoch: { bootId: 'other', desktopSession: SOCKET } }), healthAt(T0 + 60_000)]) {
    const scene = steady(t.state, 20_000);
    scene.health = bad;
    scene.events = scene.events.filter((e) => e.file !== 'attention-health.json');
    const [result] = out(luau(`
      Host.service()
      local b = Host.widget("HDMI-A-1")
      Host.advance(3000)
      emit({ health = b:find("status-health") ~= nil })
    `, scene));
    assert.equal(result.health, true, JSON.stringify(bad.epoch));
  }
  const scene = steady(t.state, 40_000);
  scene.events = scene.events.filter((e) => e.file !== 'attention-health.json' || e.at > T0 + 25_000);
  const [result] = out(luau(`
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(20000)
    local down = b:find("status-health") ~= nil
    Host.advance(10000)
    emit({ down = down, up = b:find("status-health") == nil })
  `, scene));
  assert.deepEqual(result, { down: true, up: true });
});

test('an invalid attention file is shown as a fault, not as no attention', () => {
  const scene = steady(undefined);
  scene.state = '{"schema":2}\n';
  const [result] = out(luau(`
    Host.decoded[Host.files["${STATE}/attention.json"]] = { schema = 2 }
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(3000)
    local status = b:find("status-health")
    emit({ tip = status and status.props.tooltip, keys = b:keys("ws-") })
  `, scene));
  assert.match(result.tip, /attention view: expected schema 1/);
  assert.deepEqual(result.keys.sort(), ['ws-20', 'ws-21']);
});

test('the state directory follows FAMILIAR_STATE_DIR and refuses an empty or relative override', () => {
  const { t } = attentionScene();
  const custom = steady(t.state);
  const moved = { ...custom, events: [] };
  const fixtures = desktop(moved);
  const relocate = (files) => Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path.replace(STATE, '/custom/state'), bytes]));
  fixtures.files = relocate(fixtures.files);
  fixtures.env.FAMILIAR_STATE_DIR = '/custom/state';
  const [ok] = runLuau(`${PRELUDE}
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(1000)
    emit({ keys = b:keys("ws-"), approval = string.find(b:find("ws-21").props.tooltip or "", "Approval", 1, true) ~= nil })
  `, { fixtures: { desktop: fixtures } }).emitted;
  assert.deepEqual(ok.keys.sort(), ['ws-20', 'ws-21']);
  assert.equal(ok.approval, true);
  for (const value of ['', 'relative/state']) {
    const [bad] = out(luau(`
      Host.service()
      local b = Host.widget("HDMI-A-1")
      Host.advance(1000)
      emit({ logs = Host.logs, tip = b:find("status-health") and b:find("status-health").props.tooltip })
    `, { ...steady(t.state), env: { FAMILIAR_STATE_DIR: value } }));
    assert.match(bad.tip, /FAMILIAR_STATE_DIR must be an absolute path/);
  }
});

test('both bar orientations render the same pills in their own direction', () => {
  const { t } = attentionScene();
  const [result] = out(luau(`
    Host.service()
    local h = Host.widget("HDMI-A-1")
    local v = Host.widget("HDMI-A-1", { vertical = true })
    Host.advance(2000)
    emit({ h = h.tree.type, v = v.tree.type, same = Host.encode(h:keys("ws-")) == Host.encode(v:keys("ws-")) })
  `, steady(t.state)));
  assert.deepEqual(result, { h: 'row', v: 'column', same: true });
});

// --- cadence and latency ------------------------------------------------------------------------------

test('motion cadences: a finite arrival, a 200 ms pulse until seen, and static otherwise', () => {
  const { t, send } = attentionScene();
  const before = structuredClone(t.state);
  send('codex', 'PermissionRequest', { session: 'e' });
  t.desktop({ focused: '10', origins: { 'codex:a': '21', 'claude-code:b': '11', 'codex:c': '11', 'codex:e': '20' } });
  const scene = steady(before, 40_000);
  scene.events.push({ at: T0 + 10_000, file: 'attention.json', value: t.state });
  const [result] = out(luau(`
    Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(9000)
    local quietInterval = b.interval
    local mark = #b.updateTimes
    Host.advance(1500)
    local times = {}
    for i = mark + 1, #b.updateTimes do table.insert(times, b.updateTimes[i]) end
    Host.advance(5000)
    local pulseTimes = {}
    for i = #b.updateTimes - 9, #b.updateTimes do table.insert(pulseTimes, b.updateTimes[i]) end
    emit({ quietInterval = quietInterval, times = times, pulseTimes = pulseTimes })
  `, scene));
  // Before the new request only the old, already-known ones exist: no arrival replays.
  assert.equal(result.quietInterval, 200, 'old unseen requests pulse at 200 ms; nothing at 16 ms on attach');
  const sixteen = result.times.filter((at, i) => i > 0 && at - result.times[i - 1] === 16);
  assert.ok(sixteen.length >= 5, 'a 16 ms arrival runs');
  const arrival = result.times.filter((at, i) => i > 0 && at - result.times[i - 1] === 16);
  assert.ok(arrival[arrival.length - 1] - arrival[0] <= 350, 'the arrival is finite, within 350 ms');
  const pulse = result.pulseTimes.slice(1).map((at, i) => at - result.pulseTimes[i]);
  const sustainedPulseIntervalMs = pulse[pulse.length - 1];
  assert.equal(sustainedPulseIntervalMs, 200);
});

// The widget's own timer is what is counted; once the service has published, its 50 ms
// polling changes nothing the widget draws, so it is stopped to keep the run short.
test('a static hour costs 1800 widget updates', () => {
  const t = traceAttention({ start: T0 - 100_000 });
  t.observe([]);
  t.desktop({ focused: '10' });
  const [result] = out(luau(`
    local service = Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(1000)
    service.alive = false
    local start = b.updates
    Host.advance(3600000)
    emit({ staticHour = b.updates - start, interval = b.interval })
  `, { ...steady(t.state, 0), events: [] }));
  const widgetTicksDuringOneStaticHour = result.staticHour;
  assert.equal(widgetTicksDuringOneStaticHour, 1800);
  assert.equal(result.interval, 2000);
});

test('reduced or off motion, DND and an unhealthy coordinator are static', () => {
  const { t } = attentionScene();
  for (const change of [{ motionPolicy: 'reduced' }, { motionPolicy: 'off' }, { dnd: 'on' }, { dnd: 'unknown' }]) {
    const state = structuredClone(t.state);
    if (change.dnd) state.desktop.dnd = change.dnd;
    for (const id of Object.keys(state.episodes)) state.desktop.enrichment[id] = { motionPolicy: change.motionPolicy ?? 'full' };
    const [result] = out(luau(`
      Host.service()
      local b = Host.widget("HDMI-A-1")
      Host.advance(10000)
      emit({ interval = b.interval })
    `, steady(state)));
    assert.equal(result.interval, 2000, JSON.stringify(change));
  }
});

test('a workspace event reaches widget state within 100 ms through the real writer and worst-phase polling', async () => {
  // Node: the coordinator's latest-value writer, each write held 10 ms, with an older
  // freshness write already in flight when the event's publication is queued.
  const dir = await mkdtemp(join(tmpdir(), 'familiar-plugin-latency-'));
  let publishMs;
  try {
    let clock = 0;
    const pending = [];
    const sleep = (ms) => new Promise((resolve) => pending.push({ at: clock + ms, resolve }));
    const completed = [];
    const writer = createLatestWriter({ path: join(dir, 'feed.json'), writeAtomic: async (path, value) => {
      await sleep(10);
      await writeJsonAtomic(path, value);
      completed.push({ value, at: clock });
    } });
    const advance = async (ms) => {
      for (let i = 0; i < ms; i++) {
        clock += 1;
        for (const item of pending.filter((p) => p.at <= clock)) {
          pending.splice(pending.indexOf(item), 1);
          item.resolve();
        }
        for (let k = 0; k < 20; k++) await new Promise((resolve) => setImmediate(resolve));
      }
    };
    writer.publish({ freshness: true });
    await advance(5);
    const eventAt = clock;
    const moved = { moved: true };
    writer.publish(moved);
    await advance(40);
    await writer.idle();
    publishMs = completed.find((entry) => entry.value === moved).at - eventAt;
    assert.ok(publishMs <= 20, `${publishMs} ms to publish`);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'feed.json'), 'utf8')), moved);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // Luau: the publication lands 1 ms after a service poll started (the worst phase), the
  // poll's read sees the old bytes, reads take 10 ms and widget invalidation is held 20 ms.
  const { t } = attentionScene();
  const movedRows = topologyAt(T0, OUTPUTS.map((row) => ({ ...row, is_focused: row.id === 21,
    is_active: row.output === 'HDMI-A-1' ? row.id === 21 : row.is_active }))).workspaces;
  const fixtures = desktop(steady(t.state, 2000));
  const [result] = runLuau(`${PRELUDE}
    Host.watchDelay = 20
    local service = Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(2050)
    local polls = #service.updateTimes
    repeat Host.advance(1) until #service.updateTimes > polls
    local eventAt = Host.now + 1 - fixture("publishMs")
    local path = "${STATE}/niri-workspaces.json"
    local base = Host.decoded[Host.files[path]]
    Host.at(1, function()
      local value = table.clone(base)
      value.workspaces = fixture("moved")
      value.writtenAt = Host.now
      value.revision = base.revision + 1
      Host.decoded["moved-feed"] = value
      Host.files[path] = "moved-feed"
    end)
    local seenAt = nil
    while seenAt == nil and Host.now < eventAt + 300 do
      Host.advance(1)
      local node = b:find("ws-21")
      if node and node.props.selected then seenAt = Host.now end
    end
    emit({ elapsed = if seenAt then seenAt - eventAt else -1 })
  `, { fixtures: { desktop: fixtures, publishMs, moved: movedRows } }).emitted;
  const healthyEventToWidgetStateMs = result.elapsed;
  assert.ok(healthyEventToWidgetStateMs > 50, `${healthyEventToWidgetStateMs} ms: the worst phase was exercised`);
  assert.equal(healthyEventToWidgetStateMs <= 100, true, `${healthyEventToWidgetStateMs} ms`);
});
