// Desktop attribution and presentation: which stable workspace a source's attention
// belongs to, and what a popup or pill needs to show it. Pure: windows, workspaces,
// process ancestry and the theme are all supplied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadThemePack } from 'familiar-theme';
import { reduceAttention } from '../src/attention/model.js';
import { attentionByWorkspace, projectDesktop, resolvePresentations } from '../integrations/niri/attention.js';
import { createRegistry, handle, nativeEvent, traceAttention } from './helpers/attention.js';

const pack = await loadThemePack(new URL('./fixtures/theme-pack', import.meta.url).pathname);

// Terminal T(pid) hosts agent A(pid+1); niri knows the terminal's window.
const ancestry = (chains) => (pid) => {
  const chain = chains[pid];
  if (!chain) throw Object.assign(new Error('no such process'), { code: 'PROCESS_UNAVAILABLE' });
  return chain;
};
const row = (pid, starttime = '9000') => ({ pid, ppid: 1, comm: 'x', tty: true, starttime, state: 'S' });

const workspace = (id, { idx = Number(id), output = 'DP-1', focused = false, active = focused } = {}) => ({
  id, idx, output, is_active: active, is_focused: focused, is_urgent: false, occupied: true,
});

// One live trace whose sources carry real process handles: s1 (pid 101) and s2 (pid 201).
function scene() {
  const t = traceAttention();
  const r = createRegistry({ now: () => t.now });
  t.observe([]);
  const send = (harness, native, ids, pid) => {
    const event = nativeEvent(harness, native, ids);
    r.apply(event, { process: handle(pid) });
    t.observe(r.rows(), event);
  };
  return { t, send };
}
const chains = {
  101: [row(101), row(100), row(1)],
  201: [row(201), row(200), row(1)],
};
const project = (t, { windows, workspaces, dnd = 'off', ancestors = ancestry(chains), presentations = {} }) => projectDesktop({
  state: t.state, windows, workspaces, presentations, dnd, instanceId: 'coordinator-1', now: t.now, ancestors,
});
const apply = (t, input) => reduceAttention(t.state, input).state;

test('exactly the originating stable workspace is attributed, across moves and renumbering', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 's1' }, 101);
  const rootKey = t.sourceKeyOf('codex:s1');
  const first = project(t, { windows: [{ id: 5, pid: 100, workspace_id: 12 }], workspaces: [workspace('3', { focused: true }), workspace('12', { idx: 2 })] });
  assert.deepEqual(first.origins, { [rootKey]: { workspaceId: '12', output: 'DP-1' } });
  // Renumbered (idx changes) and moved to another monitor: the stable ID decides.
  const moved = project(t, { windows: [{ id: 5, pid: 100, workspace_id: 40 }], workspaces: [workspace('12', { idx: 1 }), workspace('40', { idx: 2, output: 'HDMI-A-1', focused: true })] });
  assert.deepEqual(moved.origins, { [rootKey]: { workspaceId: '40', output: 'HDMI-A-1' } });
  assert.equal(moved.status, 'known');
  assert.equal(moved.type, 'desktop');
});

test('a headless session, a replaced process or a vanished workspace is unmapped, never guessed', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 's1' }, 101);
  send('codex', 'PermissionRequest', { session: 's2' }, 201);
  const windows = [{ id: 5, pid: 999, workspace_id: 12 }, { id: 6, pid: 200, workspace_id: 77 }];
  const replaced = { ...chains, 201: [row(201, '1234'), row(200), row(1)] };
  const desktop = project(t, { windows, workspaces: [workspace('12', { focused: true })], ancestors: ancestry(replaced) });
  assert.deepEqual(desktop.origins, {});
  const vanished = project(t, { windows: [{ id: 6, pid: 200, workspace_id: 77 }], workspaces: [workspace('12', { focused: true })] });
  assert.deepEqual(vanished.origins, {});
});

test('a torn-down source has no origin and an untrusted topology reports disconnected', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 's1' }, 101);
  send('codex', 'SessionEnd', { session: 's1' }, 101);
  assert.deepEqual(project(t, { windows: [{ id: 5, pid: 100, workspace_id: 12 }], workspaces: [workspace('12')] }).origins, {});
  const lost = project(t, { windows: [], workspaces: null });
  assert.equal(lost.status, 'disconnected');
  assert.deepEqual([lost.workspaces, lost.origins], [[], {}]);
});

test('visible on another monitor is unseen; moving onto the focused workspace marks it seen', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 's1' }, 101);
  const id = t.episodesOf('codex:s1')[0].id;
  const workspaces = [workspace('1', { focused: true }), workspace('2', { output: 'HDMI-A-1', active: true })];
  const visible = apply(t, project(t, { windows: [{ id: 5, pid: 100, workspace_id: 2 }], workspaces }));
  assert.equal(visible.episodes[id].seen, false);
  const movedHere = apply(t, project(t, { windows: [{ id: 5, pid: 100, workspace_id: 1 }], workspaces }));
  assert.equal(movedHere.episodes[id].seen, true);
});

function summarised({ focused = '9', mapped = true } = {}) {
  const { t, send } = scene();
  send('codex', 'UserPromptSubmit', { session: 's1' }, 101);
  send('codex', 'Stop', { session: 's1' }, 101);
  send('claude-code', 'Notification:idle_prompt', { session: 's2' }, 201);
  send('claude-code', 'Notification:permission_prompt', { session: 's2' }, 201);
  const windows = mapped ? [{ id: 5, pid: 100, workspace_id: 2 }, { id: 6, pid: 200, workspace_id: 2 }] : [];
  const desktop = project(t, { windows, workspaces: [workspace('2', { focused: focused === '2' }), workspace('9', { focused: focused === '9' })] });
  return { t, state: apply(t, desktop) };
}

test('a workspace shows its highest-priority attention and counts every pending episode', () => {
  const { t, state } = summarised();
  const view = attentionByWorkspace(state);
  assert.equal(view.workspaces['2'].kind, 'needs-approval');
  assert.equal(view.workspaces['2'].count, 2);
  assert.deepEqual(view.workspaces['2'].episodeIds.sort(), Object.keys(state.episodes).filter((id) => !state.episodes[id].closed).sort());
  assert.equal(t.episodesOf('claude-code:s2').length, 2); // input closed by approval, still tracked
});

test('priority is error, approval, input, completion; ties go to the newest episode', () => {
  const { t, send } = scene();
  send('codex', 'UserPromptSubmit', { session: 's1' }, 101);
  send('codex', 'Stop', { session: 's1' }, 101);
  send('opencode', 'session.error', { session: 's2' }, 201);
  const windows = [{ id: 5, pid: 100, workspace_id: 2 }, { id: 6, pid: 200, workspace_id: 2 }];
  const state = apply(t, project(t, { windows, workspaces: [workspace('2'), workspace('9', { focused: true })] }));
  assert.equal(attentionByWorkspace(state).workspaces['2'].kind, 'error');
  const { t: t2, send: send2 } = scene();
  send2('codex', 'PermissionRequest', { session: 's1' }, 101);
  send2('codex', 'PermissionRequest', { session: 's2' }, 201);
  const both = apply(t2, project(t2, { windows, workspaces: [workspace('2'), workspace('9', { focused: true })] }));
  assert.equal(attentionByWorkspace(both).workspaces['2'].winnerId, t2.episodesOf('codex:s2')[0].id);
});

test('seen errors and completions clear; seen requests stay; dismissed ones leave the count', () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 's1' }, 101);
  send('opencode', 'session.error', { session: 's2' }, 201);
  const windows = [{ id: 5, pid: 100, workspace_id: 2 }, { id: 6, pid: 200, workspace_id: 2 }];
  const seen = apply(t, project(t, { windows, workspaces: [workspace('2', { focused: true })] }));
  const view = attentionByWorkspace(seen).workspaces['2'];
  assert.deepEqual([view.kind, view.count], ['needs-approval', 1]);
  const approval = t.episodesOf('codex:s1')[0].id;
  const dismissed = reduceAttention(seen, { type: 'dismiss', ids: [approval], now: t.now + 1 }).state;
  assert.equal(attentionByWorkspace(dismissed).workspaces['2'], undefined);
});

function withheld({ focused, mapped }) {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 's1' }, 101);
  send('codex', 'SubagentStart', { session: 's1', worker: 'w1' }, 101);
  send('codex', 'PreToolUse', { session: 's1' }, 101);
  send('codex', 'Stop', { session: 's1' }, 101);
  send('codex', 'PermissionRequest', { session: 's1' }, 101);
  const windows = mapped ? [{ id: 5, pid: 100, workspace_id: 2 }] : [];
  return apply(t, project(t, { windows, workspaces: [workspace('2', { focused }), workspace('9', { focused: !focused })] }));
}

test('a suppression diagnostic stays beside a higher-priority request, focused, unfocused or unmapped', () => {
  for (const focused of [true, false]) {
    const state = withheld({ focused, mapped: true });
    const view = attentionByWorkspace(state).workspaces['2'];
    assert.equal(view.kind, 'needs-approval');
    assert.equal(view.count, 1);
    assert.equal(view.diagnosticIds.length, 1);
  }
  const unmapped = attentionByWorkspace(withheld({ focused: false, mapped: false }));
  assert.equal(unmapped.unmapped.diagnosticIds.length, 1);
  assert.equal(unmapped.unmapped.count, 1);
});

test('an unmapped completion stays unmarked until a later unfocused mapping, with no new opportunity', () => {
  const { t, send } = scene();
  send('codex', 'UserPromptSubmit', { session: 's1' }, 101);
  send('codex', 'Stop', { session: 's1' }, 101);
  const unmapped = apply(t, project(t, { windows: [], workspaces: [workspace('9', { focused: true })] }));
  const id = Object.keys(unmapped.episodes)[0];
  assert.equal(unmapped.episodes[id].delivery.toast.status, 'suppressed');
  assert.equal(attentionByWorkspace(unmapped).unmapped.count, 0);
  const t2 = { ...t, state: unmapped };
  const mapped = reduceAttention(unmapped, projectDesktop({
    state: unmapped, windows: [{ id: 5, pid: 100, workspace_id: 2 }], workspaces: [workspace('2'), workspace('9', { focused: true })],
    presentations: {}, dnd: 'off', instanceId: 'coordinator-1', now: t2.now + 5, ancestors: ancestry(chains),
  })).state;
  assert.equal(attentionByWorkspace(mapped).workspaces['2'].kind, 'completion');
  assert.deepEqual(mapped.episodes[id].delivery, unmapped.episodes[id].delivery);
});

// --- presentation ----------------------------------------------------------------------

const ctx = { pack, tone: { mode: 'dark', satScale: 1 }, motionPolicy: 'reduced' };
const intentFor = (sessionId, extra = {}) => ({ [sessionId]: { current: {
  sessionId, state: 'working', identity: { member: 'pip', label: 'Pip', project: 'repo', slot: 0 },
  color: { base: '#a1b2c3' }, motionPolicy: 'full', sprite: { terminal: '/elsewhere/working.png' }, ...extra,
} } });

test('a worker approval while the root shows working uses the approval pose and the root identity', async () => {
  const { t, send } = scene();
  send('codex', 'UserPromptSubmit', { session: 's1' }, 101);
  send('codex', 'SubagentStart', { session: 's1', worker: 'w1' }, 101);
  send('codex', 'PermissionRequest', { session: 's1', worker: 'w1' }, 101);
  const id = t.episodesOf('codex:w1')[0].id;
  const { presentations, diagnostics } = await resolvePresentations({ state: t.state, intent: intentFor('s1'), loadContext: async () => ctx });
  assert.deepEqual(diagnostics, []);
  assert.equal(presentations[id].pose, 'needs-approval');
  assert.match(presentations[id].sprite, /needs-approval\.png$/);
  assert.equal(presentations[id].color, '#a1b2c3');
  assert.equal(presentations[id].worker, 'w1');
  assert.equal(presentations[id].motionPolicy, 'reduced');
});

test('an unseen error after the art expired still uses the error pose', async () => {
  const { t, send } = scene();
  send('opencode', 'session.error', { session: 's2' }, 201);
  const id = t.episodesOf('opencode:s2')[0].id;
  const expired = intentFor('s2', { state: 'idle', sprite: { terminal: '/elsewhere/idle.png' } });
  const { presentations } = await resolvePresentations({ state: t.state, intent: expired, loadContext: async () => ctx });
  assert.equal(presentations[id].pose, 'error');
  assert.match(presentations[id].sprite, /error\.png$/);
  assert.equal(presentations[id].worker, null);
});

test('a completion presents the done pose', async () => {
  const { t, send } = scene();
  send('codex', 'UserPromptSubmit', { session: 's1' }, 101);
  send('codex', 'Stop', { session: 's1' }, 101);
  const id = t.episodesOf('codex:s1')[0].id;
  const { presentations } = await resolvePresentations({ state: t.state, intent: intentFor('s1'), loadContext: async () => ctx });
  assert.match(presentations[id].sprite, /done\.png$/);
});

test('missing identity or art is neutral and diagnosed, never another state image', async () => {
  const { t, send } = scene();
  send('codex', 'PermissionRequest', { session: 's1' }, 101);
  const id = t.episodesOf('codex:s1')[0].id;
  const none = await resolvePresentations({ state: t.state, intent: {}, loadContext: async () => ctx });
  assert.deepEqual([none.presentations[id].sprite, none.presentations[id].color], [null, null]);
  assert.match(none.diagnostics[0], /identity unavailable/);
  const missingMember = await resolvePresentations({ state: t.state, intent: intentFor('s1', { identity: { member: 'ghost', label: 'Ghost', project: 'repo', slot: 0 } }), loadContext: async () => ctx });
  assert.equal(missingMember.presentations[id].sprite, null);
  assert.equal(missingMember.presentations[id].color, '#a1b2c3');
  assert.match(missingMember.diagnostics[0], /art unavailable/);
  const broken = await resolvePresentations({ state: t.state, intent: intentFor('s1'), loadContext: async () => { throw new Error('theme exploded'); } });
  assert.equal(broken.presentations[id].sprite, null);
  assert.match(broken.diagnostics[0], /theme exploded/);
});
