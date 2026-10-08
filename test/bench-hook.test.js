import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  summarize, batchOrder, pairedComparison, proveHook, parseSettings, requireDistinctSources,
} from '../tools/bench-hook.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TOOL = join(REPO, 'tools/bench-hook.mjs');
const WRAPPER = join(REPO, 'test/fixtures/bench-hook-cli.mjs');
const LINUX = { skip: process.platform !== 'linux' && 'CLI fixture uses Linux /proc' };

const tempRoot = (t, prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return realpathSync(root);
};

// A checkout with no npm packages whose proc module and bin are stand-ins: what the wrapper
// patches, and what the bin then sees, says which checkout's modules were actually loaded.
function standIn(root, binBody) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'src/bus'), { recursive: true });
  writeFileSync(join(root, 'package.json'),
    JSON.stringify({ name: 'stand-in', version: '0.0.0', type: 'module' }));
  writeFileSync(join(root, 'src/bus/proc.js'), `export const defaultProcessOps = {
  sentinel: 'stand-in',
  recordOf: (pid) => ({ pid, ppid: 1, comm: 'stand-in', tty: null, starttime: 1 }),
  ancestors: () => [],
};
`);
  writeFileSync(join(root, 'bin/familiar'), binBody);
  return root;
}

// A child that records its pid and then waits, so cancellation has something to reap.
function hangScript(root) {
  const script = join(root, 'hang.sh');
  writeFileSync(script, '#!/bin/sh\necho $$ > "$1"\nexec sleep 30\n');
  chmodSync(script, 0o755);
  return script;
}

const hangingBin = (script, pidFile) => `import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
await promisify(execFile)(${JSON.stringify(script)}, [${JSON.stringify(pidFile)}]);
`;

const exited = (child) => new Promise((resolve) => {
  child.once('close', (code, signal) => resolve({ code, signal }));
});

async function until(predicate, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
};

test('paired ordering counterbalances the two measured sources', () => {
  assert.deepEqual(batchOrder(0), ['baseline', 'candidate']);
  assert.deepEqual(batchOrder(1), ['candidate', 'baseline']);
  assert.deepEqual(summarize([4, 1, 3, 2]), { medianMs: 2.5, p95Ms: 4 });
  assert.throws(() => summarize([]), /samples/);
});

test('summaries refuse nonfinite samples', () => {
  assert.throws(() => summarize([1, Number.NaN]), /samples/);
  assert.throws(() => summarize([1, Number.POSITIVE_INFINITY]), /samples/);
  assert.throws(() => summarize([1, '2']), /samples/);
});

test('pair differences do not mistake between-pair drift for the version delta', () => {
  const pairs = [10, 20, 30, 40].map((base, index) => ({
    index, order: batchOrder(index), contexts: { main: {
      baseline: { samples: [{ hookMs: base }, { hookMs: base }] },
      candidate: { samples: [{ hookMs: base + 2 }, { hookMs: base + 2 }] },
    } },
  }));
  const r = pairedComparison(pairs, 'main');
  assert.deepEqual(r.pairedDeltasMs, [2, 2, 2, 2]);
  assert.equal(r.deltaMedianMs, 2);
  assert.equal(r.timingStatus, 'review-required');
});

test('paired comparison breaks deltas down by order and prices the candidate probe', () => {
  const probe = (ms) => ({ args: ['-C', '/r', 'rev-parse', '--is-bare-repository', '--show-toplevel'], ms });
  const pairs = [0, 1].map((index) => ({
    index, order: batchOrder(index), contexts: { linked: {
      baseline: { samples: [{ hookMs: 10, git: [] }] },
      candidate: { samples: [{ hookMs: index === 0 ? 13 : 15, git: [probe(index === 0 ? 1 : 3)] }] },
    } },
  }));
  const r = pairedComparison(pairs, 'linked');
  assert.deepEqual(r.byOrder, {
    'baseline-first': { medianMs: 3, p95Ms: 3 },
    'candidate-first': { medianMs: 5, p95Ms: 5 },
  });
  assert.deepEqual(r.candidateProbeMs, { medianMs: 2, p95Ms: 3 });
  assert.equal(r.deltaPercent, 40);
  assert.deepEqual(r.baseline, { medianMs: 10, p95Ms: 10 });
});

test('an exit-zero diagnostic cannot be a successful sample', () => {
  const id = 'bench-main';
  const agents = { [id]: { pid: 42, repoRoot: '/fixture/api', state: 'working' } };
  const intents = { [id]: { current: { state: 'working' } } };
  assert.throws(() => proveHook({ status: 0, stdout: '', stderr: 'familiar: failed\n' },
    agents, intents, id, 42, '/fixture/api'), /cleanly|diagnostic/);
});

test('a sample proves its working record, owner and checkout', () => {
  const id = 'bench-main';
  const clean = { status: 0, signal: null, stdout: '', stderr: '' };
  const agents = { [id]: { pid: 42, repoRoot: '/fixture/api', state: 'working' } };
  const intents = { [id]: { current: { state: 'working' } } };
  assert.equal(proveHook(clean, agents, intents, id, 42, '/fixture/api'), 'working');

  const rejects = [
    [{ ...clean, error: new Error('spawn ENOENT') }, agents, intents, 42, '/fixture/api', /spawn/],
    [{ ...clean, status: null, signal: 'SIGKILL' }, agents, intents, 42, '/fixture/api', /signal/],
    [{ ...clean, status: 1 }, agents, intents, 42, '/fixture/api', /exit/],
    [{ ...clean, stdout: 'noise' }, agents, intents, 42, '/fixture/api', /cleanly|diagnostic/],
    [clean, {}, intents, 42, '/fixture/api', /agent record/],
    [clean, { [id]: { ...agents[id], state: 'idle' } }, intents, 42, '/fixture/api', /working/],
    [clean, agents, intents, 43, '/fixture/api', /pid/],
    [clean, agents, intents, 42, '/fixture/fix-api', /checkout/],
    [clean, agents, {}, 42, '/fixture/api', /intent/],
    [clean, agents, { [id]: { current: { state: 'done' } } }, 42, '/fixture/api', /intent/],
  ];
  for (const [result, a, i, pid, checkout, pattern] of rejects) {
    assert.throws(() => proveHook(result, a, i, id, pid, checkout), pattern);
  }
});

test('settings refuse malformed modes, counts and source paths', (t) => {
  const root = tempRoot(t, 'familiar-bench-settings-');
  const source = standIn(join(root, 'source'), '');
  const binless = join(root, 'binless');
  mkdirSync(binless);
  const fixture = join(root, 'fixture');
  const ok = ['pilot', source, source, fixture, '30', '5', '4'];
  const settings = parseSettings(ok);
  assert.equal(settings.mode, 'pilot');
  assert.deepEqual([settings.samples, settings.warmups, settings.pairs], [30, 5, 4]);
  assert.equal(settings.sources.baseline, source);
  assert.equal(settings.fixture, fixture);

  const bad = (index, value) => ok.map((v, i) => (i === index ? value : v));
  assert.throws(() => parseSettings(bad(0, 'bogus')), /mode/);
  assert.throws(() => parseSettings(ok.slice(0, 3)), /usage/);
  for (const value of ['0', '1.5', 'x', '']) assert.throws(() => parseSettings(bad(4, value)), /samples/);
  for (const value of ['-1', '0.5']) assert.throws(() => parseSettings(bad(5, value)), /warmups/);
  assert.throws(() => parseSettings(bad(6, '0')), /pairs/);
  assert.throws(() => parseSettings(bad(1, join(root, 'missing'))), /baseline/);
  assert.throws(() => parseSettings(bad(2, binless)), /candidate.*bin\/familiar/);
});

test('settings refuse to overwrite an earlier run\'s artifacts', (t) => {
  const root = tempRoot(t, 'familiar-bench-overwrite-');
  const source = standIn(join(root, 'source'), '');
  const fixture = join(root, 'fixture');
  mkdirSync(fixture);
  writeFileSync(join(fixture, 'report.json'), '{"kept":true}\n');
  const r = spawnSync(process.execPath, [TOOL, 'pilot', source, source, fixture, '1', '0', '1'], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /fixture/);
  assert.equal(readFileSync(join(fixture, 'report.json'), 'utf8'), '{"kept":true}\n');
});

test('a comparison needs two distinct source revisions', () => {
  assert.throws(() => requireDistinctSources({ revision: 'a' }, { revision: 'a' }), /distinct/);
  assert.throws(() => requireDistinctSources({ revision: null }, { revision: 'b' }), /revision/);
  assert.doesNotThrow(() => requireDistinctSources({ revision: 'a' }, { revision: 'b' }));
});

test('the wrapper patches and runs the measured checkout, not the driver\'s', (t) => {
  const root = tempRoot(t, 'familiar-bench-source-');
  const source = standIn(join(root, 'source'), `import { defaultProcessOps } from '../src/bus/proc.js';
process.stdout.write(JSON.stringify({
  sentinel: defaultProcessOps.sentinel,
  comms: defaultProcessOps.ancestors().map((r) => r.comm),
  argv: process.argv.slice(2),
  bin: process.argv[1],
}));
`);
  const r = spawnSync(process.execPath, [WRAPPER, join(source, 'bin/familiar'), 'hook', 'PreToolUse'], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(r.stdout);
  assert.equal(seen.sentinel, 'stand-in');
  assert.deepEqual(seen.comms, ['stand-in', 'claude']);
  assert.deepEqual(seen.argv, ['hook', 'PreToolUse']);
  assert.equal(seen.bin, join(source, 'bin/familiar'));
});

test('a terminated wrapper reaps the command it is running', async (t) => {
  const root = tempRoot(t, 'familiar-bench-wrapper-term-');
  const pidFile = join(root, 'child.pid');
  const source = standIn(join(root, 'source'), hangingBin(hangScript(root), pidFile));
  const child = spawn(process.execPath, [WRAPPER, join(source, 'bin/familiar')], { stdio: 'ignore' });
  const done = exited(child);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'), 10_000, 'the child pid');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  child.kill('SIGTERM');
  const { code, signal } = await done;
  assert.ok(code !== 0 || signal !== null);
  await until(() => gone(pid), 5_000, `pid ${pid} to be reaped`);
});

test('a terminated controller cancels its worker, wrapper and their children', LINUX, async (t) => {
  const root = tempRoot(t, 'familiar-bench-chain-term-');
  const pidFile = join(root, 'child.pid');
  const source = standIn(join(root, 'source'), hangingBin(hangScript(root), pidFile));
  const fixture = join(root, 'fixture');
  const controller = spawn(process.execPath, [TOOL, 'pilot', source, source, fixture, '1', '0', '1'], {
    stdio: 'ignore', env: { ...process.env, TT_LOG: join(root, 'runs.jsonl') },
  });
  const done = exited(controller);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'), 15_000, 'the child pid');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  controller.kill('SIGTERM');
  const { code, signal } = await done;
  assert.ok(code !== 0 || signal !== null);
  await until(() => gone(pid), 5_000, `pid ${pid} to be reaped`);
  const survivors = readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((name) => {
    try {
      return readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(root);
    } catch {
      return false;
    }
  });
  assert.deepEqual(survivors, []);
  assert.equal(existsSync(join(fixture, 'report.json')), false);
});

test('a controller rejects a batch whose hook exits zero with a diagnostic', (t) => {
  const root = tempRoot(t, 'familiar-bench-diagnostic-');
  const source = standIn(join(root, 'source'), "process.stderr.write('familiar: failed\\n');\n");
  const fixture = join(root, 'fixture');
  const r = spawnSync(process.execPath, [TOOL, 'pilot', source, source, fixture, '1', '0', '1'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, TT_LOG: join(root, 'runs.jsonl') },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cleanly|diagnostic/);
  assert.equal(existsSync(join(fixture, 'report.json')), false);
});

test('the real just recipe forwards paths and records paired hooks', LINUX, (t) => {
  const root = tempRoot(t, 'familiar-paired-smoke-');
  const fixture = join(root, "pilot's fixture with spaces");
  const log = join(root, 'runs.jsonl');
  const r = spawnSync('just', ['bench-hook', 'pilot', REPO, REPO,
    fixture, '1', '0', '1'], { cwd: REPO, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, TT_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(join(fixture, 'report.json'), 'utf8');
  // Reports are attached to task records: no machine path may survive in one.
  assert.equal(text.includes(realpathSync(fixture)), false, 'the report names the fixture path');
  assert.equal(text.includes(realpathSync(REPO)), false, 'the report names the checkout path');
  const report = JSON.parse(text);
  assert.equal(report.sources.baseline.root, '.');
  assert.equal(report.projects.linked, '<fixture>/worktrees/fix-api');
  assert.equal(report.mode, 'pilot');
  assert.equal(report.timingStatus, 'pilot-only');
  for (const context of ['main', 'linked']) {
    for (const version of ['baseline', 'candidate']) {
      const sample = report.pairs[0].contexts[context][version].samples[0];
      assert.ok(Number.isFinite(sample.hookMs) && sample.hookMs > 0);
      assert.equal(sample.provedState, 'working');
      assert.ok(sample.git.length >= 2);
    }
  }
  const rows = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  for (const context of ['main', 'linked']) {
    for (const version of ['baseline', 'candidate']) {
      assert.ok(rows.some((r) => r.target === `bench-hook-${context}-${version}` && r.exit === 0));
    }
  }
});

test('the Ubuntu test job installs just before its npm and test commands', () => {
  const workflow = parseYaml(readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8'));
  const steps = workflow.jobs.test.steps;
  const setup = steps.findIndex((s) => String(s.uses ?? '').startsWith('extractions/setup-just@'));
  assert.ok(setup >= 0, 'the test job does not install just');
  assert.equal(steps[setup].with['just-version'], '1.58.0');
  const firstNpm = steps.findIndex((s) => /\bnpm\b/.test(String(s.run ?? '')));
  assert.ok(firstNpm >= 0 && setup < firstNpm, 'just is installed after the npm commands');
});
