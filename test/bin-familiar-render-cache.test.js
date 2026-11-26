// The status line's render cache: what a hit loads, when a line is served, and when it is not.
import { readSessions, writeSessions } from '../src/bus/sessions.js';
import { terminalOwnerPaths } from '../src/render/term/terminal-owner.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strip } from '../src/render/term/sgr.js';
import { paths } from '../src/bus/paths.js';
import { ledgerPaths } from '../src/render/term/ledger.js';
import { RENDER_TTL_MS, renderCacheDir, renderCachePath } from '../src/render/term/render-cache.js';
import { PLACEHOLDER } from '../src/render/term/placeholder.js';
import { writeTheme } from './helpers/themes.js';
import { git } from './fixtures/git-worktree.mjs';
import {
  bin, traceHook, traceSkip, heavyModule, statuslineEnv, statusline, seedBus, stageFixture,
  SENTINEL, plantSentinel, atClock,
} from './helpers/familiar-cli.js';

// The spec's cold cost gate, as what a render-cache hit loads. A session with no live claim
// and no session file loads stagesession.js and none of the stage reader's modules; one with
// a task loads the stage reader, and never the refresher's graph or the HUD's.
function tracedStatusline(t, e, payload) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-imports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, 'trace.txt');
  writeFileSync(trace, '');
  const result = spawnSync(process.execPath, ['--import', traceHook, bin, 'statusline'], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...e, FAMILIAR_TRACE_IMPORTS: trace },
  });
  assert.equal(result.status, 0, result.stderr);
  return { result, loaded: readFileSync(trace, 'utf8').split('\n').filter(Boolean) };
}
const termModule = (name) => (url) => url.endsWith(`/src/render/term/${name}`);

test('a render-cache hit with no task loads only the session-file check', { skip: traceSkip }, async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'taskless');
  f.render('taskless');
  plantSentinel(f.e, 'taskless');
  const { result, loaded } = tracedStatusline(t, f.e, { session_id: 'taskless', cwd: f.dirs.worktree });
  assert.equal(result.stdout, SENTINEL);
  assert.equal(result.stderr, '');
  const stage = ['stagecache.js', 'stagerefresh.js', 'stage.js', 'absent.js', 'hud.js'];
  assert.deepEqual(loaded.filter((url) => stage.some((name) => termModule(name)(url))), []);
  assert.ok(loaded.some(termModule('stagesession.js')), 'the trace saw the session-file check');
  assert.equal(existsSync(join(f.dirs.state, 'statusline')), false, 'no task, no session file');
});

test('a render-cache hit with a task loads the stage reader, not the refresher or the HUD', { skip: traceSkip }, async (t) => {
  const f = stageFixture(t);
  await seedBus(f.e, 'tasked');
  f.claim('tasked');
  f.writeFreshCache('designed');
  f.render('tasked');
  plantSentinel(f.e, 'tasked');
  rmSync(join(f.root, 'tasks.log'), { force: true });
  const { result, loaded } = tracedStatusline(t, f.e, { session_id: 'tasked', cwd: f.dirs.worktree });
  assert.equal(result.stdout, SENTINEL);
  assert.equal(result.stderr, '');
  const heavy = ['stagerefresh.js', 'stage.js', 'hud.js'];
  assert.deepEqual(loaded.filter((url) => heavy.some((name) => termModule(name)(url))), []);
  assert.ok(loaded.some(termModule('stagecache.js')), 'the trace saw the stage read');
  assert.deepEqual(f.log(), ['claims --json'], 'a fresh cache starts no refresher');
});

// --- decay -----------------------------------------------------------------
//
// bin/familiar took `.current`, which discards expiresAt. That was survivable while the status
// line ran about once a turn. POLLING MAKES IT PERMANENT: done carries an 8s TTL and error a
// 30s one, so a polled HUD reading .current shows the transient state every two seconds,
// forever.

for (const state of ['done', 'error']) {
  test(`an expired ${state} decays to idle rather than showing ${state} forever`, async () => {
    const e = statuslineEnv();
    const sessionId = `decays-${state}`;
    await seedBus(e, sessionId, { state });
    const result = statusline({ ...e, FAMILIAR_NOW_MS: String(Date.now() + 60_000) }, [], {
      session_id: sessionId, cwd: process.cwd(),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /idle/);
    assert.doesNotMatch(result.stdout, new RegExp(state));
  });
}

// --- the render cache --------------------------------------------------------

test('an unchanged poll is served from the render cache, and a changed input renders afresh', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'cached');
  const payload = { session_id: 'cached', cwd: process.cwd(), context_window: { used_percentage: 22 } };
  const first = statusline(e, [], payload);
  assert.equal(first.status, 0, first.stderr);
  assert.match(strip(first.stdout), /22%/);

  plantSentinel(e, 'cached');
  assert.equal(statusline(e, [], payload).stdout, SENTINEL);

  const moved = statusline(e, [], { ...payload, context_window: { used_percentage: 23 } });
  assert.match(strip(moved.stdout), /23%/, 'a payload field the HUD shows is part of the key');

  plantSentinel(e, 'cached');
  await seedBus(e, 'cached', { state: 'idle' });
  const record = statusline(e, [], { ...payload, context_window: { used_percentage: 23 } });
  assert.match(strip(record.stdout), /idle/, 'this session\'s bus record is part of the key');

  plantSentinel(e, 'cached');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'motion: off\n');
  const config = statusline(e, [], { ...payload, context_window: { used_percentage: 23 } });
  assert.notEqual(config.stdout, SENTINEL, 'config.yaml is part of the key');
  assert.ok(!config.stdout.includes(PLACEHOLDER), 'motion off drops the cells');
});

// Which pack a session draws from is keyed already: its family and role are on its record,
// and `families:` is in config.yaml. The pack itself is keyed by each installed theme's
// descriptor, so `theme add` (with or without --replace, which renames a new pack into place),
// `theme remove` and an edit to a theme.yaml (its roles, rows or world) are each a miss, in the
// user's themes and the shipped ones alike, without the hit path reading any YAML.
test('a family, a role, a families: entry and a theme pack added, edited, replaced or removed are each a miss', async () => {
  const shipped = mkdtempSync(join(tmpdir(), 'familiar-keyed-themes-'));
  writeTheme(shipped, 'cats');
  const e = { ...statuslineEnv(), FAMILIAR_THEMES_DIR: shipped };
  const userThemes = join(e.FAMILIAR_CONFIG_DIR, 'themes');
  writeTheme(userThemes, 'forest');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\n');
  await seedBus(e, 'keyed');
  const payload = { session_id: 'keyed', cwd: process.cwd() };
  const miss = (label) => {
    const result = statusline(e, [], payload);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.stdout, SENTINEL, label);
  };
  miss('first render');
  plantSentinel(e, 'keyed');
  assert.equal(statusline(e, [], payload).stdout, SENTINEL, 'an unchanged poll hits');

  const setRecord = async (fields) => {
    const store = await readSessions(paths(e).sessionsPath);
    Object.assign(store.sessions.keyed, fields);
    await writeSessions(paths(e).sessionsPath, store);
  };
  await setRecord({ family: 'guild' });
  miss('the record\'s family is part of the key');
  plantSentinel(e, 'keyed');
  await setRecord({ role: 'reviewer' });
  miss('the record\'s role is part of the key');
  plantSentinel(e, 'keyed');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nfamilies:\n  guild: forest\n');
  miss('families: is part of the key');

  plantSentinel(e, 'keyed');
  const descriptor = join(userThemes, 'forest', 'theme.yaml');
  writeFileSync(descriptor, readFileSync(descriptor, 'utf8').replace('rows: 4', 'rows: 3'));
  miss('an edit to the family theme\'s theme.yaml is part of the key');

  plantSentinel(e, 'keyed');
  renameSync(join(userThemes, 'forest'), join(userThemes, '.forest-backup'));
  writeTheme(userThemes, 'forest');
  miss('a pack renamed into place (theme add --replace) is part of the key');

  plantSentinel(e, 'keyed');
  writeTheme(userThemes, 'plants');
  miss('a newly added theme is part of the key');

  plantSentinel(e, 'keyed');
  rmSync(join(userThemes, 'plants'), { recursive: true });
  miss('a removed theme is part of the key');

  plantSentinel(e, 'keyed');
  const shippedDescriptor = join(shipped, 'cats', 'theme.yaml');
  writeFileSync(shippedDescriptor, readFileSync(shippedDescriptor, 'utf8').replace('label: Fixture', 'label: Edited'));
  miss('an edit to a shipped theme.yaml is part of the key');
});

test('a cached line outlives neither the TTL nor its intent\'s decay', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'decaying', { state: 'done' });
  const payload = { session_id: 'decaying', cwd: process.cwd() };
  const at = Date.now();
  assert.match(strip(statusline(atClock(e, at), [], payload).stdout), /done/);
  plantSentinel(e, 'decaying');
  assert.equal(statusline(atClock(e, at + 1000), [], payload).stdout, SENTINEL);
  const decayed = statusline(atClock(e, at + 9000), [], payload);
  assert.match(strip(decayed.stdout), /idle/, 'done decays at 8 s, cache or no cache');

  const later = at + 9000;
  plantSentinel(e, 'decaying');
  assert.equal(statusline(atClock(e, later + RENDER_TTL_MS - 1), [], payload).stdout, SENTINEL);
  assert.notEqual(statusline(atClock(e, later + RENDER_TTL_MS), [], payload).stdout, SENTINEL,
    'past the TTL the line renders again, for inputs the key does not cover');
});

test('--with output, a faulted line and a session-less payload are never cached', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'uncached');
  const cacheDir = renderCacheDir(paths(e).stateDir);
  assert.equal(statusline(e, ['--with', 'printf custom'], { session_id: 'uncached', cwd: process.cwd() }).status, 0);
  assert.equal(statusline(e, [], { session_id: '', cwd: process.cwd() }).status, 0);
  assert.equal(existsSync(cacheDir), false);

  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'identities.yaml'),
    `identities:\n  - path: ${JSON.stringify(process.cwd())}\n    slot: 0\n    members: { cats: missing-cat }\n`);
  for (let i = 0; i < 2; i++) {
    const faulted = statusline(e, [], { session_id: 'uncached', cwd: process.cwd() });
    assert.match(faulted.stderr, /missing-cat/, 'the fault is said on every poll');
  }
  assert.equal(existsSync(cacheDir), false);
});

// settle() answers noop for provisional evidence it cannot settle yet (another tmux client, tmux
// gone): the next poll must try again, as it did before the cache.
test('a line whose image is still provisional is rendered again on every poll', async () => {
  const e = statuslineEnv();
  const record = await seedBus(e, 'provisional');
  const { entryPath } = ledgerPaths(paths(e).transmitDir, 'provisional');
  mkdirSync(dirname(entryPath), { recursive: true });
  const ledger = JSON.stringify({ seq: 1, pid: record.pid, starttime: record.starttime, ended: false,
    presented: 'working', held: { provisional: true, transport: 'tmux:not-this-terminal' } });
  writeFileSync(entryPath, ledger);
  // Another session owns the terminal, so settling stops before any platform's tty probe.
  // The provisional ledger must still prevent caching even when settling is superseded.
  const owner = terminalOwnerPaths(paths(e).transmitDir, record);
  mkdirSync(dirname(owner.entryPath), { recursive: true });
  writeFileSync(owner.entryPath, JSON.stringify({ sessionId: 'another-session', seq: 2 }));
  const payload = { session_id: 'provisional', cwd: process.cwd() };
  for (let i = 0; i < 2; i++) {
    const result = statusline(e, [], payload);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  }
  assert.equal(readFileSync(entryPath, 'utf8'), ledger, 'the settle was a noop');
  assert.equal(existsSync(renderCachePath(paths(e).stateDir, 'provisional')), false);
});

// THE POINT OF THE CACHE: a hit prints without the renderer, the theme contract or YAML.
test('a cache hit loads neither the renderer nor the theme contract nor YAML', { skip: traceSkip }, async (t) => {
  const e = statuslineEnv();
  await seedBus(e, 'light');
  const payload = { session_id: 'light', cwd: process.cwd() };
  assert.equal(statusline(e, [], payload).status, 0);
  plantSentinel(e, 'light');
  const dir = mkdtempSync(join(tmpdir(), 'familiar-imports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, 'trace.txt');
  writeFileSync(trace, '');
  const result = spawnSync(process.execPath, ['--import', traceHook, bin, 'statusline'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      FAMILIAR_CONFIG_DIR: e.FAMILIAR_CONFIG_DIR,
      FAMILIAR_STATE_DIR: e.FAMILIAR_STATE_DIR,
      FAMILIAR_THEMES_DIR: e.FAMILIAR_THEMES_DIR,
      RELAY_STATE_DIR: e.RELAY_STATE_DIR,
      FAMILIAR_TRACE_IMPORTS: trace,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, SENTINEL);
  const loaded = readFileSync(trace, 'utf8').split('\n').filter(Boolean);
  assert.ok(loaded.some((url) => url.endsWith('/src/render/term/render-cache.js')), 'the trace saw the hit path');
  assert.deepEqual(loaded.filter((url) => heavyModule(url)
    || url.endsWith('/src/render/term/statusline.js') || /\/node_modules\/relay\//.test(url)), []);
});

// A session that joins the bus after a HUD-only line was cached gets its cat on the next poll.
test('a session that joins the bus after its line was cached gets its cells next poll', async () => {
  const e = statuslineEnv();
  const payload = { session_id: 'joins', cwd: process.cwd() };
  assert.ok(!statusline(e, [], payload).stdout.includes(PLACEHOLDER));
  plantSentinel(e, 'joins');
  assert.equal(statusline(e, [], payload).stdout, SENTINEL, 'the HUD-only line was cached');
  await seedBus(e, 'joins');
  assert.ok(statusline(e, [], payload).stdout.includes(PLACEHOLDER));
});

test('reap prunes the cached line of a session no longer on the bus', async () => {
  const e = statuslineEnv();
  await seedBus(e, 'kept');
  for (const sid of ['kept', 'gone']) {
    assert.equal(statusline(e, [], { session_id: sid, cwd: process.cwd() }).status, 0);
  }
  const result = spawnSync(process.execPath, [bin, 'reap'], { encoding: 'utf8', env: e });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^pruned 1 cached status line\(s\)$/m);
  assert.ok(existsSync(renderCachePath(paths(e).stateDir, 'kept')));
  assert.equal(existsSync(renderCachePath(paths(e).stateDir, 'gone')), false);
});

// WHAT THIS GUARDS, and why it stopped being a stopwatch:
//
// The status line is polled on a 2s refreshInterval, and an update arriving mid-run CANCELS
// the in-flight script. The regression that would actually break that is the status line
// growing an expensive git call -- `git status` on a large tree, a `log` walk, a fetch.
//
// This used to assert `ms < 500` on a SPAWNED SUBPROCESS, which measures the machine, not
// the code. It failed at 627ms and 848ms under a parallel suite, and at 1505ms on a tree
// with none of the desktop-moments work on it, while passing at ~400ms run alone -- so a
// red run said "this laptop was busy", never "someone slowed the status line down". A test
// that fails on load and passes on quiet is not evidence either way.
//
// So assert the thing the comment always MEANT: exactly one git call, and a cheap one.
// `symbolic-ref --short HEAD` reads one ref file. It cannot become `status` or `log`
// without this failing, deterministically, on any machine at any load.
test('a status line invocation makes exactly one cheap git call', async (t) => {
  const e = statuslineEnv();
  const probe = mkdtempSync(join(tmpdir(), 'familiar-statusline-git-calls-'));
  const fakeBin = join(probe, 'bin');
  const log = join(probe, 'git-calls');
  mkdirSync(fakeBin);
  // Records the argv, then re-execs the REAL git with fakeBin dropped from PATH. Delegating
  // rather than stubbing keeps the status line's actual output honest -- a stub that faked a
  // branch name would let a broken git call pass as long as it was still a single call.
  writeFileSync(
    join(fakeBin, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAMILIAR_GIT_CALL_LOG"\nPATH="$FAMILIAR_REAL_PATH" exec git "$@"\n`,
    { mode: 0o755 },
  );
  e.FAMILIAR_REAL_PATH = e.PATH;
  e.PATH = `${fakeBin}:${e.PATH}`;
  e.FAMILIAR_GIT_CALL_LOG = log;
  t.after(() => {
    rmSync(e.FAMILIAR_CONFIG_DIR, { recursive: true, force: true });
    rmSync(e.FAMILIAR_STATE_DIR, { recursive: true, force: true });
    rmSync(probe, { recursive: true, force: true });
  });

  // A COLD EXEC IS NOT A SECOND GIT CALL. `gitBranch` gives `symbolic-ref` a 250ms budget
  // (BRANCH_TIMEOUT_MS); on macOS the first executions of a just-written unsigned shim script
  // cost about that much on their own, so the cheap call is SIGKILLed, the `rev-parse` fallback
  // fires, and this test counts two calls for a reason that has nothing to do with familiar --
  // measured at 252ms cold and 28ms warm on an M4 during the 2026-08-23 handoff, failing 6 of 6
  // runs. One warm statusline run below was not enough, because it pays the cost at most twice.
  // Exercise the shim directly until it is warm; a genuine extra git call still fails the count.
  for (let i = 0; i < 5; i++) spawnSync(join(fakeBin, 'git'), ['--version'], { env: e });

  await seedBus(e, 'timed');
  const payload = { session_id: 'timed', cwd: process.cwd() };
  const warm = statusline(e, [], payload);
  assert.equal(warm.status, 0, warm.stderr);          // ASSERT SUCCESS BEFORE COUNTING:
  assert.ok(warm.stdout.length > 0);                  // the cheapest possible run is the crash

  writeFileSync(log, '');                             // discard the warm run's calls
  const result = statusline(e, [], payload);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').filter((l) => l.length > 0).length === 4);

  const calls = readFileSync(log, 'utf8').split('\n').filter((l) => l.length > 0);
  assert.equal(calls.length, 1, `expected one git call, got ${calls.length}:\n${calls.join('\n')}`);
  assert.match(calls[0], /symbolic-ref --short HEAD$/, `unexpected git call: ${calls[0]}`);
});
