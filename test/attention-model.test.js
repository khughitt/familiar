import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterFor } from 'relay';
import { initialAttention, reduceAttention, validateAttention } from '../src/attention/model.js';
import {
  OTHER_GENERATION, createRegistry, handle, nativeEvent, traceAttention,
} from './helpers/attention.js';

// A trace past its initial snapshot, so later requests are live opportunities rather than
// restored history.
function scenario() {
  const t = traceAttention();
  const r = createRegistry({ now: () => t.now });
  t.observe([]);
  const send = (harness, native, ids = {}, { process } = {}) => {
    const event = nativeEvent(harness, native, ids);
    r.apply(event, { process });
    return t.observe(r.rows(), event);
  };
  return { t, r, send };
}

const only = (episodes) => {
  assert.equal(episodes.length, 1, `expected one episode, found ${episodes.length}`);
  return episodes[0];
};

// --- source isolation -------------------------------------------------------------

test('a Codex root approval survives its identified worker working and finishing', () => {
  const { t, send } = scenario();
  send('codex', 'SessionStart', { session: 'root' });
  send('codex', 'PermissionRequest', { session: 'root' });
  send('codex', 'SubagentStart', { session: 'root', worker: 'w1' });
  send('codex', 'PreToolUse', { session: 'root', worker: 'w1' });
  send('codex', 'SubagentStop', { session: 'root', worker: 'w1' });
  const rootApproval = only(t.episodesOf('codex:root'));
  assert.equal(rootApproval.kind, 'needs-approval');
  assert.equal(rootApproval.closed, false); // after identified worker working/done
});

test('a Codex worker approval is its own episode, attributed to the root without overwriting it', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' });
  send('codex', 'SubagentStart', { session: 'root', worker: 'w1' });
  send('codex', 'PermissionRequest', { session: 'root', worker: 'w1' });
  const rootApproval = only(t.episodesOf('codex:root'));
  const workerApproval = only(t.episodesOf('codex:w1'));
  assert.notEqual(rootApproval.id, workerApproval.id);
  assert.equal(workerApproval.rootKey, t.sourceKeyOf('codex:root'));
  assert.equal(rootApproval.closed, false);
  assert.equal(t.state.sources[t.sourceKeyOf('codex:w1')].scope, 'worker');
});

test('root and worker requests close independently', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' });
  send('codex', 'SubagentStart', { session: 'root', worker: 'w1' });
  send('codex', 'PermissionRequest', { session: 'root', worker: 'w1' });
  send('codex', 'PreToolUse', { session: 'root' });
  assert.equal(only(t.episodesOf('codex:root')).closed, true);
  assert.equal(only(t.episodesOf('codex:w1')).closed, false);
  send('codex', 'SubagentStop', { session: 'root', worker: 'w1' });
  assert.equal(only(t.episodesOf('codex:w1')).closed, true);
  assert.equal(t.episodesOf('codex:w1').some((episode) => episode.kind === 'completion'), false);
});

test('Claude sub-agents sharing a session are one aggregate source (accepted v1 limitation)', () => {
  const { t, send } = scenario();
  send('claude-code', 'UserPromptSubmit', { session: 's' });
  send('claude-code', 'Notification:permission_prompt', { session: 's' });
  // Another sub-agent's tool start carries the same native session id.
  send('claude-code', 'PreToolUse', { session: 's' });
  assert.equal(Object.keys(t.state.sources).length, 1);
  const claudeAliasedApproval = only(t.episodesOf('claude-code:s'));
  assert.equal(claudeAliasedApproval.closed, true); // explicit v1 limitation
});

test('root teardown closes root and worker attention and clears its history', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' });
  send('codex', 'SubagentStart', { session: 'root', worker: 'w1' });
  send('codex', 'PermissionRequest', { session: 'root', worker: 'w1' });
  const workerApproval = only(t.episodesOf('codex:w1'));
  send('codex', 'Stop', { session: 'root' });
  assert.notDeepEqual(t.state.diagnostics, {});
  const result = send('codex', 'SessionEnd', { session: 'root' });
  assert.deepEqual(result.closed, [workerApproval.id]);
  assert.deepEqual(t.state.sources, {});
  assert.deepEqual(t.state.episodes, {});
  assert.deepEqual(t.state.turns, {});
  assert.deepEqual(t.state.diagnostics, {});
});

test('repeated observations of the same waiting state keep one episode', () => {
  const { t, r, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' });
  const first = only(t.episodesOf('codex:root'));
  send('codex', 'PermissionRequest', { session: 'root' });
  t.observe(r.rows());
  assert.equal(only(t.episodesOf('codex:root')).id, first.id);
});

test('a delayed envelope older than the source frontier cannot reopen a closed request', () => {
  const { t, r, send } = scenario();
  const request = nativeEvent('codex', 'PermissionRequest', { session: 'root' });
  r.apply(request);
  t.observe(r.rows(), request);
  const requestRevision = t.revision;
  send('codex', 'PreToolUse', { session: 'root' });
  t.observe(r.rows(), request, requestRevision);
  const episodes = t.episodesOf('codex:root');
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].closed, true);
});

test('a newer envelope applies its state before the later snapshot reconciles', () => {
  const { t, r, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' });
  const first = only(t.episodesOf('codex:root'));
  // The tool start (revision n+1) and a second request (n+2) both published before this
  // observer ran; it reads the later snapshot but must not lose the intervening activity.
  const tool = nativeEvent('codex', 'PreToolUse', { session: 'root' });
  r.apply(tool);
  r.apply(nativeEvent('codex', 'PermissionRequest', { session: 'root' }));
  t.observe(r.rows(), tool, t.revision + 1, { snapshotAhead: 1 });
  const episodes = t.episodesOf('codex:root');
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].id, first.id);
  assert.equal(episodes[0].closed, true);
  assert.equal(episodes[1].closed, false);
});

test('a stale snapshot older than the recorded registry revision changes nothing', () => {
  const { t, r, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' });
  const before = structuredClone(t.state);
  r.replace('codex:root', { state: 'working' });
  const result = t.observeAt(r.rows(), t.revision - 1);
  assert.equal(result.stale, true);
  assert.deepEqual(t.state, before);
});

test('a replacement registry generation starts new sources an old envelope cannot touch', () => {
  const { t, r, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' });
  const old = only(t.episodesOf('codex:root'));
  t.dismiss([old.id]);
  t.observe(r.rows(), null, undefined, { gen: OTHER_GENERATION });
  const successor = only(t.episodesOf('codex:root'));
  assert.notEqual(successor.id, old.id);
  assert.equal(successor.dismissed, false);
  assert.equal(Object.hasOwn(t.state.episodes, old.id), false);
  // An envelope from the replaced generation arrives late: it is evidence about nothing.
  const late = nativeEvent('codex', 'PreToolUse', { session: 'root' });
  t.observe(r.rows(), late, 999, { gen: OTHER_GENERATION, envelopeGen: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  assert.equal(only(t.episodesOf('codex:root')).closed, false);
});

test('process reuse under the same agent id starts a new incarnation', () => {
  const { t, r, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' }, { process: handle(42, '9000') });
  const old = only(t.episodesOf('codex:root'));
  t.dismiss([old.id]);
  r.replace('codex:root', { process: handle(42, '9999'), updatedAt: t.now + 5 });
  t.observe(r.rows());
  const fresh = only(t.episodesOf('codex:root'));
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.dismissed, false);
  assert.equal(Object.hasOwn(t.state.episodes, old.id), false);
});

test('a source without process identity gets a new incarnation after it disappears', () => {
  const { t, r, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' }, { process: null });
  const firstKey = t.sourceKeyOf('codex:root');
  const first = only(t.episodesOf('codex:root'));
  r.remove('codex:root');
  t.observe(r.rows());
  send('codex', 'PermissionRequest', { session: 'root' }, { process: null });
  assert.notEqual(t.sourceKeyOf('codex:root'), firstKey);
  assert.notEqual(only(t.episodesOf('codex:root')).id, first.id);
});

// --- completed turns ---------------------------------------------------------------

test('OpenCode working → done → idle → idle keeps one completed turn through restart', () => {
  const { t, send } = scenario();
  send('opencode', 'init', { session: 'oc' });
  send('opencode', 'session.busy', { session: 'oc' });
  send('opencode', 'session.idle', { session: 'oc' });
  const completed = only(t.episodesOf('opencode:oc'));
  assert.equal(completed.kind, 'completion');
  const rootKey = t.sourceKeyOf('opencode:oc');
  t.desktop({ focused: '1', origins: { 'opencode:oc': '2' } });
  t.claim('toast', 'coordinator-1', 'tok');
  t.finish('toast', 'tok', 'delivered');
  send('opencode', 'session.idle', { session: 'oc' });
  send('opencode', 'session.idle', { session: 'oc' });
  t.restart();
  const afterPassiveIdle = t.state;
  assert.equal(afterPassiveIdle.turns[rootKey].episodeId, completed.id);
  assert.equal(afterPassiveIdle.episodes[completed.id].closed, false);
  assert.equal(afterPassiveIdle.episodes[completed.id].delivery.toast.status, 'delivered');
  assert.equal(t.claim('toast', 'coordinator-2', 'tok-2').ids.length, 0);
  send('opencode', 'session.busy', { session: 'oc' });
  assert.equal(t.state.episodes[completed.id].closed, true);
  assert.equal(Object.hasOwn(t.state.turns, rootKey), false);
});

test('OpenCode init → idle and error → idle are not completions', () => {
  const { t, send } = scenario();
  send('opencode', 'init', { session: 'oc' });
  send('opencode', 'session.idle', { session: 'oc' });
  assert.equal(t.episodesOf('opencode:oc').length, 0);
  send('opencode', 'session.busy', { session: 'oc' });
  send('opencode', 'session.error', { session: 'oc' });
  send('opencode', 'session.idle', { session: 'oc' });
  const episodes = t.episodesOf('opencode:oc');
  assert.deepEqual(episodes.map((episode) => [episode.kind, episode.closed]), [['error', false]]);
});

test('an OpenCode permission reply closes the approval through the aggregate update', () => {
  const { t, send } = scenario();
  send('opencode', 'session.busy', { session: 'oc' });
  send('opencode', 'permission.pending', { session: 'oc' });
  send('opencode', 'session.idle', { session: 'oc' });
  const [approval, completion] = t.episodesOf('opencode:oc');
  assert.equal(approval.kind, 'needs-approval');
  assert.equal(approval.closed, true);
  assert.equal(completion.kind, 'completion');
});

test('an initially focused completion records the turn without a marker or toast', () => {
  const { t, send } = scenario();
  send('claude-code', 'UserPromptSubmit', { session: 's' });
  send('claude-code', 'Stop', { session: 's' });
  t.desktop({ focused: '1', origins: { 'claude-code:s': '1' } });
  const completed = only(t.episodesOf('claude-code:s'));
  assert.equal(completed.seen, true);
  assert.equal(completed.delivery.toast.status, 'suppressed');
  assert.equal(completed.delivery.popup.status, 'eligible');
  assert.equal(t.state.turns[t.sourceKeyOf('claude-code:s')].episodeId, completed.id);
});

test('a late idle-input upgrades the same completed turn without a new opportunity', () => {
  const { t, send } = scenario();
  send('claude-code', 'UserPromptSubmit', { session: 's' });
  send('claude-code', 'Stop', { session: 's' });
  t.desktop({ focused: '1', origins: { 'claude-code:s': '1' } });
  const completedId = only(t.episodesOf('claude-code:s')).id;
  t.claim('popup', 'popup-1', 'p1');
  t.finish('popup', 'p1', 'delivered');
  t.restart();
  send('claude-code', 'Notification:idle_prompt', { session: 's' });
  t.desktop({ focused: '1', origins: { 'claude-code:s': '1' } });
  const afterFocusedThenIdleInput = t.state;
  const upgraded = only(t.episodesOf('claude-code:s'));
  assert.equal(upgraded.id, completedId);
  assert.equal(upgraded.kind, 'needs-input');
  assert.equal(upgraded.seen, true);
  assert.equal(afterFocusedThenIdleInput.episodes[completedId].delivery.toast.status, 'suppressed');
  assert.equal(afterFocusedThenIdleInput.episodes[completedId].delivery.popup.status, 'delivered');
  assert.equal(t.claim('popup', 'popup-1', 'p2').ids.length, 0);
});

test('a dismissed completion stays dismissed through the late idle-input upgrade', () => {
  const { t, send } = scenario();
  send('claude-code', 'UserPromptSubmit', { session: 's' });
  send('claude-code', 'Stop', { session: 's' });
  t.desktop({ focused: '1', origins: { 'claude-code:s': '2' } });
  const completedId = only(t.episodesOf('claude-code:s')).id;
  t.dismiss([completedId]);
  send('claude-code', 'Notification:idle_prompt', { session: 's' });
  const afterDismissThenIdleInput = t.state;
  assert.equal(afterDismissThenIdleInput.episodes[completedId].dismissed, true);
  assert.equal(afterDismissThenIdleInput.episodes[completedId].kind, 'needs-input');
  assert.equal(afterDismissThenIdleInput.episodes[completedId].delivery.toast.status, 'suppressed');
});

test('genuine new root activity ends the turn association (control)', () => {
  const { t, send } = scenario();
  send('claude-code', 'UserPromptSubmit', { session: 's' });
  send('claude-code', 'Stop', { session: 's' });
  const completedId = only(t.episodesOf('claude-code:s')).id;
  send('claude-code', 'UserPromptSubmit', { session: 's' });
  assert.deepEqual(t.state.turns, {});
  send('claude-code', 'Notification:idle_prompt', { session: 's' });
  const episodes = t.episodesOf('claude-code:s');
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].id, completedId);
  assert.equal(episodes[0].closed, true);
  assert.equal(episodes[1].kind, 'needs-input');
  assert.notEqual(episodes[1].id, completedId);
});

test('a seen completion keeps its turn history through passive reconciliation', () => {
  const { t, r, send } = scenario();
  send('claude-code', 'UserPromptSubmit', { session: 's' });
  send('claude-code', 'Stop', { session: 's' });
  t.desktop({ focused: '2', origins: { 'claude-code:s': '2' } });
  const rootKey = t.sourceKeyOf('claude-code:s');
  const id = t.state.turns[rootKey].episodeId;
  t.observe(r.rows());
  t.tick(60_000);
  t.observe(r.rows());
  assert.equal(t.state.turns[rootKey].episodeId, id);
  assert.equal(t.state.episodes[id].seen, true);
});

test('a new request supersedes the visible completion but keeps the turn history', () => {
  const { t, send } = scenario();
  send('claude-code', 'UserPromptSubmit', { session: 's' });
  send('claude-code', 'Stop', { session: 's' });
  const rootKey = t.sourceKeyOf('claude-code:s');
  const completedId = t.state.turns[rootKey].episodeId;
  send('claude-code', 'Notification:permission_prompt', { session: 's' });
  assert.equal(t.state.episodes[completedId].closed, true);
  assert.equal(t.state.turns[rootKey].episodeId, completedId);
});

test('Codex reports no input or error events, so none are fabricated', () => {
  const codex = adapterFor('codex');
  const levels = Object.keys(codex.events).map((native) => codex.stateForEvent(native));
  assert.equal(levels.includes('needs-input'), false);
  assert.equal(levels.includes('error'), false);
  const { t, send } = scenario();
  for (const native of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop']) {
    send('codex', native, { session: 'root' });
  }
  const kinds = new Set(t.episodesOf('codex:root').map((episode) => episode.kind));
  assert.deepEqual([...kinds].sort(), ['completion', 'needs-approval']);
});

test('approval episodes from every harness share one kind', () => {
  const { t, send } = scenario();
  send('claude-code', 'Notification:permission_prompt', { session: 'c' });
  send('codex', 'PermissionRequest', { session: 'x' });
  send('codex', 'SubagentStart', { session: 'x', worker: 'w' });
  send('codex', 'PermissionRequest', { session: 'x', worker: 'w' });
  send('opencode', 'permission.pending', { session: 'o' });
  const kinds = Object.values(t.state.episodes).map((episode) => episode.kind);
  assert.deepEqual(kinds, ['needs-approval', 'needs-approval', 'needs-approval', 'needs-approval']);
});

// --- dispositions and the unconfirmed-worker diagnostic ----------------------------

test('dismissing a stale ID affects no successor and unknown IDs are reported missing', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'root' });
  const old = only(t.episodesOf('codex:root'));
  send('codex', 'PreToolUse', { session: 'root' });
  send('codex', 'PermissionRequest', { session: 'root' });
  const successor = t.episodesOf('codex:root', { open: true })[0];
  const result = t.dismiss([old.id, 'e999', '__proto__', 'constructor']);
  assert.deepEqual(result.dismissedIds, [old.id]);
  assert.deepEqual(result.missingIds, ['e999', '__proto__', 'constructor']);
  assert.equal(t.state.episodes[successor.id].dismissed, false);
});

function blockedRoot() {
  const s = scenario();
  s.send('codex', 'UserPromptSubmit', { session: 'root' });
  s.send('codex', 'SubagentStart', { session: 'root', worker: 'w1' });
  s.send('codex', 'Stop', { session: 'root' });
  return s;
}

test('a missing worker stop withholds completions behind one stable diagnostic', () => {
  const { t, send } = blockedRoot();
  const [diagnostic] = Object.values(t.state.diagnostics);
  assert.deepEqual(diagnostic.blockers, [t.sourceKeyOf('codex:w1')]);
  assert.equal(diagnostic.rootKey, t.sourceKeyOf('codex:root'));
  const firstObservation = diagnostic.observedAt;
  send('codex', 'UserPromptSubmit', { session: 'root' });
  send('codex', 'Stop', { session: 'root' });
  assert.deepEqual(Object.keys(t.state.diagnostics), [diagnostic.id]);
  assert.ok(t.state.diagnostics[diagnostic.id].observedAt > firstObservation);
  assert.equal(t.episodesOf('codex:root').some((episode) => episode.kind === 'completion'), false);
});

test('dismissing the diagnostic never unlocks completion', () => {
  const { t, send } = blockedRoot();
  const [id] = Object.keys(t.state.diagnostics);
  assert.deepEqual(t.dismiss([id]).dismissedIds, [id]);
  send('codex', 'UserPromptSubmit', { session: 'root' });
  send('codex', 'Stop', { session: 'root' });
  assert.equal(t.state.diagnostics[id].dismissed, true);
  assert.equal(t.episodesOf('codex:root').some((episode) => episode.kind === 'completion'), false);
  assert.equal(t.state.sources[t.sourceKeyOf('codex:w1')].state, 'working');
});

test('a changed blocker set gets a new diagnostic that an old click cannot dismiss', () => {
  const { t, send } = blockedRoot();
  const [old] = Object.keys(t.state.diagnostics);
  t.dismiss([old]);
  send('codex', 'SubagentStart', { session: 'root', worker: 'w2' });
  send('codex', 'UserPromptSubmit', { session: 'root' });
  send('codex', 'Stop', { session: 'root' });
  const ids = Object.keys(t.state.diagnostics);
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], old);
  t.dismiss([old]);
  assert.equal(t.state.diagnostics[ids[0]].dismissed, false);
  assert.equal(t.state.diagnostics[ids[0]].blockers.length, 2);
});

test('clearing the blockers closes the diagnostic without replaying the withheld completion', () => {
  const { t, send } = blockedRoot();
  send('codex', 'SubagentStop', { session: 'root', worker: 'w1' });
  assert.deepEqual(t.state.diagnostics, {});
  assert.equal(t.episodesOf('codex:root').length, 0);
  send('codex', 'UserPromptSubmit', { session: 'root' });
  send('codex', 'Stop', { session: 'root' });
  assert.equal(only(t.episodesOf('codex:root')).kind, 'completion');
});

test('the diagnostic and its dismissal survive restart', () => {
  const { t } = blockedRoot();
  const [id] = Object.keys(t.state.diagnostics);
  t.dismiss([id]);
  t.restart();
  assert.equal(t.state.diagnostics[id].dismissed, true);
});

test('a stranded worker approval blocks completion and keeps its unconfirmed observation', () => {
  const { t, send } = scenario();
  send('codex', 'UserPromptSubmit', { session: 'root' });
  send('codex', 'SubagentStart', { session: 'root', worker: 'w1' });
  send('codex', 'PermissionRequest', { session: 'root', worker: 'w1' });
  send('codex', 'Stop', { session: 'root' });
  assert.equal(Object.keys(t.state.diagnostics).length, 1);
  t.tick(8 * 3600_000);
  t.restart();
  assert.equal(only(t.episodesOf('codex:w1')).closed, false);
});

for (const [harness, native, session] of [
  ['claude-code', 'Notification:permission_prompt', 'c'],
  ['codex', 'PermissionRequest', 'x'],
]) {
  test(`a ${harness} approval left ten minutes without an observation is not guessed closed`, () => {
    const { t, r, send } = scenario();
    send(harness, native, { session });
    const agentId = `${harness}:${session}`;
    t.desktop({ focused: '1', origins: { [agentId]: '2' } });
    t.tick(10 * 60_000);
    t.observe(r.rows());
    t.desktop({ focused: '1', origins: { [agentId]: '2' } });
    const approval = only(t.episodesOf(agentId));
    assert.equal(approval.closed, false);
    assert.equal(approval.seen, false);
    t.desktop({ focused: '2', origins: { [agentId]: '2' } });
    assert.equal(only(t.episodesOf(agentId)).seen, true);
    assert.equal(only(t.episodesOf(agentId)).closed, false);
    t.dismiss([approval.id]);
    assert.equal(only(t.episodesOf(agentId)).dismissed, true);
    assert.equal(only(t.episodesOf(agentId)).closed, false);
    send(harness, 'PreToolUse', { session });
    assert.equal(only(t.episodesOf(agentId)).closed, true);
  });
}

// --- classification, DND and delivery ------------------------------------------------

test('unknown DND suppresses queued opportunities durably and known/off replays nothing', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  const old = only(t.episodesOf('codex:a'));
  t.desktop({ focused: '1', origins: { 'codex:a': '2' }, dnd: 'unknown' });
  assert.deepEqual(t.state.episodes[old.id].delivery, { popup: { status: 'suppressed' }, toast: { status: 'suppressed' } });
  t.restart();
  t.desktop({ focused: '1', origins: { 'codex:a': '2' }, dnd: 'off' });
  const afterUnknownThenOff = t.state;
  assert.equal(afterUnknownThenOff.episodes[old.id].delivery.toast.status, 'suppressed');
  send('codex', 'PermissionRequest', { session: 'b' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2', 'codex:b': '2' }, dnd: 'off' });
  assert.deepEqual(t.claim('toast', 'coordinator-2', 'tok').ids, [only(t.episodesOf('codex:b')).id]);
});

test('DND on suppresses eligible opportunities but leaves an in-flight send to finish', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  const sent = t.claim('toast', 'coordinator-1', 'tok');
  send('codex', 'PermissionRequest', { session: 'b' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2', 'codex:b': '2' } });
  const queued = only(t.episodesOf('codex:b'));
  assert.equal(queued.delivery.toast.status, 'eligible');
  t.desktop({ focused: '1', origins: { 'codex:a': '2', 'codex:b': '2' }, dnd: 'on' });
  assert.equal(t.state.episodes[sent.ids[0]].delivery.toast.status, 'reserved');
  assert.equal(t.state.episodes[queued.id].delivery.toast.status, 'suppressed');
  assert.equal(t.state.episodes[queued.id].delivery.popup.status, 'suppressed');
  t.finish('toast', 'tok', 'delivered');
  assert.equal(t.state.episodes[sent.ids[0]].delivery.toast.status, 'delivered');
});

test('a reservation is recorded before the send and never retried automatically', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  const id = only(t.episodesOf('codex:a')).id;
  const claim = t.claim('toast', 'coordinator-1', 'tok-1');
  assert.deepEqual(claim, { token: 'tok-1', ids: [id] });
  assert.deepEqual(t.state.episodes[id].delivery.toast, { status: 'reserved', token: 'tok-1', consumer: 'coordinator-1', at: t.now });
  assert.deepEqual(t.claim('toast', 'coordinator-1', 'tok-2'), { token: null, ids: [] });
  t.finish('toast', 'tok-1', 'failed');
  assert.equal(t.state.episodes[id].delivery.toast.status, 'failed');
  assert.deepEqual(t.claim('toast', 'coordinator-1', 'tok-3'), { token: null, ids: [] });
});

test('only currently eligible episodes can be reserved', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  assert.deepEqual(t.claim('popup', 'popup-1', 'p'), { token: null, ids: [] }); // unclassified
  send('codex', 'PermissionRequest', { session: 'b' });
  send('codex', 'PermissionRequest', { session: 'c' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2', 'codex:b': '2', 'codex:c': '2' } });
  t.dismiss([only(t.episodesOf('codex:b')).id]);
  send('codex', 'PreToolUse', { session: 'c' });
  const claimed = t.claim('popup', 'popup-1', 'p1');
  assert.deepEqual(claimed.ids, [only(t.episodesOf('codex:a')).id]);
  assert.deepEqual(t.claim('popup', 'popup-1', 'p2'), { token: null, ids: [] });
});

test('popup claims take one episode at a time, error before approval', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  send('opencode', 'session.error', { session: 'o' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2', 'opencode:o': '2' } });
  assert.deepEqual(t.claim('popup', 'popup-1', 'p1').ids, [only(t.episodesOf('opencode:o')).id]);
  assert.deepEqual(t.claim('popup', 'popup-1', 'p2').ids, [only(t.episodesOf('codex:a')).id]);
});

test('an old token cannot finish a newer reservation', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  t.claim('popup', 'popup-1', 'new');
  const result = t.finish('popup', 'old', 'delivered');
  assert.deepEqual(result.finishedIds, []);
  assert.equal(only(t.episodesOf('codex:a')).delivery.popup.status, 'reserved');
});

test('popup initialisation suppresses only the explicit initial IDs', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  send('codex', 'PermissionRequest', { session: 'b' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2', 'codex:b': '2' } });
  const a = only(t.episodesOf('codex:a'));
  const b = only(t.episodesOf('codex:b'));
  t.initialise('popup-2', [a.id, 'e999']);
  assert.equal(t.state.episodes[a.id].delivery.popup.status, 'suppressed');
  assert.equal(t.state.episodes[b.id].delivery.popup.status, 'eligible');
  assert.equal(t.state.episodes[a.id].delivery.toast.status, 'eligible');
});

test('recovery marks a previous instance reservation uncertain and suppresses queued IDs', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  t.claim('toast', 'coordinator-1', 'tok');
  send('codex', 'PermissionRequest', { session: 'b' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2', 'codex:b': '2' } });
  t.restart('coordinator-2');
  const afterRestartUncertain = t.state;
  assert.equal(afterRestartUncertain.episodes[only(t.episodesOf('codex:a')).id].delivery.toast.status, 'uncertain');
  assert.equal(afterRestartUncertain.episodes[only(t.episodesOf('codex:b')).id].delivery.toast.status, 'suppressed');
  assert.deepEqual(t.claim('toast', 'coordinator-2', 'tok-2'), { token: null, ids: [] });
  t.finish('toast', 'tok', 'delivered');
  assert.equal(t.state.episodes[only(t.episodesOf('codex:a')).id].delivery.toast.status, 'uncertain');
});

test('an unmapped request may toast generically but an unmapped completion may not', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  send('codex', 'UserPromptSubmit', { session: 'b' });
  send('codex', 'Stop', { session: 'b' });
  t.desktop({ focused: '1', origins: {} });
  assert.equal(only(t.episodesOf('codex:a')).delivery.toast.status, 'eligible');
  const completion = only(t.episodesOf('codex:b'));
  assert.equal(completion.delivery.toast.status, 'suppressed');
  assert.equal(completion.seen, false);
});

test('an unfocused completion is eligible for one low-priority toast', () => {
  const { t, send } = scenario();
  send('codex', 'UserPromptSubmit', { session: 'b' });
  send('codex', 'Stop', { session: 'b' });
  t.desktop({ focused: '1', origins: { 'codex:b': '2' } });
  const completion = only(t.episodesOf('codex:b'));
  assert.equal(completion.seen, false);
  assert.equal(completion.delivery.toast.status, 'eligible');
});

test('visible-but-unfocused is unseen; moving onto the focused workspace marks it seen', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  assert.equal(only(t.episodesOf('codex:a')).seen, false);
  t.desktop({ focused: '1', origins: { 'codex:a': '1' } });
  assert.equal(only(t.episodesOf('codex:a')).seen, true);
});

test('a deferred focus visit marks only its explicit IDs seen', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  const visited = only(t.episodesOf('codex:a'));
  send('codex', 'PermissionRequest', { session: 'b' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2', 'codex:b': '2' } });
  t.desktop({ focused: '2', origins: { 'codex:a': '2', 'codex:b': '2' }, seenIds: [visited.id] });
  assert.equal(t.state.episodes[visited.id].seen, true);
  assert.equal(only(t.episodesOf('codex:b')).seen, false);
});

test('an unknown desktop leaves new episodes unclassified', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ status: 'disconnected' });
  assert.equal(only(t.episodesOf('codex:a')).delivery.toast.status, 'pending');
});

test('closing an episode cancels its queued deliveries', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  send('codex', 'PreToolUse', { session: 'a' });
  assert.deepEqual(only(t.episodesOf('codex:a')).delivery, { popup: { status: 'suppressed' }, toast: { status: 'suppressed' } });
});

test('dismissal cancels queued deliveries but not an in-flight one', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  t.claim('toast', 'coordinator-1', 'tok');
  const id = only(t.episodesOf('codex:a')).id;
  t.dismiss([id]);
  assert.equal(t.state.episodes[id].delivery.toast.status, 'reserved');
  assert.equal(t.state.episodes[id].delivery.popup.status, 'suppressed');
});

test('initial recovery restores static requests without transient opportunities', () => {
  const t = traceAttention();
  const r = createRegistry({ now: () => t.now });
  r.apply(nativeEvent('codex', 'PermissionRequest', { session: 'a' }));
  r.apply(nativeEvent('codex', 'UserPromptSubmit', { session: 'b' }));
  r.apply(nativeEvent('codex', 'Stop', { session: 'b' }));
  t.observe(r.rows());
  const restored = only(t.episodesOf('codex:a'));
  assert.equal(restored.closed, false);
  assert.deepEqual(restored.delivery, { popup: { status: 'suppressed' }, toast: { status: 'suppressed' } });
  assert.equal(t.episodesOf('codex:b').length, 0);
});

// --- state shape ---------------------------------------------------------------------

test('the revision changes only when attention changes', () => {
  const { t, r, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  const revision = t.state.revision;
  t.observe(r.rows());
  assert.equal(t.state.revision, revision);
  t.dismiss([only(t.episodesOf('codex:a')).id]);
  assert.equal(t.state.revision, revision + 1);
});

test('closed episodes of a live source are bounded', () => {
  const { t, send } = scenario();
  for (let i = 0; i < 20; i++) {
    send('codex', 'PermissionRequest', { session: 'a' });
    send('codex', 'PreToolUse', { session: 'a' });
  }
  assert.ok(t.episodesOf('codex:a').length <= 8);
});

test('validateAttention accepts the initial state and rejects unknown or malformed fields', () => {
  assert.deepEqual(validateAttention(initialAttention()), initialAttention());
  const bad = [
    { ...initialAttention(), schema: 2 },
    { ...initialAttention(), extra: true },
    { ...initialAttention(), revision: -1 },
    { ...initialAttention(), episodes: { e1: { id: 'e1' } } },
    null,
  ];
  for (const value of bad) assert.throws(() => validateAttention(value), { name: 'AttentionSchemaError' });
});

test('reduceAttention rejects an unknown input', () => {
  assert.throws(() => reduceAttention(initialAttention(), { type: 'patch', now: 1 }), { name: 'AttentionSchemaError' });
});

test('finish can settle part of a reservation by explicit IDs', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  send('codex', 'PermissionRequest', { session: 'b' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2', 'codex:b': '3' } });
  const { ids } = t.claim('toast', 'coordinator-1', 'tok');
  const out = reduceAttention(t.state, { type: 'finish', surface: 'toast', token: 'tok', outcome: 'delivered', ids: [ids[0], 'e999'], now: t.now + 1 });
  assert.deepEqual(out.result.finishedIds, [ids[0]]);
  assert.equal(out.state.episodes[ids[0]].delivery.toast.status, 'delivered');
  assert.equal(out.state.episodes[ids[1]].delivery.toast.status, 'reserved');
});

test('recovery records the new coordinator before it can publish a heartbeat', () => {
  const { t, send } = scenario();
  send('codex', 'PermissionRequest', { session: 'a' });
  t.desktop({ focused: '1', origins: { 'codex:a': '2' } });
  assert.equal(t.state.desktop.instanceId, 'coordinator-1');
  t.restart('coordinator-2');
  assert.equal(t.state.desktop.instanceId, 'coordinator-2');
  // It vouches for nothing it has not observed itself: no claim until its first pass.
  assert.equal(t.state.desktop.status, 'unknown');
  send('codex', 'PermissionRequest', { session: 'b' });
  assert.deepEqual(t.claim('popup', 'popup-1', 'p'), { token: null, ids: [] });
});
