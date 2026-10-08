import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRemote, gitContext, projectKeyFor, displayProject, autoSlot,
} from '../src/bus/identity.js';
import { SLOT_COUNT } from 'familiar-theme';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { addWorktree, fixtureGitEnv, git, seedRepo } from './fixtures/git-worktree.mjs';

test('normalizeRemote reduces every URL form of one repo to one key', () => {
  const expected = 'github.com/me/api';
  assert.equal(normalizeRemote('git@github.com:me/api.git'), expected);
  assert.equal(normalizeRemote('https://github.com/me/api.git'), expected);
  assert.equal(normalizeRemote('https://github.com/me/api'), expected);
  assert.equal(normalizeRemote('https://user:token@github.com/me/api'), expected);
  assert.equal(normalizeRemote('https://user:token@github.com/me/api.git'), expected);
  assert.equal(normalizeRemote('ssh://git@github.com/me/api.git'), expected);
  assert.equal(normalizeRemote('ssh://git@github.com:22/me/api.git'), expected);
  assert.equal(normalizeRemote('https://github.com/me/api/'), expected);
  assert.equal(normalizeRemote('HTTPS://GitHub.com/Me/API.git'), expected);
  assert.equal(normalizeRemote('git@GitHub.com:Me/API.git'), expected);
  assert.equal(
    normalizeRemote('git@gitlab.example.com:group/subgroup/project.git'),
    'gitlab.example.com/group/subgroup/project'
  );
  assert.equal(
    normalizeRemote('https://gitlab.example.com/group/subgroup/project.git'),
    'gitlab.example.com/group/subgroup/project'
  );
});

test('normalizeRemote does not conflate an scp-style numeric owner with an ssh:// port', () => {
  // scp-style shorthand has no port syntax: the text after the colon is always a
  // path. `1234` here is an org/owner name, not a port, so it must survive into
  // the key. `ssh://...:1234/...` IS URL form, so 1234 there really is a port and
  // must be stripped. These are two different repos and must produce different keys.
  const scpNumericOwner = normalizeRemote('git@github.com:1234/repo.git');
  const sshExplicitPort = normalizeRemote('ssh://git@github.com:1234/repo.git');
  assert.equal(scpNumericOwner, 'github.com/1234/repo');
  assert.equal(sshExplicitPort, 'github.com/repo');
  assert.notEqual(scpNumericOwner, sshExplicitPort);
});

test('normalizeRemote returns null for what it cannot canonicalize', () => {
  assert.equal(normalizeRemote(''), null);
  assert.equal(normalizeRemote(null), null);
  assert.equal(normalizeRemote('/local/path/to/repo'), null);
});


test('projectKey prefers the remote — it survives moving and re-cloning the repo', () => {
  assert.equal(
    projectKeyFor({ remote: 'github.com/me/api', repositoryRoot: '/home/k/d/api', cwd: '/home/k/d/api/src' }),
    'github.com/me/api'
  );
});

test('projectKey falls back to the repository anchor, then to the cwd', () => {
  assert.equal(
    projectKeyFor({ remote: null, repositoryRoot: '/home/k/d/api', cwd: '/home/k/d/api/src' }),
    '/home/k/d/api'
  );
  assert.equal(
    projectKeyFor({ remote: null, repositoryRoot: null, cwd: '/tmp/scratch' }),
    '/tmp/scratch'
  );
});

test('a remote-less worktree shares its repository key and keeps its own label', () => {
  const main = { remote: null, repoRoot: '/home/k/d/api', repositoryRoot: '/home/k/d/api' };
  const tree = { remote: null, repoRoot: '/home/k/d/fix-api', repositoryRoot: '/home/k/d/api' };
  assert.equal(projectKeyFor({ ...tree, cwd: tree.repoRoot }), projectKeyFor({ ...main, cwd: main.repoRoot }));
  assert.equal(displayProject({ ...tree, cwd: '/x' }), 'fix-api');
  assert.equal(displayProject({ ...main, cwd: '/x' }), 'api');
});

test('two unrelated repos named api are different identities', () => {
  const work = projectKeyFor({ remote: null, repositoryRoot: '/home/k/d/work/api', cwd: '/home/k/d/work/api' });
  const play = projectKeyFor({ remote: null, repositoryRoot: '/home/k/d/play/api', cwd: '/home/k/d/play/api' });
  assert.notEqual(work, play);
  assert.equal(displayProject({ repoRoot: '/home/k/d/work/api', cwd: '/x' }), 'api');
  assert.equal(displayProject({ repoRoot: '/home/k/d/play/api', cwd: '/x' }), 'api');
  // They share a LABEL and must not share an identity. That is the whole point.
});

test('autoSlot is deterministic and inside the slot range', () => {
  const key = 'github.com/me/api';
  assert.equal(autoSlot(key), autoSlot(key));
  assert.equal(autoSlot(key), 3);   // frozen: fnv1a32('github.com/me/api') = 0x47b3cfa7; 0x47b3cfa7 % 12 = 3
  for (const k of ['a', 'b', 'c', '/x/y', 'github.com/o/n']) {
    const slot = autoSlot(k);
    assert.ok(Number.isInteger(slot) && slot >= 0 && slot < SLOT_COUNT);
  }
});

// --- Discovery: one deadline, bounded spawns, exact paths -------------------
//
// A scripted exec answers each Git call in order and refuses anything unscripted, so a test
// pins both the answers and the exact sequence of commands. No call may list worktrees:
// a prunable or unreachable sibling must never widen what one hook touches.

const BATCH = ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'];
const PROBE = ['rev-parse', '--is-bare-repository', '--show-toplevel'];
const ORIGIN = ['config', '--get', 'remote.origin.url'];
const MAIN_BATCH = '/fixture/api\n/fixture/api/.git\n/fixture/api/.git\n';
const LINKED_BATCH = '/fixture/fix-api\n/fixture/api/.git/worktrees/fix-api\n/fixture/api/.git\n';
const KILLED = { killed: true, signal: 'SIGKILL', code: null };

const ok = (stdout) => () => ({ stdout, stderr: '' });
const fail = (fields) => () => {
  throw Object.assign(new Error(fields.message ?? 'git failed'), fields);
};

function scripted(...steps) {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(args.includes('worktree'), false, `a worktree command was run: ${args.join(' ')}`);
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`unexpected git ${args.join(' ')}`);
    return step(args);
  };
  return { exec, calls };
}

const NO_CONTEXT = { remote: null, repoRoot: null, repositoryRoot: null };

test('gitContext asks git, and reports absence rather than inventing a repo', async () => {
  const { exec } = scripted(ok(MAIN_BATCH), ok('git@github.com:me/api.git\n'));
  assert.deepEqual(await gitContext('/fixture/api/src', { exec }), {
    remote: 'github.com/me/api', repoRoot: '/fixture/api', repositoryRoot: '/fixture/api',
  });

  const notRepo = scripted(fail({ code: 128 }));
  assert.deepEqual(await gitContext('/tmp/scratch', { exec: notRepo.exec }), NO_CONTEXT);
  assert.equal(notRepo.calls.length, 1);

  const noGit = scripted(fail({ code: 'ENOENT' }));
  assert.deepEqual(await gitContext('/tmp/scratch', { exec: noGit.exec }), NO_CONTEXT);
  assert.equal(noGit.calls.length, 1);
});

test('main context batches paths and retains two Git spawns', async () => {
  const calls = [];
  let clock = 0;
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    clock += 7;
    if (args.includes('--git-common-dir')) {
      return { stdout: '/fixture/api\n/fixture/api/.git\n/fixture/api/.git\n' };
    }
    if (args.includes('remote.origin.url')) {
      return { stdout: 'git@github.com:example/api.git\n' };
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  assert.deepEqual(await gitContext('/fixture/api', { exec, now: () => clock }), {
    remote: 'github.com/example/api', repoRoot: '/fixture/api',
    repositoryRoot: '/fixture/api',
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['-C', '/fixture/api', ...BATCH]);
  assert.deepEqual(calls.map((c) => c.options.timeout), [2_000, 1_993]);
  assert.ok(calls.every((c) => c.options.killSignal === 'SIGKILL'));
});

test('linked context probes the primary once and never lists worktrees', async () => {
  const { exec, calls } = scripted(ok(LINKED_BATCH), ok('false\n/fixture/api\n'), fail({ code: 1 }));
  assert.deepEqual(await gitContext('/fixture/fix-api', { exec }), {
    remote: null, repoRoot: '/fixture/fix-api', repositoryRoot: '/fixture/api',
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].args, ['-C', '/fixture/api', ...PROBE]);
  assert.deepEqual(calls[2].args, ['-C', '/fixture/fix-api', ...ORIGIN]);
});

test('a probe root keeps its embedded newlines and trailing spaces', async () => {
  const root = '/fixture/a\npi \r';
  // The batch has more than three lines, so each option is asked for separately.
  const separate = scripted(
    ok(`/fixture/fix-api\n${root}/.git/worktrees/fix-api\n${root}/.git\n`),
    ok('/fixture/fix-api\n'), ok(`${root}/.git/worktrees/fix-api\n`), ok(`${root}/.git\n`),
    ok(`false\n${root}\n`), fail({ code: 1 }),
  );
  assert.deepEqual(await gitContext('/fixture/fix-api', { exec: separate.exec }), {
    remote: null, repoRoot: '/fixture/fix-api', repositoryRoot: root,
  });
  assert.deepEqual(separate.calls[4].args, ['-C', root, ...PROBE]);
});

test('ambiguous batch framing asks each option separately and keeps exact paths', async () => {
  for (const root of ['/fixture/a\npi', '/fixture/api\n']) {
    const { exec, calls } = scripted(
      ok(`${root}\n${root}/.git\n${root}/.git\n`),
      ok(`${root}\n`), ok(`${root}/.git\n`), ok(`${root}/.git\n`),
      fail({ code: 1 }),
    );
    assert.deepEqual(await gitContext('/fixture', { exec }), {
      remote: null, repoRoot: root, repositoryRoot: root,
    });
    assert.deepEqual(calls.slice(1, 4).map((c) => c.args.slice(2)), [
      ['rev-parse', '--path-format=absolute', '--show-toplevel'],
      ['rev-parse', '--path-format=absolute', '--git-dir'],
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    ]);
  }

  // Fewer than three lines is ambiguous too.
  const short = scripted(ok('/fixture/api\n/fixture/api/.git\n'),
    ok('/fixture/api\n'), ok('/fixture/api/.git\n'), ok('/fixture/api/.git\n'), fail({ code: 1 }));
  assert.equal((await gitContext('/fixture/api', { exec: short.exec })).repositoryRoot, '/fixture/api');
  assert.equal(short.calls.length, 5);
});

test('carriage returns and trailing spaces are path characters, not framing', async () => {
  const root = '/fixture/api \r';
  const { exec, calls } = scripted(ok(`${root}\n${root}/.git\n${root}/.git\n`), fail({ code: 1 }));
  assert.deepEqual(await gitContext(root, { exec }), {
    remote: null, repoRoot: root, repositoryRoot: root,
  });
  assert.equal(calls.length, 2);
});

test('malformed metadata is an error, never "not a repository"', async () => {
  const cases = [
    scripted(ok('/fixture/api\nrelative/.git\n/fixture/api/.git\n')),
    scripted(ok('/fixture/api\n\n/fixture/api/.git\n')),
    scripted(ok('/fixture/api\n/fixture/api/.git\n/fixture/api/.git')),
    scripted(ok('/fixture/api\n'), ok('relative\n')),
    scripted(ok('/fixture/api\n'), fail({ code: 128 })),
  ];
  for (const { exec } of cases) {
    await assert.rejects(gitContext('/fixture/api', { exec }), (error) => {
      assert.doesNotMatch(error.message, /timed out/);
      return true;
    });
  }
});

test('a failed primary probe names the core.worktree declaration', async () => {
  const declaredOnly = scripted(ok(LINKED_BATCH), fail({ code: 128, stdout: 'false\n' }));
  await assert.rejects(gitContext('/fixture/fix-api', { exec: declaredOnly.exec }), /core\.worktree/);

  const wrongCode = scripted(ok(LINKED_BATCH), fail({ code: 1, stdout: 'true\n' }));
  await assert.rejects(gitContext('/fixture/fix-api', { exec: wrongCode.exec }), /core\.worktree/);

  const signalled = scripted(ok(LINKED_BATCH), fail({ code: 128, stdout: 'true\n', signal: 'SIGTERM' }));
  await assert.rejects(gitContext('/fixture/fix-api', { exec: signalled.exec }), /core\.worktree/);

  const garbled = scripted(ok(LINKED_BATCH), ok('maybe\n/fixture/api\n'));
  await assert.rejects(gitContext('/fixture/fix-api', { exec: garbled.exec }), /core\.worktree/);
});

test('only an unsignalled exit 128 after "true" is a bare anchor', async () => {
  const bare = scripted(
    ok('/fixture/tree\n/fixture/api.git/worktrees/tree\n/fixture/api.git\n'),
    fail({ code: 128, stdout: 'true\n' }), fail({ code: 1 }),
  );
  assert.deepEqual(await gitContext('/fixture/tree', { exec: bare.exec }), {
    remote: null, repoRoot: '/fixture/tree', repositoryRoot: '/fixture/api.git',
  });
  assert.deepEqual(bare.calls[1].args, ['-C', '/fixture/api.git', ...PROBE]);

  // A bare directory literally named .git: the probe runs at its parent.
  const dotGit = scripted(
    ok('/fixture/tree\n/fixture/store/.git/worktrees/tree\n/fixture/store/.git\n'),
    fail({ code: 128, stdout: 'true\n' }), fail({ code: 1 }),
  );
  assert.equal((await gitContext('/fixture/tree', { exec: dotGit.exec })).repositoryRoot,
    '/fixture/store/.git');
  assert.deepEqual(dotGit.calls[1].args, ['-C', '/fixture/store', ...PROBE]);

  // Partial "true" from a command that was killed is not that result.
  const killed = scripted(ok(LINKED_BATCH), fail({ ...KILLED, stdout: 'true\n' }));
  await assert.rejects(gitContext('/fixture/fix-api', { exec: killed.exec }), /timed out/);
});

test('a timeout at any stage fails discovery instead of re-keying the project', async () => {
  const stages = [
    scripted(fail(KILLED)),
    scripted(ok('/fixture/api\n'), fail(KILLED)),
    scripted(ok('/fixture/api\n'), ok('/fixture/api\n'), fail(KILLED)),
    scripted(ok(LINKED_BATCH), fail(KILLED)),
    scripted(ok(MAIN_BATCH), fail(KILLED)),
    scripted(ok(LINKED_BATCH), ok('false\n/fixture/api\n'), fail(KILLED)),
  ];
  for (const { exec } of stages) {
    await assert.rejects(gitContext('/fixture/api', { exec }), /git timed out/);
  }
});

test('an exhausted budget refuses the next query without spawning it', async () => {
  let clock = 0;
  const { exec, calls } = scripted(() => {
    clock = 2_000;
    return { stdout: LINKED_BATCH };
  });
  await assert.rejects(gitContext('/fixture/fix-api', { exec, now: () => clock }), /git timed out after 2000ms/);
  assert.equal(calls.length, 1);

  // The remaining budget is floored, never enlarged.
  clock = 0;
  const floored = scripted(() => {
    clock = 1_500.75;
    return { stdout: MAIN_BATCH };
  }, fail({ code: 1 }));
  await gitContext('/fixture/api', { exec: floored.exec, now: () => clock });
  assert.equal(floored.calls[1].options.timeout, 499);
});

test('origin: absent or unsupported is null; any other failure propagates', async () => {
  const absent = scripted(ok(MAIN_BATCH), fail({ code: 1 }));
  assert.equal((await gitContext('/fixture/api', { exec: absent.exec })).remote, null);
  const local = scripted(ok(MAIN_BATCH), ok('/srv/git/api\n'));
  assert.equal((await gitContext('/fixture/api', { exec: local.exec })).remote, null);
  const broken = scripted(ok(MAIN_BATCH), fail({ code: 128, message: 'bad config line 3' }));
  await assert.rejects(gitContext('/fixture/api', { exec: broken.exec }), /bad config/);
});

test('an exec that NEVER RESOLVES still returns — the hook cannot be allowed to hang', async () => {
  // The literal shape of the bug: a promise that can never settle. If gitContext
  // awaited it unguarded, this test would hang rather than fail, which is exactly
  // what the real hook did. node:child_process enforces the timeout by killing
  // the child; the fake stands in for that kill, and what is asserted is that
  // gitContext SETTLES.
  const exec = (cmd, args, options) =>
    new Promise((_, reject) => {
      setTimeout(
        () => reject(Object.assign(new Error('spawn killed'), { killed: true, signal: 'SIGKILL' })),
        options.timeout
      );
    });

  await assert.rejects(
    gitContext('/mnt/wedged/repo', { exec, timeoutMs: 20 }),
    /git timed out after 20ms in \/mnt\/wedged\/repo/
  );
});

// A real checkout can be reached through a symlink, and Git reports the PHYSICAL path.
// gitContext passes it straight through rather than "fixing" it to match the cwd string it
// was given; canonicalizing a *pin's* path to compare against it is pins.js's job.
test('gitContext reports the PHYSICAL repo root exactly as git gives it, with no realpath/normalization applied', async () => {
  const physicalRoot = '/var/lib/physical-target/api';
  const { exec } = scripted(
    ok(`${physicalRoot}\n${physicalRoot}/.git\n${physicalRoot}/.git\n`), ok(''),
  );
  const { repoRoot, repositoryRoot } = await gitContext('/home/k/d/api-symlink', { exec });
  assert.equal(repoRoot, physicalRoot);
  assert.equal(repositoryRoot, physicalRoot);
});

// --- Discovery against real Git ---------------------------------------------
//
// Native queries through the real promisified execFile, with only the fixture environment
// added. Every layout the contract names, checked for exact physical roots and spawn counts.

const realExecFile = promisify(execFile);
function realGit() {
  const calls = [];
  const exec = (file, args, options) => {
    calls.push(args);
    assert.equal(args.includes('worktree'), false, `a worktree command was run: ${args.join(' ')}`);
    return realExecFile(file, args, { ...options, env: fixtureGitEnv() });
  };
  return { exec, calls };
}

async function contextOf(path) {
  const { exec, calls } = realGit();
  const context = await gitContext(path, { exec });
  return { ...context, spawns: calls.length };
}

const tempRoot = (t, prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return realpathSync(root);
};

test('real Git bare probe prints true before exit 128', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'familiar-bare-probe-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const main = seedRepo(join(temp, 'primary'));
  for (const name of ['bare.git', '.git']) {
    const bare = join(temp, name);
    git(temp, ['clone', '-q', '--bare', main, bare]);
    const candidate = name === '.git' ? temp : bare;
    const r = spawnSync('git', ['-C', candidate, 'rev-parse',
      '--is-bare-repository', '--show-toplevel'], { encoding: 'utf8',
      timeout: 5_000, killSignal: 'SIGKILL', env: fixtureGitEnv() });
    assert.equal(r.error, undefined);
    assert.equal(r.signal, null);
    assert.equal(r.status, 128);
    assert.equal(r.stdout, 'true\n');
  }
});

test('main, internal, external and symlinked worktrees share one anchor', async (t) => {
  const temp = tempRoot(t, 'familiar-anchor-');
  const main = seedRepo(join(temp, 'api'));
  const internal = addWorktree(main, join(main, '.worktrees', 'fix-api'));
  const external = addWorktree(main, join(temp, 'store', 'fix-ext'));
  symlinkSync(external, join(temp, 'link'));

  assert.deepEqual(await contextOf(main),
    { remote: null, repoRoot: main, repositoryRoot: main, spawns: 2 });
  assert.deepEqual(await contextOf(join(main, '.git', '..')),
    { remote: null, repoRoot: main, repositoryRoot: main, spawns: 2 });
  assert.deepEqual(await contextOf(internal),
    { remote: null, repoRoot: internal, repositoryRoot: main, spawns: 3 });
  assert.deepEqual(await contextOf(external),
    { remote: null, repoRoot: external, repositoryRoot: main, spawns: 3 });
  assert.deepEqual(await contextOf(join(temp, 'link')),
    { remote: null, repoRoot: external, repositoryRoot: main, spawns: 3 });

  // Labels stay per checkout; the remote-less key is the repository's.
  for (const tree of [internal, external]) {
    const context = await contextOf(tree);
    assert.equal(projectKeyFor({ ...context, cwd: tree }), main);
  }
  assert.equal(displayProject({ repoRoot: external, cwd: temp }), 'fix-ext');
});

test('a nested unrelated repository is its own anchor', async (t) => {
  const temp = tempRoot(t, 'familiar-nested-');
  const main = seedRepo(join(temp, 'api'));
  const nested = seedRepo(join(main, 'vendor', 'lib'));
  const context = await contextOf(nested);
  assert.equal(context.repositoryRoot, nested);
  assert.notEqual(projectKeyFor({ ...context, cwd: nested }), main);
});

test('a moved sibling does not change discovery', async (t) => {
  const temp = tempRoot(t, 'familiar-moved-');
  const main = seedRepo(join(temp, 'api'));
  const kept = addWorktree(main, join(temp, 'kept'));
  addWorktree(main, join(temp, 'moved'));
  const before = [await contextOf(main), await contextOf(kept)];
  renameSync(join(temp, 'moved'), join(temp, 'moved-away'));
  assert.deepEqual([await contextOf(main), await contextOf(kept)], before);
});

test('bare-backed worktrees anchor at the bare repository, including one named .git', async (t) => {
  const temp = tempRoot(t, 'familiar-bare-');
  const main = seedRepo(join(temp, 'primary'));
  const bare = join(temp, 'familiar.git');
  git(temp, ['clone', '-q', '--bare', main, bare]);
  const tree = addWorktree(bare, join(temp, 'bare-tree'));
  assert.deepEqual(await contextOf(tree),
    { remote: null, repoRoot: tree, repositoryRoot: realpathSync(bare), spawns: 3 });

  const holder = join(temp, 'holder');
  mkdirSync(holder);
  git(temp, ['clone', '-q', '--bare', main, join(holder, '.git')]);
  const dotTree = addWorktree(join(holder, '.git'), join(temp, 'dot-tree'));
  assert.deepEqual(await contextOf(dotTree),
    { remote: null, repoRoot: dotTree, repositoryRoot: join(holder, '.git'), spawns: 3 });
});

test('separated metadata: main uses its root; linked needs core.worktree', async (t) => {
  const temp = tempRoot(t, 'familiar-separated-');
  const main = seedRepo(join(temp, 'sep'), { gitDir: join(temp, 'meta', 'sep.git') });
  assert.deepEqual(await contextOf(main),
    { remote: null, repoRoot: main, repositoryRoot: main, spawns: 2 });

  const tree = addWorktree(main, join(temp, 'sep-tree'));
  await assert.rejects(contextOf(tree), /core\.worktree/);

  git(main, ['config', 'core.worktree', main]);
  assert.deepEqual(await contextOf(tree),
    { remote: null, repoRoot: tree, repositoryRoot: main, spawns: 3 });
});

// Documented Git interpretation, not a detection guarantee: metadata named .git outside its
// checkout looks like a conventional repository at its parent until core.worktree says
// otherwise, so the anchor is that parent. Declaring the primary recovers it.
test('undeclared separated store/.git is ambiguous until core.worktree declares the primary', async (t) => {
  const temp = tempRoot(t, 'familiar-store-');
  const main = seedRepo(join(temp, 'real'), { gitDir: join(temp, 'store', '.git') });
  const tree = addWorktree(main, join(temp, 'store-tree'));
  assert.equal((await contextOf(tree)).repositoryRoot, join(temp, 'store'));
  git(main, ['config', 'core.worktree', main]);
  assert.equal((await contextOf(tree)).repositoryRoot, main);
});

test('paths with newlines, carriage returns and trailing spaces survive discovery', async (t) => {
  const temp = tempRoot(t, 'familiar-odd-paths-');
  const main = seedRepo(join(temp, 'a\npi \r'));
  const ending = addWorktree(main, join(temp, 'tree\n'));
  const spaced = addWorktree(main, join(temp, 'tree  '));
  assert.deepEqual(await contextOf(main),
    { remote: null, repoRoot: main, repositoryRoot: main, spawns: 5 });
  assert.deepEqual(await contextOf(ending),
    { remote: null, repoRoot: ending, repositoryRoot: main, spawns: 6 });
  assert.deepEqual(await contextOf(spaced),
    { remote: null, repoRoot: spaced, repositoryRoot: main, spawns: 6 });
});

test('a worktree-specific origin stays authoritative while the anchor is shared', async (t) => {
  const temp = tempRoot(t, 'familiar-wt-origin-');
  const main = seedRepo(join(temp, 'api'));
  git(main, ['config', 'extensions.worktreeConfig', 'true']);
  git(main, ['config', 'remote.origin.url', 'git@github.com:example/main.git']);
  const tree = addWorktree(main, join(temp, 'fix-api'));
  git(tree, ['config', '--worktree', 'remote.origin.url', 'https://github.com/example/override.git']);

  const mainContext = await contextOf(main);
  const treeContext = await contextOf(tree);
  assert.equal(mainContext.remote, 'github.com/example/main');
  assert.equal(treeContext.remote, 'github.com/example/override');
  assert.equal(treeContext.repositoryRoot, mainContext.repositoryRoot);
  assert.notEqual(projectKeyFor({ ...treeContext, cwd: tree }),
    projectKeyFor({ ...mainContext, cwd: main }));
});
