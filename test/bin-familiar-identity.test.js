// whoami, projects and the observer agreeing on identity across worktrees, pins and families.
import { observe } from '../src/observe/run.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fg } from '../src/render/term/sgr.js';
import { paths } from '../src/bus/paths.js';
import { writeTheme } from './helpers/themes.js';
import { addWorktree, git, seedRepo } from './fixtures/git-worktree.mjs';
import {
  bin, env, isolatedEnv, seedBus, resolvedAs,
} from './helpers/familiar-cli.js';

// --- Worktrees: every surface resolves a worktree through its repository ----
//
// One main checkout, an internal and an external worktree, and a symlink to the external one.
// whoami, projects and a real hook (through the benchmark's wrapper, which stands the test
// process in for the agent) must agree on the slot and member, while each keeps its own label.

function worktreeLayout(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-cli-worktrees-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const main = seedRepo(join(temp, 'api'));
  const internal = addWorktree(main, join(main, '.worktrees', 'fix-api'));
  const external = addWorktree(main, join(temp, 'store', 'fix-ext'));
  const link = join(temp, 'link');
  symlinkSync(external, link);
  return { temp, main, internal, external, link };
}

function pinned(identities) {
  const e = isolatedEnv();
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nmotion: off\n');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'identities.yaml'), identities);
  return e;
}

function whoami(e, dir) {
  const r = spawnSync(process.execPath, [bin, '--json', 'whoami', dir], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function projectsJson(e, dirs) {
  const r = spawnSync(process.execPath, [bin, '--json', 'projects', ...dirs], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).projects;
}

const observeFixture = fileURLToPath(new URL('fixtures/observe-event.mjs', import.meta.url));
function observerIdentity(e, dir) {
  const r = spawnSync(process.execPath, [observeFixture], {
    cwd: dir, encoding: 'utf8', env: e,
    input: JSON.stringify({ session_id: `cli-parity-${basenameOf(dir)}`, cwd: dir }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const intent = JSON.parse(readFileSync(join(e.FAMILIAR_STATE_DIR, 'intent.json'), 'utf8'));
  return intent[`cli-parity-${basenameOf(dir)}`].current.identity;
}
const basenameOf = (dir) => dir.split('/').at(-1);

test('a registered colour reaches whoami, projects and the observer on every worktree', (t) => {
  const { main, internal, external } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'), FAKE_TASKS_OUTPUT: resolvedAs('#317d01') };
  for (const dir of [main, internal, external]) {
    const w = whoami(e, dir);
    assert.deepEqual([w.slot, w.color, w.source], [3, '#317d01', 'colour']);
  }
  assert.deepEqual(projectsJson(e, [main, internal]).map((p) => [p.slot, p.color, p.source]),
    [[3, '#317d01', 'colour'], [3, '#317d01', 'colour']]);
  const hooked = observerIdentity(e, internal);
  assert.deepEqual([hooked.slot, hooked.projectColor, hooked.source], [3, '#317d01', 'colour']);
});

test('whoami refuses a pin that disagrees with the colour', (t) => {
  const { main } = worktreeLayout(t);
  const e = { ...pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`),
    FAKE_TASKS_OUTPUT: resolvedAs('#317d01') };
  const r = spawnSync(process.execPath, [bin, 'whoami', main], { encoding: 'utf8', env: e });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /pin declares slot 7, but project colour #317d01 \(from tasks\) maps to slot 3/);
});

test('without tasks on PATH whoami behaves as before', (t) => {
  const { temp, main } = worktreeLayout(t);
  const onlyGit = join(temp, 'bin');
  mkdirSync(onlyGit);
  const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(gitPath.status, 0, gitPath.stderr);
  symlinkSync(gitPath.stdout.trim(), join(onlyGit, 'git'));
  const r = spawnSync(process.execPath, [bin, '--json', 'whoami', main], {
    encoding: 'utf8', env: { ...pinned('identities: []\n'), PATH: onlyGit },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const w = JSON.parse(r.stdout);
  assert.deepEqual([w.color, w.source], [null, 'auto']);
});

test('a tasks failure is one error line naming the command', (t) => {
  const { main } = worktreeLayout(t);
  const e = { ...isolatedEnv(), FAKE_TASKS_EXIT: '2', FAKE_TASKS_OUTPUT: '',
    FAKE_TASKS_STDERR: "error: unrecognized subcommand 'resolve'\nusage: tasks resolve\r\ntry --help" };
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), '{"mode":"dark","satScale":1}');
  const r = spawnSync(process.execPath, [bin, 'whoami', main], { encoding: 'utf8', env: e });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /tasks resolve .*: exited 2: error: unrecognized subcommand 'resolve'/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.ok(r.stderr.includes('\\nusage: tasks resolve\\r\\ntry --help'));
});

test('projects writes each tasks warning once', (t) => {
  const { main, internal, external } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'), FAKE_TASKS_OUTPUT: JSON.stringify({
    results: [{ input: 'x', kind: 'path', status: 'unregistered' }], warnings: ['w1', 'w2', 'w1'],
  }) };
  const r = spawnSync(process.execPath, [bin, '--json', 'projects', main, internal, external], {
    encoding: 'utf8', env: e,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, 'familiar: tasks: w1\nfamiliar: tasks: w2\n');
  assert.deepEqual(JSON.parse(r.stdout).projects.map((p) => [p.color, p.source]),
    [[null, 'auto'], [null, 'auto'], [null, 'auto']]);
});

test('whoami writes distinct tasks warnings in first-seen order', (t) => {
  const { main } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'), FAKE_TASKS_OUTPUT: resolvedAs(null, ['w2', 'w1', 'w2']) };
  const r = spawnSync(process.execPath, [bin, '--json', 'whoami', main], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, 'familiar: tasks: w2\nfamiliar: tasks: w1\n');
  assert.equal(JSON.parse(r.stdout).color, null);
});

test('unpinned remote-less worktrees share the repository slot and keep their labels', (t) => {
  const { main, internal, external, link } = worktreeLayout(t);
  const e = pinned('identities: []\n');
  const seen = [main, internal, external, link].map((dir) => whoami(e, dir));
  assert.deepEqual(seen.map((s) => s.project), ['api', 'fix-api', 'fix-ext', 'fix-ext']);
  assert.equal(new Set(seen.map((s) => s.slot)).size, 1);
  assert.equal(observerIdentity(e, external).slot, seen[0].slot);
});

test('a main path pin reaches every worktree on every surface', (t) => {
  const { main, internal, external, link } = worktreeLayout(t);
  const e = pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`);
  for (const dir of [main, internal, external, link]) assert.equal(whoami(e, dir).slot, 7);
  const listed = projectsJson(e, [main, internal, external, link]);
  assert.deepEqual(listed.map((p) => [p.project, p.slot, p.source]), [
    ['api', 7, 'pin'], ['fix-api', 7, 'pin'], ['fix-ext', 7, 'pin'], ['fix-ext', 7, 'pin'],
  ]);
  const hooked = observerIdentity(e, internal);
  assert.deepEqual([hooked.slot, hooked.member, hooked.project], [7, whoami(e, internal).member.id, 'fix-api']);
});

test('worktree path and name pins override inherited ones in their own tiers', (t) => {
  const { main, internal, external } = worktreeLayout(t);
  const paths = pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`
    + `  - path: ${JSON.stringify(internal)}\n    slot: 3\n  - project: fix-ext\n    slot: 5\n`);
  assert.equal(whoami(paths, internal).slot, 3);
  assert.equal(whoami(paths, external).slot, 7, 'a name pin never beats the inherited path');
  assert.equal(whoami(paths, main).slot, 7);

  const names = pinned('identities:\n  - project: api\n    slot: 2\n  - project: fix-ext\n    slot: 5\n');
  assert.equal(whoami(names, main).slot, 2);
  assert.equal(whoami(names, internal).slot, 2, 'the repository name is inherited');
  assert.equal(whoami(names, external).slot, 5, 'the exact checkout name wins');
});

test('a matching remote pin dominates every path pin', (t) => {
  const { main, internal, external } = worktreeLayout(t);
  git(main, ['config', 'remote.origin.url', 'git@github.com:example/api.git']);
  const e = pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`
    + `  - path: ${JSON.stringify(internal)}\n    slot: 3\n  - remote: github.com/example/api\n    slot: 6\n`);
  for (const dir of [main, internal, external]) assert.equal(whoami(e, dir).slot, 6);
  assert.equal(observerIdentity(e, internal).slot, 6);
});

test('projects with no directories lists path pins only, never their worktrees', (t) => {
  const { main } = worktreeLayout(t);
  const e = pinned(`identities:\n  - path: ${JSON.stringify(main)}\n    slot: 7\n`);
  assert.deepEqual(projectsJson(e, []).map((p) => p.project), ['api']);
});

test('the observer writes tasks warnings to stderr and still records the session', (t) => {
  const { main } = worktreeLayout(t);
  const e = { ...pinned('identities: []\n'),
    FAKE_TASKS_OUTPUT: JSON.stringify({ results: [{ input: main, kind: 'path', status: 'unregistered' }],
      warnings: ['nexc: its checkout is not matched and its color is not reported (bad)'] }) };
  const r = spawnSync(process.execPath, [observeFixture], {
    cwd: main, encoding: 'utf8', env: e, input: JSON.stringify({ session_id: 'warn', cwd: main }) });
  assert.equal(r.status, 0);
  assert.equal(r.stderr,
    'familiar: observe: nexc: its checkout is not matched and its color is not reported (bad)\n');
  const agents = JSON.parse(readFileSync(join(e.FAMILIAR_STATE_DIR, 'sessions.json'), 'utf8')).sessions;
  assert.equal(agents.warn.projectColor, null);
});

test('the status line paints the label in the colour its record carries', async () => {
  const e = isolatedEnv();
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'theme: cats\nmotion: off\n');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'identities.yaml'), 'identities: []\n');
  e.FAKE_TASKS_LOG = join(e.FAMILIAR_STATE_DIR, 'tasks.log');
  await seedBus(e, 's1', { cwd: '/tmp/api', projectColor: '#317d01' });
  const r = spawnSync(process.execPath, [bin, 'statusline'], {
    input: JSON.stringify({ session_id: 's1' }), encoding: 'utf8', env: e,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.includes(fg('#317d01') + 'api'));
  // The colour comes from the record, never from a `tasks resolve` per render. The one call
  // this path does make is the claim lookup.
  assert.equal(readFileSync(e.FAKE_TASKS_LOG, 'utf8'), 'claims --json\n');
});

// --- Family, theme and role on whoami and projects -------------------------------------

// A `tasks` that registers each checkout at a root of its own, by the path asked for, so
// two checkouts can belong to two families.
function tasksByPath(t, roots) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-tasks-by-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'tasks');
  writeFileSync(script, `#!/usr/bin/env node
const roots = ${JSON.stringify(roots)};
const input = process.argv.at(-1);
console.log(JSON.stringify({ results: [{ input, kind: 'path', status: 'resolved', prefix: 'x', root: roots[input] }], warnings: [] }));
`);
  chmodSync(script, 0o755);
  return dir;
}

function familyLayout(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-cli-families-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const a = seedRepo(join(temp, 'alpha'));
  const b = seedRepo(join(temp, 'beta'));
  mkdirSync(join(a, 'tools'));
  writeFileSync(join(a, 'tools', 'family.toml'), 'name = "guild"\n');
  mkdirSync(join(b, 'tools'));
  writeFileSync(join(b, 'tools', 'family.toml'), 'name = "grove"\n');
  const e = pinned('identities: []\n');
  writeFileSync(join(e.FAMILIAR_CONFIG_DIR, 'config.yaml'),
    'theme: cats\nmotion: off\nfamilies:\n  guild: guild-theme\n  grove: grove-theme\n');
  mkdirSync(join(e.FAMILIAR_CONFIG_DIR, 'themes'));
  writeTheme(join(e.FAMILIAR_CONFIG_DIR, 'themes'), 'guild-theme');
  writeTheme(join(e.FAMILIAR_CONFIG_DIR, 'themes'), 'grove-theme');
  e.PATH = `${tasksByPath(t, { [a]: a, [b]: b })}:${e.PATH}`;
  return { a, b, e };
}

test('whoami reports the family, its theme and the role from FAMILIAR_ROLE', (t) => {
  const { a, e } = familyLayout(t);
  const w = whoami({ ...e, FAMILIAR_ROLE: 'reviewer' }, a);
  assert.deepEqual(
    [w.family, w.theme, w.themeSource, w.role, w.memberSource],
    ['guild', 'guild-theme', 'family', 'reviewer', 'unmapped'],
  );
  assert.equal(typeof w.anchor, 'string');
  const text = spawnSync(process.execPath, [bin, 'whoami', a], {
    encoding: 'utf8', env: { ...e, FAMILIAR_ROLE: 'reviewer' },
  });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^  family  guild · theme guild-theme \(family\)$/m);
  assert.match(text.stdout, /^  role    reviewer · member .+ \(unmapped\)$/m);
  const bare = whoami(e, a);
  assert.deepEqual([bare.role, bare.memberSource], [null, 'auto']);
});

test('whoami refuses a reserved or malformed FAMILIAR_ROLE', (t) => {
  const { a, e } = familyLayout(t);
  for (const role of ['default', 'Reviewer']) {
    const r = spawnSync(process.execPath, [bin, 'whoami', a], { encoding: 'utf8', env: { ...e, FAMILIAR_ROLE: role } });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /FAMILIAR_ROLE/);
  }
});

test('projects lists checkouts with no role even when FAMILIAR_ROLE is set', (t) => {
  const { a, b, e } = familyLayout(t);
  const rows = projectsJson({ ...e, FAMILIAR_ROLE: 'reviewer' }, [a, b]);
  assert.deepEqual(rows.map((p) => [p.project, p.family, p.theme, p.themeSource, p.memberSource]), [
    ['alpha', 'guild', 'guild-theme', 'family', 'auto'],
    ['beta', 'grove', 'grove-theme', 'family', 'auto'],
  ]);
  assert.equal(Object.hasOwn(rows[0], 'role'), false);
});

test('projects lists two families under two theme headers', (t) => {
  const { a, b, e } = familyLayout(t);
  const r = spawnSync(process.execPath, [bin, '--color', 'never', 'projects', a, b], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  const headers = r.stdout.match(/^  \S+ — .+$/gm);
  assert.equal(headers.length, 2, r.stdout);
  assert.match(headers[0], /^  guild-theme — /);
  assert.match(headers[1], /^  grove-theme — /);
  assert.match(r.stdout, /^      .+ · auto · auto$/m);
});
