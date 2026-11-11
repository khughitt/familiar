import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';
import { fixtureGitEnv, seedRepo } from './fixtures/git-worktree.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const workflow = parse(readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8'));
const condition = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name != github.repository";
const setupJust = 'extractions/setup-just@53165ef7e734c5c07cb06b3c8e7b647c5aa16db3';
const capabilities = [
  'Darwin real per-pid reads keep this process identity stable',
  'Darwin ps keeps comm last and canonicalizes tty',
  'Darwin copies a stable local pack through its pathname walker',
  'an atomic intent commit wakes a directory watcher on this platform',
  'intent-watch filenames on darwin:',
  'without a readable boot ID a saved health record never reads healthy and claims nothing',
];

test('workflow covers unfiltered branch/tag pushes, dispatch and fork PRs without duplicate internal PR suites', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.equal(workflow.on.push, null);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['macos', 'smoke', 'test']);
  for (const job of Object.values(workflow.jobs)) assert.equal(job.if, condition);
});

test('hosted verification is explicitly forced, read-only, bounded and cancelled per workflow/ref', () => {
  assert.equal(workflow.env.TT_FORCE, '1');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, {
    group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true,
  });
  for (const job of Object.values(workflow.jobs)) assert.equal(job['timeout-minutes'], 20);
});

test('the existing Linux matrix, clean-install smoke and macOS Node/platform coverage remain', () => {
  assert.equal(workflow.jobs.test['runs-on'], 'ubuntu-latest');
  assert.deepEqual(workflow.jobs.test.strategy.matrix.node, ['22', '26']);
  assert.equal(workflow.jobs.smoke['runs-on'], 'ubuntu-latest');
  assert.equal(workflow.jobs.macos['runs-on'], 'macos-15');
  for (const [name, node] of [['smoke', '26'], ['macos', '22']]) {
    assert.equal(workflow.jobs[name].steps.find(s => s.uses === 'actions/setup-node@v4').with['node-version'], node);
  }
  const linux = workflow.jobs.test.steps.map(s => s.run).filter(Boolean);
  assert.ok(linux.some(s => s.includes('apt-get install -y tmux zsh kitty-terminfo')));
  assert.equal(linux.filter(s => s === 'just test').length, 1);
  assert.ok(!linux.some(s => /ci-test|npm test|npm run test:slow/.test(s)));
  const smoke = workflow.jobs.smoke.steps.find(s => s.name === 'clean-clone install smoke').run;
  assert.match(smoke, /rm -rf node_modules package-lock.json \.git/);
  assert.match(smoke, /npm install/);
  assert.match(smoke, /\.\/bin\/familiar --help/);
});

for (const name of ['test', 'macos']) {
  test(`${name} hydrates Luau before portable hygiene and the forced front door`, () => {
    const steps = workflow.jobs[name].steps;
    const npm = steps.findIndex(s => s.run === 'npm ci');
    const luau = steps.findIndex(s => s.run === 'node tools/fetch-luau.mjs');
    const hygiene = steps.findIndex(s => s.run === 'python3 tools/ops-check && python3 tools/ops-docs check');
    const suite = steps.findIndex(s => /^just test$|just test-fast/.test(s.run ?? ''));
    assert.ok(npm >= 0 && luau > npm && hygiene > luau && suite > hygiene);
    assert.equal(steps.find(s => s.uses === setupJust).with['just-version'], '1.58.0');
  });
}

test('jobs do not borrow a tasks registry and smoke does not run unhydrated hygiene', () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) assert.doesNotMatch(step.run ?? '', /\btasks\b/);
  }
  const smoke = workflow.jobs.smoke.steps.map(s => s.run ?? '').join('\n');
  assert.doesNotMatch(smoke, /fetch-luau|ops-check|ops-docs/);
});

test('macOS suite step enforces each Darwin capability, refuses skips and preserves pipeline failure', (t) => {
  const step = workflow.jobs.macos.steps.find(s => s.name === 'fast suite with Darwin tests enforced');
  assert.equal(step.env.TMPDIR, '/tmp');
  const home = mkdtempSync(join(tmpdir(), 'workflow-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'just'), '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = test-fast ] || exit 64\nprintf "%s\\n" "$SUITE_OUTPUT"\nexit "$SUITE_EXIT"\n');
  chmodSync(join(bin, 'just'), 0o755);
  const run = (output, exit = '0') => {
    const r = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', step.run], {
      cwd: home, encoding: 'utf8', timeout: 5_000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, RUNNER_TEMP: home,
        TMPDIR: '/tmp', TT_FORCE: '1', SUITE_OUTPUT: output, SUITE_EXIT: exit },
    });
    assert.ifError(r.error);
    return r;
  };
  const all = capabilities.join('\n');
  const success = run(all);
  assert.equal(success.status, 0, success.stderr + success.stdout);
  for (const missing of capabilities) {
    assert.notEqual(run(capabilities.filter(c => c !== missing).join('\n')).status, 0, missing);
  }
  assert.notEqual(run(`${all}\nrequires Darwin`).status, 0);
  assert.notEqual(run(all, '7').status, 0);
});

test('macOS workflow preserves complete timed output under backpressure with inherited Node stderr', { timeout: 15_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-pressure-'));
  const root = seedRepo(join(home, 'repo'));
  mkdirSync(join(root, 'tools'));
  mkdirSync(join(root, 'tasks'));
  writeFileSync(join(root, 'tasks/.config.toml'), 'prefix = "fixture"\n');
  copyFileSync(join(REPO, 'tools/tt'), join(root, 'tools/tt'));
  writeFileSync(join(root, 'justfile'), readFileSync(join(REPO, 'justfile'), 'utf8')
    .replace('fast_cmd := "npm test"', 'fast_cmd := "node flood.mjs"'));
  const ready = join(home, 'ready');
  const payload = 'x'.repeat(2 * 1024 * 1024);
  writeFileSync(join(root, 'flood.mjs'), `
import { writeFileSync } from 'node:fs';
process.stderr.write(${JSON.stringify(capabilities.join('\n') + '\n')});
process.stdout.write('x'.repeat(${payload.length}) + String.fromCharCode(10), () => writeFileSync(${JSON.stringify(ready)}, 'ready'));
// Keep Node's inherited stderr active while the collector meets output pressure.
setTimeout(() => {}, 2000);
`);
  const step = workflow.jobs.macos.steps.find(s => s.name === 'fast suite with Darwin tests enforced');
  const child = spawn('/bin/bash', ['-e', '-o', 'pipefail', '-c', step.run], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...fixtureGitEnv(home), USER: 'fixture', RUNNER_TEMP: home,
      TMPDIR: '/tmp', TT_FORCE: '1', TT_LOG: join(home, 'runs.jsonl') },
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stdout.pause();
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  closed.catch(() => {});
  const stop = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const signals = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, () => {
    stop(); process.exit(signal === 'SIGTERM' ? 143 : 130);
  }]));
  process.once('exit', stop);
  for (const [signal, handler] of signals) process.once(signal, handler);
  t.after(async () => {
    stop();
    await closed.catch(() => {});
    process.removeListener('exit', stop);
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
    rmSync(home, { recursive: true, force: true });
  });
  const deadline = Date.now() + 6000;
  while (!existsSync(ready)) {
    assert.equal(child.exitCode, null, stderr);
    assert.ok(Date.now() < deadline, 'the real timed child must produce its payload');
    await delay(10);
  }
  // A slow log consumer must not make the timed Python collector lose output.
  await delay(300);
  child.stdout.resume();
  const result = await closed;
  assert.deepEqual(result, { code: 0, signal: null }, (stderr + stdout).replace(/x{100,}/g, '[payload]').slice(-2500));
  assert.ok(stdout.includes(payload), 'the entire payload must survive the timed front door');
  for (const capability of capabilities) assert.ok(stdout.includes(capability), capability);
});
