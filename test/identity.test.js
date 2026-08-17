import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRemote, gitContext, projectKeyFor, displayProject, autoSlot,
} from '../src/bus/identity.js';
import { SLOT_COUNT } from 'familiar-theme';

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
    projectKeyFor({ remote: 'github.com/me/api', repoRoot: '/home/k/d/api', cwd: '/home/k/d/api/src' }),
    'github.com/me/api'
  );
});

test('projectKey falls back to the repo root, then to the cwd', () => {
  assert.equal(
    projectKeyFor({ remote: null, repoRoot: '/home/k/d/api', cwd: '/home/k/d/api/src' }),
    '/home/k/d/api'
  );
  assert.equal(
    projectKeyFor({ remote: null, repoRoot: null, cwd: '/tmp/scratch' }),
    '/tmp/scratch'
  );
});

test('two unrelated repos named api are different identities', () => {
  const work = projectKeyFor({ remote: null, repoRoot: '/home/k/d/work/api', cwd: '/home/k/d/work/api' });
  const play = projectKeyFor({ remote: null, repoRoot: '/home/k/d/play/api', cwd: '/home/k/d/play/api' });
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

test('gitContext asks git, and reports absence rather than inventing a repo', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('--show-toplevel')) return { stdout: '/home/k/d/api\n' };
    if (args.includes('remote.origin.url')) return { stdout: 'git@github.com:me/api.git\n' };
    throw new Error('unexpected');
  };
  assert.deepEqual(await gitContext('/home/k/d/api/src', { exec }), {
    remote: 'github.com/me/api',
    repoRoot: '/home/k/d/api',
  });

  const noRepo = async () => { throw Object.assign(new Error('not a git repo'), { code: 128 }); };
  assert.deepEqual(await gitContext('/tmp/scratch', { exec: noRepo }), {
    remote: null,
    repoRoot: null,
  });
});

// --- The subprocess must be BOUNDED IN TIME --------------------------------
//
// `git` runs on every tool call, and `rev-parse --show-toplevel` blocks
// indefinitely on a wedged network/sync mount, a hung credential helper, or an
// fsmonitor daemon that never answers. Reproduced with a `git` that sleeps 600s:
// the hook never returned. The error boundary bounds exceptions, not time — so
// the bound has to be here.

test('git is spawned with a hard timeout and SIGKILL — not left to block forever', async () => {
  let opts = null;
  const exec = async (cmd, args, options) => {
    opts = options;
    if (args.includes('--show-toplevel')) return { stdout: '/home/k/d/api\n' };
    return { stdout: '' };
  };
  await gitContext('/home/k/d/api', { exec });
  assert.equal(typeof opts.timeout, 'number');
  assert.ok(opts.timeout > 0 && opts.timeout <= 5_000, `implausible timeout: ${opts.timeout}`);
  assert.equal(opts.killSignal, 'SIGKILL', 'a wedged process may never handle a TERM');
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

test('a TIMEOUT is not "not a repo" — a slow disk must never silently re-key the project', async () => {
  // Both catches in gitContext exist to swallow a git that says NO. A git that
  // says NOTHING is a different fact. Swallowed as `repoRoot: null`, a wedged
  // mount would re-key the project to its cwd, hash it to a different slot, and
  // hand the user a different character in a different colour for the same repo.
  const killed = () => Promise.reject(Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' }));
  await assert.rejects(gitContext('/mnt/wedged/repo', { exec: killed }), /git timed out/);

  // ...and the timeout on the SECOND call (remote.origin.url) is caught too — it
  // is a separate try/catch, and "a repo with no origin" is a different fact from
  // "a credential helper that never answered".
  const killedOnRemote = async (cmd, args) => {
    if (args.includes('--show-toplevel')) return { stdout: '/home/k/d/api\n' };
    throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGKILL' });
  };
  await assert.rejects(gitContext('/home/k/d/api', { exec: killedOnRemote }), /git timed out/);
});

// A real checkout can be reached through a symlink (e.g. `~/d/familiar` pointing
// somewhere else on disk), and `git rev-parse --show-toplevel` reports the
// PHYSICAL path, not the symlink a human typed to get there. gitContext must pass
// that straight through rather than "fixing" it to match whatever cwd string it
// was given — the fix-up (canonicalizing a *pin's* path to compare against it) is
// Task 7's job, not this module's. Prove it with an injected fake exec, not the
// real repo: tests must not depend on the machine having any particular repo
// checked out (packaged tarballs and some CI checkouts have no .git at all).
test('gitContext reports the PHYSICAL repo root exactly as git gives it, with no realpath/normalization applied', async () => {
  const physicalRoot = '/var/lib/physical-target/api'; // stands in for a resolved symlink target
  const exec = async (cmd, args) => {
    if (args.includes('--show-toplevel')) return { stdout: `${physicalRoot}\n` };
    if (args.includes('remote.origin.url')) return { stdout: '' };
    throw new Error('unexpected');
  };
  const { repoRoot } = await gitContext('/home/k/d/api-symlink', { exec });
  // Asserted verbatim against the fake's stdout: no realpath, no re-lexicalizing.
  assert.equal(repoRoot, physicalRoot);
});
