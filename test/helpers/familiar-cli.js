// Fixtures shared by the bin-familiar*.test.js modules, which drive the CLI as a subprocess
// and are split by surface so the runner can run them in parallel.
import { applyEvent, readSnapshot, paths as relayPaths, createProcessOps as relayProcessOps } from 'relay';
import { observe } from '../../src/observe/run.js';
import { loadContext } from '../../src/observe/context.js';
import { readSessions } from '../../src/bus/sessions.js';
import * as nodeModule from 'node:module';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strip } from '../../src/render/term/sgr.js';
import { paths } from '../../src/bus/paths.js';
import { parkStorePath } from '../../src/render/term/stagerefresh.js';
import { cachePaths, mtimeStamp } from '../../src/render/term/stagecache.js';
import { renderCachePath } from '../../src/render/term/render-cache.js';
import { writeTheme } from './themes.js';

export const bin = fileURLToPath(new URL('../../bin/familiar', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// The engine ships no art: FAMILIAR_THEMES_DIR (src/bus/paths.js) redirects
// the SHIPPED themes root away from the repo's own themes/ (absent
// post-split) to this once-built fixture root, where the committed pack is
// installed under the "cats" id — the config default every test here relies
// on unless it says otherwise. Built once and reused; the pack is read-only.
export const shippedThemesFixture = mkdtempSync(join(tmpdir(), 'familiar-shipped-themes-'));
writeTheme(shippedThemesFixture, 'cats');
export function env(over = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'familiar-state-'));
  return {
    ...process.env,
    FAMILIAR_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'familiar-cfg-')),
    FAMILIAR_STATE_DIR: stateDir,
    RELAY_STATE_DIR: join(stateDir, 'relay'),
    FAMILIAR_THEMES_DIR: shippedThemesFixture,
    ...over,
  };
}

// A status line render can start the detached stage refresher, which runs `tasks` and
// flow-state (under HOME) with the render's own environment. So every statusline test runs
// with an env built key by key, never a copy of process.env: HOME and XDG_STATE_HOME are
// test-owned, git is kept off the host's config, and `tasks` is a fake (the suite's own,
// unless a test brings its own bin dir). Node's directory is on PATH for that fake's shebang.
export const suiteFakeTasks = fileURLToPath(new URL('../fixtures/fake-tasks', import.meta.url));
export function isolatedEnv({ root = mkdtempSync(join(tmpdir(), 'familiar-isolated-')), bin: fakeBin = suiteFakeTasks } = {}) {
  const dirs = { home: join(root, 'home'), xdgState: join(root, 'xdg-state'), config: join(root, 'config'), state: join(root, 'state') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return {
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dirs.home, XDG_STATE_HOME: dirs.xdgState,
    FAMILIAR_CONFIG_DIR: dirs.config, FAMILIAR_STATE_DIR: dirs.state, RELAY_STATE_DIR: join(dirs.state, 'relay'),
    FAMILIAR_THEMES_DIR: shippedThemesFixture, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
}

// A SessionEnd observer runs under relay's tightest teardown budget (codex: 267 ms at the
// default outer timeout), and most of a cold `familiar observe` was module loading. A
// teardown drops presentation state and resets the terminal: it never resolves a theme,
// reads config or draws, so it must not load the theme contract, the YAML or TOML parsers,
// or the CLI's other commands. module.registerHooks arrived in Node 22.15, and the admitted
// session's terminal owner is this test process, which only Linux can target without a tty.
export const traceHook = fileURLToPath(new URL('../fixtures/trace-imports.mjs', import.meta.url));
export const traceSkip = typeof nodeModule.registerHooks !== 'function' ? 'module.registerHooks needs Node 22.15 or later'
  : process.platform !== 'linux' ? 'the traced teardown targets a /proc terminal owner' : false;
export const heavyModule = (url) => /\/node_modules\/(familiar-theme|yaml|smol-toml)\//.test(url)
  || url.endsWith('/bin/familiar-commands.js');

// ONE env for both commands. env() mints a fresh temp config dir per call, so calling it
// twice would write the scheme into a directory the status line never reads.
export function statuslineEnv() {
  const e = isolatedEnv();
  const seeded = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], {
    encoding: 'utf8', env: e,
  });
  assert.equal(seeded.status, 0, `scheme set failed: ${seeded.stderr}`);
  return e;
}

export const statusline = (e, args, payload) => spawnSync(process.execPath, [bin, 'statusline', ...args], {
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  encoding: 'utf8',
  env: e,
});

// Publish through relay and admit through the observer without touching the live terminal.
export async function seedBus(e, sessionId, {
  state = 'working', cwd = process.cwd(), projectColor = null, repository = true,
  harness = 'claude-code',
} = {}) {
  const p = paths(e);
  const registryPaths = relayPaths(e);
  const processOps = relayProcessOps();
  const gitContext = async () => ({ remote: null, repoRoot: repository ? cwd : null,
    repositoryRoot: repository ? cwd : null });
  const kind = { working: 'prompt', idle: 'session-start', done: 'turn-end', error: 'turn-error' }[state];
  const nativeEvent = { working: 'UserPromptSubmit', idle: 'SessionStart', done: 'Stop', error: 'StopFailure' }[state];
  const event = { schema: 1, kind, harness, nativeEvent,
    sessionId, agentId: `${harness}:${sessionId}`, cwd, tool: null };
  const { snapshot } = await applyEvent(event, { paths: registryPaths, processOps,
    resolveSessionPid: () => process.pid, gitContext });
  const result = await observe({ text: JSON.stringify({
    schema: 1, type: 'event', subscriber: 'familiar', event,
    registry: { generation: snapshot.generation, revision: snapshot.revision }, changed: true, reaped: [],
  }), deps: {
    paths: p, relay: { readSnapshot: () => readSnapshot({ paths: registryPaths }) },
    relayProcess: processOps,
    adapterFor: () => ({ resolveSessionPid: () => process.pid, resolveTerminalPid: () => process.pid }),
    gitContext, lookupProjectColor: async () => ({ color: projectColor, root: null, warnings: [] }),
    loadContext: () => loadContext({ paths: p }),
    emitTransition: async () => ({ kind: 'unchanged' }), env: e,
  } });
  assert.deepEqual(result, { exitCode: 0, lines: [] });
  return (await readSessions(p.sessionsPath)).sessions[sessionId];
}

// Every subprocess here (the status line, the refresher it spawns, the fake `tasks` and
// flow-state) runs with an env built key by key: no inherited variable, HOME and the park
// store's XDG_STATE_HOME under a test-owned root, and git kept off the host's config.

export const STAGE_ID = 'fam-8f0f2b';
export const stageFakeTasks = (root) => `#!/bin/sh
printf '%s\\n' "$*" >> '${root}/tasks.log'
case "$*" in
  "claims --json") cat '${root}/claims.json' ;;
  "where --json") printf '%s' '{"project":{"prefix":"fam","records":"${root}/records"}}' ;;
  "show ${STAGE_ID} --json") printf '%s' '{"task":{"id":"${STAGE_ID}","status":"doing"}}' ;;
  "list --parked --json") printf '%s' '{"tasks":[]}' ;;
  *) echo "unexpected: $*" >&2; exit 64 ;;
esac
`;
export const stageFakeFlow = (root) => `#!/bin/sh
printf '%s\\n' "flow-state $*" >> '${root}/tasks.log'
printf '%s' '{"state":"outside"}'
`;

export function stageFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-stage-cli-')));
  const dirs = {
    bin: join(root, 'bin'), home: join(root, 'home'), xdgState: join(root, 'xdg-state'),
    tasksDir: join(root, 'records', 'tasks'), worktree: join(root, 'worktree'),
    config: join(root, 'config'), state: join(root, 'state'),
  };
  const flowDir = join(dirs.home, '.agents', 'bin');
  for (const dir of [...Object.values(dirs), flowDir]) mkdirSync(dir, { recursive: true });
  t.after(() => {
    for (const dir of [dirs.state, join(dirs.state, 'statusline')]) if (existsSync(dir)) chmodSync(dir, 0o755);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(dirs.bin, 'tasks'), stageFakeTasks(root), { mode: 0o755 });
  writeFileSync(join(flowDir, 'flow-state'), stageFakeFlow(root), { mode: 0o755 });
  writeFileSync(join(root, 'claims.json'), JSON.stringify({ claims: [] }));
  const e = isolatedEnv({ root, bin: dirs.bin });
  const seeded = spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { encoding: 'utf8', env: e });
  assert.equal(seeded.status, 0, `scheme set failed: ${seeded.stderr}`);
  const claim = (session, id = STAGE_ID) => writeFileSync(join(root, 'claims.json'), JSON.stringify({ claims: [
    { id, session, started: '2026-11-01T00:00:00Z', worktree: dirs.worktree, live: true },
  ] }));
  const cache = cachePaths(dirs.state, STAGE_ID, dirs.worktree);
  const writeFreshCache = (stage) => {
    const parkStore = parkStorePath('fam', e);
    mkdirSync(dirname(cache.file), { recursive: true });
    writeFileSync(cache.file, JSON.stringify({
      taskId: STAGE_ID, worktree: dirs.worktree,
      tasksDir: dirs.tasksDir, tasksDirMtimeNs: mtimeStamp(dirs.tasksDir),
      parkStore, parkStoreMtimeNs: mtimeStamp(parkStore),
      stage, fault: null, refreshedAt: new Date().toISOString(),
    }));
  };
  const log = () => (existsSync(join(root, 'tasks.log'))
    ? readFileSync(join(root, 'tasks.log'), 'utf8').trim().split('\n') : []);
  // The payload's cwd is the claim's worktree, which is no repository: no branch, no git write.
  const render = (sessionId) => {
    const result = statusline(e, [], { session_id: sessionId, cwd: dirs.worktree });
    assert.equal(result.status, 0, result.stderr);
    return { stateRow: strip(result.stdout).trimEnd().split('\n').at(-1), stdout: strip(result.stdout), stderr: result.stderr };
  };
  return { root, dirs, e, claim, cache, writeFreshCache, log, render };
}

// A poll whose inputs have not changed prints the cached line without loading the renderer.
// The SENTINEL proves a hit: it is written over the cached output under the same key, and only
// a hit can print it.

export const SENTINEL = 'served from the render cache\n';
export function plantSentinel(e, sessionId) {
  const path = renderCachePath(paths(e).stateDir, sessionId);
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...entry, output: SENTINEL }));
}
export const atClock = (e, ms) => ({ ...e, FAMILIAR_NOW_MS: String(ms) });

export const resolvedAs = (color, warnings = []) => JSON.stringify({
  results: [{ input: 'x', kind: 'path', status: 'resolved', prefix: 'api', root: '/reg/api', ...(color ? { color } : {}) }],
  warnings,
});
