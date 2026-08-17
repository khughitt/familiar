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
import { readFields, gitBranch, BRANCH_TIMEOUT_MS } from '../src/render/term/statusfields.js';

const noGit = () => null;

const PAYLOAD = {
  session_id: 'abc',
  cwd: '/home/k/d/api',
  workspace: { current_dir: '/home/k/d/familiar' },
  model: { display_name: 'Opus 4.8 (1M context)' },
  context_window: { used_percentage: 22.7, context_window_size: 1000000 },
};

test('the project is the workspace directory\'s basename', () => {
  assert.equal(readFields(PAYLOAD, { git: noGit }).project, 'familiar');
});

test('workspace.current_dir wins over cwd, and cwd is the fallback', () => {
  assert.equal(readFields({ cwd: '/home/k/d/api' }, { git: noGit }).project, 'api');
});

test('the model is display_name verbatim — the context suffix is already in it', () => {
  assert.equal(readFields(PAYLOAD, { git: noGit }).model, 'Opus 4.8 (1M context)');
});

test('a missing model is null, not an empty string', () => {
  assert.equal(readFields({}, { git: noGit }).model, null);
});

test('used_percentage null and used_percentage absent both become null', () => {
  assert.equal(readFields({ context_window: { used_percentage: null } }, { git: noGit }).usedPercent, null);
  assert.equal(readFields({ context_window: {} }, { git: noGit }).usedPercent, null);
  assert.equal(readFields({}, { git: noGit }).usedPercent, null);
});

test('a real percentage survives as a number, undegraded', () => {
  assert.equal(readFields(PAYLOAD, { git: noGit }).usedPercent, 22.7);
});

test('an absent payload is an empty object, not a crash', () => {
  const fields = readFields({}, { git: noGit });
  assert.equal(fields.model, null);
  assert.equal(fields.usedPercent, null);
  assert.equal(typeof fields.project, 'string');
});

// --- git -------------------------------------------------------------------

const repo = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-hud-git-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const commit = (dir) =>
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');

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
