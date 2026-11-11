import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureGitEnv, seedRepo } from './fixtures/git-worktree.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const declarations = 'refs/heads/* refs/tags/*';
const oid = 'a'.repeat(40);
const zero = '0'.repeat(40);
const push = (ref, local = oid) => `${ref} ${local} ${ref} ${oid}\n`;
const jsonLines = (path) => existsSync(path)
  ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

function fixture(t, { enabled = true, refs = '', policy = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'routes-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = seedRepo(join(home, 'repo'));
  mkdirSync(join(root, 'tools'));
  mkdirSync(join(root, '.githooks'));
  mkdirSync(join(root, 'tasks'));
  mkdirSync(join(home, 'bin'));
  writeFileSync(join(root, 'tasks/.config.toml'), 'prefix = "fixture"\n');
  for (const file of ['tools/tt', '.githooks/pre-push']) copyFileSync(join(REPO, file), join(root, file));
  let justfile = readFileSync(join(REPO, 'justfile'), 'utf8');
  for (const [name, value] of Object.entries({
    fast_cmd: 'node marker.mjs fast', test_cmd: 'node marker.mjs full',
    one_cmd: 'node marker.mjs one', check_cmd: 'node marker.mjs hygiene', ci_suite_refs: refs,
  })) justfile = justfile.replace(new RegExp(`^${name} := ".*"$`, 'm'), `${name} := "${value}"`);
  writeFileSync(join(root, 'justfile'), justfile);
  if (policy) writeFileSync(join(root, '.tt.toml'),
    `automatic_broad = ${enabled}\nbroad_targets = ["test", "test-fast"]\n`);
  writeFileSync(join(root, 'marker.mjs'), `
import { appendFileSync, readFileSync } from 'node:fs';
const [kind, ...args] = process.argv.slice(2);
const git = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
appendFileSync(process.env.MARKERS, JSON.stringify({kind, args, git, stdin: kind === 'hygiene' ? '' : readFileSync(0, 'utf8')}) + '\\n');
process.exit(Number(kind === 'hygiene' ? process.env.HYGIENE_EXIT : process.env.CHILD_EXIT));
`);
  writeFileSync(join(home, 'bin/ssh'), `#!/bin/sh\nnode -e 'require("node:fs").appendFileSync(process.env.SSH_CALLS, JSON.stringify(process.argv.slice(1))+"\\n")' -- "$@"\nprintf 'serveraliveinterval %s\\n' "$KEEPALIVE"\n`);
  chmodSync(join(home, 'bin/ssh'), 0o755);
  const env = { ...fixtureGitEnv(home), PATH: `${join(home, 'bin')}:${process.env.PATH}`,
    USER: 'fixture', TT_LOG: join(home, 'runs.jsonl'), MARKERS: join(home, 'markers.jsonl'),
    SSH_CALLS: join(home, 'ssh.jsonl'), KEEPALIVE: '60', HYGIENE_EXIT: '0', CHILD_EXIT: '0' };
  const run = (command, args, extra = {}, input = '') => {
    const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extra },
      input, encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error);
    return result;
  };
  return { root, home, env, run,
    just: (args, extra) => run('just', args, extra),
    hook: (input, { remote = 'origin', url = '/fixture/remote.git', ...extra } = {}) =>
      run('sh', ['.githooks/pre-push', remote, url], extra, input),
    rows: () => jsonLines(env.TT_LOG), markers: () => jsonLines(env.MARKERS),
    ssh: () => jsonLines(env.SSH_CALLS) };
}

function succeeds(result) { assert.equal(result.status, 0, result.stdout + result.stderr); }

test('focused recipe preserves distinct argv with spaces, dollar signs and globs under policy off', (t) => {
  const f = fixture(t, { enabled: false });
  const args = ['path with spaces.test.js', '$HOME.test.js', '*.test.js'];
  succeeds(f.just(['test-one', ...args]));
  assert.deepEqual(f.markers().map(({ kind, args }) => ({ kind, args })), [{ kind: 'one', args }]);
  assert.deepEqual(f.rows().map(({ target, execution }) => [target, execution]), [['test-one', 'ran']]);
});

test('policy skips both broad recipes without launching a child or reporting an outcome', (t) => {
  const f = fixture(t, { enabled: false });
  for (const route of ['test', 'test-fast']) succeeds(f.just([route]));
  assert.deepEqual(f.markers(), []);
  assert.deepEqual(f.rows().map(row => row.target), ['test', 'test-fast']);
  for (const row of f.rows()) {
    assert.equal(row.execution, 'skipped');
    for (const field of ['exit', 'tests', 'selection', 'content', 'slowest']) assert.equal(row[field], null);
  }
});

for (const route of ['hook-pre-push', 'hook-pre-push-fast']) {
  test(`${route} runs only mandatory hygiene when broad policy is off`, (t) => {
    const f = fixture(t, { enabled: false });
    succeeds(f.just([route]));
    assert.deepEqual(f.markers().map(m => m.kind), ['hygiene']);
    assert.deepEqual(f.rows().map(r => [r.target, r.execution]), [
      [route, 'ran'], [route === 'hook-pre-push' ? 'test' : 'test-fast', 'skipped'],
    ]);
  });
  test(`${route} stops before broad work when hygiene fails`, (t) => {
    const f = fixture(t);
    assert.notEqual(f.just([route], { HYGIENE_EXIT: '9' }).status, 0);
    assert.deepEqual(f.markers().map(m => m.kind), ['hygiene']);
    assert.equal(f.rows().length, 1);
    assert.equal(f.rows()[0].exit, 9);
  });
}

test('test-full forces the full child, propagates failure and emits only one inner record', (t) => {
  const f = fixture(t, { enabled: false });
  assert.notEqual(f.just(['test-full'], { CHILD_EXIT: '7' }).status, 0);
  assert.deepEqual(f.markers().map(m => m.kind), ['full']);
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].target, 'test');
  assert.equal(f.rows()[0].execution_reason, 'forced');
  assert.equal(f.rows()[0].exit, 7);
});

test('nested imported tt refuses hosted policy skips and preserves forced child failure', (t) => {
  const f = fixture(t, { enabled: false });
  writeFileSync(join(f.root, 'nested.py'), `
import importlib.machinery, importlib.util, os, pathlib, sys
loader = importlib.machinery.SourceFileLoader('tt', 'tools/tt')
spec = importlib.util.spec_from_loader(loader.name, loader)
tt = importlib.util.module_from_spec(spec)
loader.exec_module(tt)
env = {key: os.environ[key] for key in ['PATH', 'HOME', 'USER', 'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM', 'TT_LOG', 'MARKERS', 'CHILD_EXIT', 'GITHUB_ACTIONS', 'TT_FORCE'] if key in os.environ}
sys.exit(tt.main(['test', '--', 'node', 'marker.mjs', 'full'], env, pathlib.Path.cwd()))
`);
  const path = join(f.root, 'justfile');
  writeFileSync(path, readFileSync(path, 'utf8').replace('one_cmd := "node marker.mjs one"', 'one_cmd := "python3 nested.py"'));
  const refused = f.just(['test-one', 'fixture'], { GITHUB_ACTIONS: 'true' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /hosted verification would be skipped.*TT_FORCE=1/);
  assert.deepEqual(f.markers(), []);
  assert.notEqual(f.just(['test-one', 'fixture'], { GITHUB_ACTIONS: 'true', TT_FORCE: '1', CHILD_EXIT: '7' }).status, 0);
  assert.deepEqual(f.markers().map(m => m.kind), ['full']);
  assert.equal(f.rows().find(r => r.target === 'test').exit, 7);
});

const routingCases = [
  ['undeclared refs', '', 'origin', push('refs/heads/main'), 'full'],
  ['main', declarations, 'origin', push('refs/heads/main'), 'fast'],
  ['branch with slash', declarations, 'origin', push('refs/heads/feature/x'), 'fast'],
  ['tag', declarations, 'origin', push('refs/tags/v1'), 'fast'],
  ['other remote', declarations, 'mirror', push('refs/heads/main'), 'full'],
  ['mixed refs', declarations, 'origin', push('refs/heads/main') + push('refs/notes/x'), 'full'],
  ['only deletion', declarations, 'origin', push('refs/heads/main', zero), 'fast'],
  ['malformed deletion', declarations, 'origin', `refs/heads/main ${zero} refs/heads/main invalid\n`, 'full'],
  ['malformed input', declarations, 'origin', 'not four fields\n', 'full'],
  ['empty input', declarations, 'origin', '', 'full'],
];
for (const [name, refs, remote, input, child] of routingCases) {
  test(`push hook routes ${name} and preserves stdin without reading SSH config`, (t) => {
    const f = fixture(t, { refs });
    succeeds(f.hook(input, { remote }));
    assert.deepEqual(f.markers().map(m => m.kind), ['hygiene', child]);
    assert.equal(f.markers().at(-1).stdin, input);
    assert.deepEqual(f.ssh(), []);
  });
}

test('push hook clears inherited Git repository and pathspec redirection before its recipes', (t) => {
  const f = fixture(t, { refs: declarations });
  const unrelated = seedRepo(join(f.home, 'unrelated'));
  for (const key of ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']) {
    succeeds(f.hook(push('refs/heads/main'), { GIT_DIR: join(unrelated, '.git'),
      GIT_WORK_TREE: unrelated, GIT_INDEX_FILE: join(unrelated, '.git/index'), [key]: '1' }));
  }
  assert.ok(f.markers().every(m => Object.keys(m.git).length === 0));
});

for (const interval of ['0', '60']) {
  test(`SSH keepalive ${interval} is decided only by the fixture ssh`, (t) => {
    const f = fixture(t, { refs: declarations });
    const result = f.hook(push('refs/heads/main'), { url: 'git@fixture.invalid:repo', KEEPALIVE: interval });
    assert.deepEqual(f.ssh(), [['-G', 'fixture.invalid']]);
    if (interval === '0') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /no SSH keepalive/);
      assert.deepEqual(f.markers(), []);
    } else {
      succeeds(result);
      assert.deepEqual(f.markers().map(m => m.kind), ['hygiene', 'fast']);
    }
  });
}

test('policy-off uncovered push warns, but still runs hygiene without a broad child', (t) => {
  const f = fixture(t, { enabled: false });
  const result = f.hook(push('refs/heads/main'));
  succeeds(result);
  assert.match(result.stderr, /remote full-suite coverage is not declared/);
  assert.deepEqual(f.markers().map(m => m.kind), ['hygiene']);
});

test('covered pushes skip broad work while off and rollback restores the declared fast route', (t) => {
  const f = fixture(t, { enabled: false, refs: declarations });
  const skipped = f.hook(push('refs/heads/feature/x'));
  succeeds(skipped);
  assert.doesNotMatch(skipped.stderr, /coverage is not declared/);
  assert.deepEqual(f.markers().map(m => m.kind), ['hygiene']);
  assert.deepEqual(f.rows().map(r => [r.target, r.execution]), [
    ['hook-pre-push-fast', 'ran'], ['test-fast', 'skipped'],
  ]);
  writeFileSync(join(f.root, '.tt.toml'), 'automatic_broad = true\nbroad_targets = ["test", "test-fast"]\n');
  succeeds(f.hook(push('refs/heads/feature/x')));
  succeeds(f.hook(push('refs/notes/x')));
  assert.deepEqual(f.markers().map(m => m.kind), ['hygiene', 'hygiene', 'fast', 'hygiene', 'full']);
  assert.deepEqual(f.rows().filter(r => ['test', 'test-fast'].includes(r.target))
    .map(r => [r.target, r.execution]), [['test-fast', 'skipped'], ['test-fast', 'ran'], ['test', 'ran']]);
});
