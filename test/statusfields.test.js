// The ONE impure part of the HUD. Everything Claude Code sends, plus the single subprocess.
//
// readFields takes a PARSED OBJECT, not a string. bin/familiar:238 already JSON.parses the
// same stdin to get the session id and throws on malformed input, so a second forgiving parse
// in here would be dead code that LOOKS like error handling -- and a unit test asserting
// "malformed stdin yields absent fields" would pass while the CLI could never reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readFields, gitBranch, claimedTask, BRANCH_TIMEOUT_MS, CLAIMS_TIMEOUT_MS,
} from '../src/render/term/statusfields.js';

const noGit = () => null;
const noClaim = () => null;

const PAYLOAD = {
  session_id: 'abc',
  cwd: '/home/k/d/api',
  workspace: { current_dir: '/home/k/d/familiar' },
  model: { display_name: 'Opus 4.8 (1M context)' },
  context_window: { used_percentage: 22.7, context_window_size: 1000000 },
};

test('the project is the workspace directory\'s basename', () => {
  assert.equal(readFields(PAYLOAD, { git: noGit, claim: noClaim }).project, 'familiar');
});

test('workspace.current_dir wins over cwd, and cwd is the fallback', () => {
  assert.equal(readFields({ cwd: '/home/k/d/api' }, { git: noGit, claim: noClaim }).project, 'api');
});

test('the model is display_name verbatim — the context suffix is already in it', () => {
  assert.equal(readFields(PAYLOAD, { git: noGit, claim: noClaim }).model, 'Opus 4.8 (1M context)');
});

test('a missing model is null, not an empty string', () => {
  assert.equal(readFields({}, { git: noGit, claim: noClaim }).model, null);
});

test('used_percentage null and used_percentage absent both become null', () => {
  assert.equal(readFields({ context_window: { used_percentage: null } }, { git: noGit, claim: noClaim }).usedPercent, null);
  assert.equal(readFields({ context_window: {} }, { git: noGit, claim: noClaim }).usedPercent, null);
  assert.equal(readFields({}, { git: noGit, claim: noClaim }).usedPercent, null);
});

test('a real percentage survives as a number, undegraded', () => {
  assert.equal(readFields(PAYLOAD, { git: noGit, claim: noClaim }).usedPercent, 22.7);
});

test('an absent payload is an empty object, not a crash', () => {
  const fields = readFields({}, { git: noGit, claim: noClaim });
  assert.equal(fields.model, null);
  assert.equal(fields.usedPercent, null);
  assert.equal(typeof fields.project, 'string');
});

// --- git -------------------------------------------------------------------

const repo = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-hud-git-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const commit = (dir) =>
  git(dir, '-c', 'hook.identity-check.enabled=false', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');

test('gitBranch reads the branch of a real repository', () => {
  repo((dir) => {
    git(dir, 'init', '-q', '-b', 'trunk');
    commit(dir);
    assert.equal(gitBranch(dir), 'trunk');
  });
});

test('a detached HEAD reads as a short sha', () => {
  repo((dir) => {
    git(dir, 'init', '-q', '-b', 'trunk');
    commit(dir);
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '-q', sha);
    assert.match(gitBranch(dir), /^[0-9a-f]{7,}$/);
  });
});

test('a directory that is not a repository has no branch, and that is not an error', () => {
  repo((dir) => {
    assert.equal(gitBranch(dir), null);
  });
});

// LATENCY IS A CORRECTNESS PROPERTY HERE (spec 2.5): with refreshInterval set, an update
// arriving mid-run CANCELS the in-flight script, so an unbounded subprocess is a status line
// that can never paint. This runs a fake `git` that sleeps well past the timeout.
test('a git call that hangs is abandoned, not waited on', () => {
  repo((dir) => {
    const fake = join(dir, 'bin');
    execFileSync('mkdir', ['-p', fake]);
    // `exec /bin/sleep`, by ABSOLUTE PATH. PATH here is the fake dir alone, so a bare `sleep`
    // is not found, git exits instantly, and the test passes without ever exercising the
    // timeout -- a green light for an unbounded subprocess.
    writeFileSync(join(fake, 'git'), '#!/bin/sh\nexec /bin/sleep 30\n');
    chmodSync(join(fake, 'git'), 0o755);

    const started = Date.now();
    const result = gitBranch(dir, { env: { ...process.env, PATH: fake } });
    const elapsed = Date.now() - started;

    assert.equal(result, null);
    // Two bounded attempts (symbolic-ref, rev-parse), so the floor is ~2x the timeout: this
    // asserts the timeout FIRED, not merely that the call returned.
    assert.ok(elapsed >= BRANCH_TIMEOUT_MS, `returned in ${elapsed}ms — the timeout never fired`);
    assert.ok(elapsed < BRANCH_TIMEOUT_MS * 4, `waited ${elapsed}ms on a hung git`);
  });
});

test('the timeout is small enough to matter against a 2s refresh interval', () => {
  // Two attempts must fit inside the interval with room to spare.
  assert.ok(BRANCH_TIMEOUT_MS > 0 && BRANCH_TIMEOUT_MS * 2 < 1000, `BRANCH_TIMEOUT_MS is ${BRANCH_TIMEOUT_MS}`);
});

// --- the claimed task --------------------------------------------------------
//
// `tasks claims --json` on a fake `tasks`. Every subprocess here gets an environment built key
// by key -- PATH at the fake alone, HOME at a directory the test owns -- never the inherited
// one, so a failing case cannot print a credential the host holds.

const SESSION = '58cd57bb-06c9-4485-a010-f69c52359ff4';

const claimRow = (over) => ({
  id: 'fam-ff5351', prefix: 'fam', session: SESSION, host: 'host-a',
  worktree: '/w', started: '2026-10-26T00:38:48Z', seen: '2026-10-26T00:41:24Z', live: true, ...over,
});

// A fake `tasks` whose body is `script`. It refuses any argv but `claims --json`: the explicit
// flag is load-bearing, because TASKS_FORMAT=pretty overrides the JSON default.
const withTasks = (script, fn) => repo((dir) => {
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  execFileSync('/bin/mkdir', ['-p', bin, home]);
  writeFileSync(join(bin, 'tasks'),
    `#!/bin/sh\n[ "$*" = "claims --json" ] || { echo "argv: $*" >&2; exit 64; }\n${script}\n`);
  chmodSync(join(bin, 'tasks'), 0o755);
  const warnings = [];
  const result = fn({
    env: { PATH: bin, HOME: home, TASKS_FORMAT: 'pretty' },
    warn: (message) => warnings.push(message),
    dir,
  });
  return { result, warnings };
});

const serving = (body, fn) => repo((dir) => {
  const file = join(dir, 'claims.json');
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return fn(`exec /bin/cat '${file}'`);
});

const lookup = (body) => {
  let out;
  serving(body, (script) => {
    out = withTasks(script, ({ env, warn }) => claimedTask(SESSION, { env, warn }));
  });
  return out;
};

test('no claim held by anyone is no task, and no warning', () => {
  assert.deepEqual(lookup({ claims: [] }), { result: null, warnings: [] });
});

test('one live claim held by this session is the task', () => {
  assert.deepEqual(lookup({ claims: [claimRow()] }), { result: { id: 'fam-ff5351', others: 0 }, warnings: [] });
});

test('several claims show the latest started, counting the rest', () => {
  const { result, warnings } = lookup({
    claims: [
      claimRow({ id: 'fam-aaaaaa', started: '2026-10-25T10:00:00Z' }),
      claimRow({ id: 'fam-bbbbbb', started: '2026-10-26T01:00:00Z' }),
      claimRow({ id: 'fam-cccccc', started: '2026-10-25T23:59:59Z' }),
    ],
  });
  assert.deepEqual(result, { id: 'fam-bbbbbb', others: 2 });
  assert.deepEqual(warnings, []);
});

test('a dead claim is not this session\'s task', () => {
  assert.deepEqual(lookup({ claims: [claimRow({ live: false })] }), { result: null, warnings: [] });
});

test('another session\'s claim is not this session\'s task', () => {
  const { result } = lookup({
    claims: [claimRow({ session: 'someone-else' }), claimRow({ id: 'fam-dddddd', live: false })],
  });
  assert.equal(result, null);
});

test('no session id asks nothing at all', () => {
  const { result, warnings } = withTasks('exit 70', ({ env, warn }) => claimedTask(undefined, { env, warn }));
  assert.equal(result, null);
  assert.deepEqual(warnings, []);
});

test('no `tasks` on PATH is the same as no claim, silently', () => {
  repo((dir) => {
    const warnings = [];
    const result = claimedTask(SESSION, { env: { PATH: dir, HOME: dir }, warn: (m) => warnings.push(m) });
    assert.equal(result, null);
    assert.deepEqual(warnings, []);
  });
});

test('unparseable JSON leaves the segment off and says so once', () => {
  const { result, warnings } = lookup('{"claims": [');
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tasks claims/);
  assert.match(warnings[0], /JSON/);
});

test('JSON of the wrong shape is a fault, not an empty list', () => {
  for (const body of [{}, { claims: {} }, { claims: [{ ...claimRow(), id: 7 }] }, { claims: [{ ...claimRow(), started: null }] }]) {
    const { result, warnings } = lookup(body);
    assert.equal(result, null, JSON.stringify(body));
    assert.equal(warnings.length, 1, JSON.stringify(body));
    assert.match(warnings[0], /tasks claims/);
  }
});

test('a non-zero exit leaves the segment off and says so once', () => {
  const { result, warnings } = withTasks('exit 3', ({ env, warn }) => claimedTask(SESSION, { env, warn }));
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tasks claims/);
  assert.match(warnings[0], /3/);
});

// The same latency rule as git: an update arriving mid-run CANCELS the script.
test('a `tasks` that hangs is abandoned, not waited on', () => {
  const started = Date.now();
  const { result, warnings } = withTasks('exec /bin/sleep 30', ({ env, warn }) => claimedTask(SESSION, { env, warn }));
  const elapsed = Date.now() - started;
  assert.equal(result, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /timed out/);
  assert.ok(elapsed >= CLAIMS_TIMEOUT_MS, `returned in ${elapsed}ms — the timeout never fired`);
  assert.ok(elapsed < CLAIMS_TIMEOUT_MS * 4, `waited ${elapsed}ms on a hung tasks`);
});

test('the claim and branch lookups together fit well inside a 2s refresh interval', () => {
  assert.ok(CLAIMS_TIMEOUT_MS > 0 && BRANCH_TIMEOUT_MS * 2 + CLAIMS_TIMEOUT_MS < 1000,
    `worst case ${BRANCH_TIMEOUT_MS * 2 + CLAIMS_TIMEOUT_MS}ms`);
});

test('readFields asks for the payload session\'s claim through the injected runner', () => {
  const asked = [];
  const fields = readFields(PAYLOAD, {
    git: noGit,
    claim: (session) => { asked.push(session); return { id: 'fam-ff5351', others: 0 }; },
  });
  assert.deepEqual(asked, ['abc']);
  assert.deepEqual(fields.claim, { id: 'fam-ff5351', others: 0 });
});
