#!/usr/bin/env node
// Paired hook benchmark: `just bench-hook MODE BASELINE CANDIDATE FIXTURE [SAMPLES WARMUPS PAIRS]`.
//
// Measures the wall time of one complete `familiar hook PreToolUse` process for two source
// checkouts in one sitting, on a conventional main checkout and a linked worktree. Each pair
// runs a baseline batch and a candidate batch back to back per context, alternating which goes
// first, so drift on the host lands on both sides of a pair instead of in the version delta.
//
// The same driver and CLI wrapper measure both checkouts; the wrapper loads every module from
// the MEASURED bin. Each batch is one `tools/tt` run (target bench-hook-<context>-<version>,
// cwd the measured checkout, so the timing log records that checkout's revision) around a
// worker that runs the hooks. A sample counts only when the hook exited cleanly with no output
// AND left a fresh working agent record and intent owned by the worker: hook and statusline
// exit zero on failure by design, so an exit status proves nothing.
//
// MODE `pilot` exercises the tool (identical checkouts allowed); `compare` needs two distinct
// revisions and enforces the Git spawn counts of the worktree-identity contract. Timing is never
// judged automatically: the report says `pilot-only` or `review-required`.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { loadavg } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingDependencies } from '../src/deps.js';
import { addWorktree, fixtureGitEnv, seedRepo } from '../test/fixtures/git-worktree.mjs';

const SELF = fileURLToPath(import.meta.url);
const DRIVER_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRAPPER = join(DRIVER_ROOT, 'test/fixtures/bench-hook-cli.mjs');
const TT = join(DRIVER_ROOT, 'tools/tt');
const THEME = join(DRIVER_ROOT, 'test/fixtures/theme-pack');

const MODES = ['pilot', 'compare'];
const CONTEXTS = ['main', 'linked'];
const SAMPLE_TIMEOUT_MS = 10_000;
// Discovery spawns per hook: the code before worktree identity, and after it.
const EXPECTED_GIT = { baseline: { main: 2, linked: 2 }, candidate: { main: 2, linked: 3 } };
const BOUNDARY = 'One `familiar hook PreToolUse --agent claude-code` process per sample, timed by '
  + 'the worker from spawn to exit: node startup, CLI import, Git discovery, the locked bus '
  + 'transaction and emission to a private pipe. Run through test/fixtures/bench-hook-cli.mjs '
  + '(fixture process lookup, instrumented real execFile) with real Git on this host. Not a '
  + 'live-agent latency and not a Darwin measurement.';

const USAGE = 'usage: bench-hook.mjs MODE BASELINE CANDIDATE FIXTURE [SAMPLES [WARMUPS [PAIRS]]]';

export function summarize(samples) {
  if (!Array.isArray(samples) || samples.length === 0
      || !samples.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('summarize needs a nonempty list of finite samples');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const medianMs = sorted.length % 2 === 1
    ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { medianMs, p95Ms: sorted[Math.ceil(0.95 * sorted.length) - 1] };
}

export const batchOrder = (index) => (index % 2 === 0
  ? ['baseline', 'candidate'] : ['candidate', 'baseline']);

const hookTimes = (batch) => batch.samples.map((s) => s.hookMs);
const isProbe = (run) => run.args.includes('--is-bare-repository');

export function pairedComparison(pairs, context) {
  const batches = pairs.map((pair) => pair.contexts[context]);
  const baseline = summarize(batches.flatMap((b) => hookTimes(b.baseline)));
  const candidate = summarize(batches.flatMap((b) => hookTimes(b.candidate)));
  const deltaOf = (b) => summarize(hookTimes(b.candidate)).medianMs
    - summarize(hookTimes(b.baseline)).medianMs;
  const pairedDeltasMs = batches.map(deltaOf);
  const delta = summarize(pairedDeltasMs);
  const ordered = (first) => {
    const deltas = pairs.filter((p) => p.order[0] === first).map((p) => deltaOf(p.contexts[context]));
    return deltas.length === 0 ? null : summarize(deltas);
  };
  const probes = batches.flatMap((b) => b.candidate.samples
    .flatMap((s) => (s.git ?? []).filter(isProbe).map((run) => run.ms)));
  return {
    context,
    baseline,
    candidate,
    pairedDeltasMs,
    deltaMedianMs: delta.medianMs,
    deltaP95Ms: delta.p95Ms,
    deltaPercent: (delta.medianMs / baseline.medianMs) * 100,
    byOrder: { 'baseline-first': ordered('baseline'), 'candidate-first': ordered('candidate') },
    candidateProbeMs: probes.length === 0 ? null : summarize(probes),
    timingStatus: 'review-required',
  };
}

// The process outcome alone, checked before any state file is opened.
function assertClean(result) {
  if (result.error) throw new Error(`hook did not run: ${result.error.message}`);
  if (result.signal) throw new Error(`hook was killed by signal ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(`hook failed with exit status ${result.status}: ${String(result.stderr).trim()}`);
  }
  if (result.stdout !== '' || result.stderr !== '') {
    throw new Error('hook did not exit cleanly: diagnostic output '
      + JSON.stringify(String(result.stderr || result.stdout).trim()));
  }
}

export function proveHook(result, agents, intents, id, workerPid, checkout) {
  assertClean(result);
  const agent = agents?.[id];
  if (!agent) throw new Error(`hook wrote no agent record for ${id}`);
  if (agent.state !== 'working') throw new Error(`agent record for ${id} is ${agent.state}, not working`);
  if (agent.pid !== workerPid) {
    throw new Error(`agent record names pid ${agent.pid}, not the worker ${workerPid}`);
  }
  if (agent.repoRoot !== checkout) {
    throw new Error(`agent record names checkout ${agent.repoRoot}, not ${checkout}`);
  }
  const state = intents?.[id]?.current?.state;
  if (state !== 'working') throw new Error(`intent for ${id} is ${state ?? 'absent'}, not working`);
  return state;
}

export function parseSettings(argv) {
  if (argv.length < 4 || argv.length > 7) throw new Error(USAGE);
  const [mode, baseline, candidate, fixture, samples = '30', warmups = '5', pairs = '4'] = argv;
  if (!MODES.includes(mode)) {
    throw new Error(`mode must be ${MODES.join(' or ')}, not ${JSON.stringify(mode)}`);
  }
  const count = (name, value, min) => {
    if (!/^\d+$/.test(value) || Number(value) < min) {
      throw new Error(`${name} must be a whole number of at least ${min}, not ${JSON.stringify(value)}`);
    }
    return Number(value);
  };
  const source = (name, path) => {
    let root;
    try {
      root = realpathSync(path);
    } catch {
      throw new Error(`${name} checkout ${path} does not exist`);
    }
    if (!existsSync(join(root, 'bin/familiar'))) {
      throw new Error(`${name} checkout ${root} has no bin/familiar`);
    }
    return root;
  };
  const target = resolve(fixture);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`fixture ${target} is not empty; start each run in a fresh fixture `
      + 'rather than overwrite an earlier run\'s artifacts');
  }
  return {
    mode,
    sources: { baseline: source('baseline', baseline), candidate: source('candidate', candidate) },
    fixture: target,
    samples: count('samples', samples, 1),
    warmups: count('warmups', warmups, 0),
    pairs: count('pairs', pairs, 1),
  };
}

export function requireDistinctSources(baseline, candidate) {
  if (!baseline.revision || !candidate.revision) {
    throw new Error('a comparison needs a Git revision for each source checkout');
  }
  if (baseline.revision === candidate.revision) {
    throw new Error(`a comparison needs two distinct source revisions; both are ${baseline.revision}`);
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The bytes a hook can execute: bin/, src/ and the manifest, walked in sorted order.
function sourceHash(root) {
  const hash = createHash('sha256');
  const visit = (relative) => {
    const path = join(root, relative);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    } else {
      hash.update(`${relative}\0`);
      hash.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
      hash.update('\0');
    }
  };
  for (const entry of ['bin', 'src', 'package.json']) visit(entry);
  return hash.digest('hex');
}

function gitOutput(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', env: fixtureGitEnv(),
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function describeSource(root) {
  const missing = missingDependencies({ root });
  if (missing.length > 0) {
    throw new Error(`${root} lacks dependencies (${missing.join(', ')}); `
      + `run \`npm install --prefix ${root}\``);
  }
  const revision = gitOutput(root, ['rev-parse', 'HEAD']);
  const lock = join(root, 'package-lock.json');
  return {
    root,
    bin: join(root, 'bin/familiar'),
    revision,
    dirty: revision === null ? null : gitOutput(root, ['status', '--porcelain']) !== '',
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null,
    sourceHash: sourceHash(root),
    lockHash: existsSync(lock) ? sha256(readFileSync(lock)) : null,
  };
}

// One main repository and one linked worktree, one theme, and separate bus state per
// source/context so neither version's records can pollute the other's.
function prepareFixture(fixture) {
  mkdirSync(fixture, { recursive: true });
  const root = realpathSync(fixture);
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  const themes = join(root, 'themes');
  for (const dir of [home, tmp, join(root, 'runs')]) mkdirSync(dir, { recursive: true });
  cpSync(THEME, join(themes, 'cats'), { recursive: true });
  const main = seedRepo(join(root, 'projects', 'api'));
  const linked = addWorktree(main, join(root, 'worktrees', 'fix-api'));
  const state = {};
  for (const version of ['baseline', 'candidate']) {
    for (const context of CONTEXTS) {
      const dir = join(root, 'state', `${version}-${context}`);
      const config = join(dir, 'config');
      mkdirSync(config, { recursive: true });
      mkdirSync(join(dir, 'bus'), { recursive: true });
      writeFileSync(join(config, 'config.yaml'), 'theme: cats\nmotion: off\n');
      writeFileSync(join(config, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
      writeFileSync(join(config, 'identities.yaml'), 'identities: []\n');
      state[`${version}-${context}`] = { config, bus: join(dir, 'bus') };
    }
  }
  return { root, home, tmp, themes, projects: { main, linked }, state };
}

// Everything the worker and its hooks see, stated outright: nothing inherited from the caller
// but PATH. No Git bindings, no TMUX or NODE_OPTIONS, a dumb terminal, and every file inside
// the fixture.
function workerEnv(fx, version, context) {
  const { config, bus } = fx.state[`${version}-${context}`];
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: fx.home,
    XDG_CONFIG_HOME: join(fx.home, '.config'),
    XDG_STATE_HOME: join(fx.home, '.local/state'),
    XDG_DATA_HOME: join(fx.home, '.local/share'),
    XDG_CACHE_HOME: join(fx.home, '.cache'),
    CODEX_HOME: join(fx.home, '.codex'),
    TMPDIR: fx.tmp,
    TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    FAMILIAR_CONFIG_DIR: config,
    FAMILIAR_STATE_DIR: bus,
    FAMILIAR_THEMES_DIR: fx.themes,
  };
}

async function measureBatch({ index, order, context, version, source, fx, settings, active }) {
  const id = `${index}-${context}-${version}`;
  const target = `bench-hook-${context}-${version}`;
  const spec = {
    measuredBin: source.bin,
    wrapper: WRAPPER,
    projectRoot: fx.projects[context],
    sessionId: `bench-${context}-${version}`,
    warmups: settings.warmups,
    samples: settings.samples,
    env: workerEnv(fx, version, context),
    gitLogPath: join(fx.root, 'runs', `${id}.git.json`),
    resultPath: join(fx.root, 'runs', `${id}.result.json`),
  };
  const specPath = join(fx.root, 'runs', `${id}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec));

  const startedAt = new Date().toISOString();
  const loadBefore = loadavg();
  const assignments = Object.entries(spec.env).map(([key, value]) => `${key}=${value}`);
  const child = spawn('python3', [TT, target, '--', 'env', '-i', ...assignments,
    process.execPath, SELF, '--worker', specPath], {
    cwd: source.root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  active.batch = child;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
    const ready = /^ready (\d+)$/m.exec(stdout);
    if (ready && active.worker === null) {
      active.worker = Number(ready[1]);
      if (active.cancelled) process.kill(active.worker, 'SIGTERM');
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const { code, signal, error } = await new Promise((done) => {
    child.once('error', (spawnError) => done({ code: null, signal: null, error: spawnError }));
    child.once('close', (exitCode, exitSignal) => done({ code: exitCode, signal: exitSignal }));
  });
  active.batch = null;
  active.worker = null;
  if (error) throw new Error(`batch ${id} could not start tt: ${error.message}`);
  if (code !== 0) {
    throw new Error(`batch ${id} failed (${signal ?? `exit ${code}`}): ${stderr.trim()}`);
  }
  if (stderr !== '') process.stderr.write(stderr);
  const result = JSON.parse(readFileSync(spec.resultPath, 'utf8'));
  if (result.complete !== true) throw new Error(`batch ${id} did not complete`);
  return {
    index,
    order,
    context,
    version,
    startedAt,
    endedAt: new Date().toISOString(),
    loadavg: { before: loadBefore, after: loadavg() },
    revision: source.revision,
    sourceHash: source.sourceHash,
    tt: { target, exit: code },
    warmups: result.warmups.length,
    samples: result.samples,
  };
}

function structuralChecks(pairs, mode) {
  const failures = [];
  const observed = {};
  for (const pair of pairs) {
    for (const context of CONTEXTS) {
      for (const version of ['baseline', 'candidate']) {
        for (const [n, sample] of pair.contexts[context][version].samples.entries()) {
          const spawns = sample.git.length;
          const key = `${version}-${context}`;
          observed[key] = [...new Set([...(observed[key] ?? []), spawns])].sort();
          const where = { pair: pair.index, context, version, sample: n };
          if (sample.git.some((run) => run.args.includes('worktree') && run.args.includes('list'))) {
            failures.push({ ...where, check: 'no worktree listing' });
          }
          if (mode === 'compare' && spawns !== EXPECTED_GIT[version][context]) {
            failures.push({ ...where, check: `git spawns ${spawns}, expected ${EXPECTED_GIT[version][context]}` });
          }
        }
      }
    }
  }
  return {
    gitSpawnsEnforced: mode === 'compare',
    expectedGitSpawns: mode === 'compare' ? EXPECTED_GIT : null,
    observedGitSpawns: observed,
    failures,
    pass: failures.length === 0,
  };
}

const SIGNAL_EXIT = { SIGTERM: 143, SIGINT: 130 };

async function controller(argv) {
  const settings = parseSettings(argv);
  const sources = {
    baseline: describeSource(settings.sources.baseline),
    candidate: describeSource(settings.sources.candidate),
  };
  if (settings.mode === 'compare') requireDistinctSources(sources.baseline, sources.candidate);

  // Cancellation is forwarded, never abandoned: the worker is told to stop, and this process
  // waits for its batch to end before it exits. A worker not yet ready is told when it is.
  const active = { batch: null, worker: null, cancelled: null };
  for (const name of Object.keys(SIGNAL_EXIT)) {
    process.on(name, () => {
      active.cancelled = name;
      if (active.worker !== null) process.kill(active.worker, 'SIGTERM');
    });
  }

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const fx = prepareFixture(settings.fixture);
  const batchesPath = join(fx.root, 'batches.jsonl');
  const pairs = [];
  for (let index = 0; index < settings.pairs; index++) {
    const order = batchOrder(index);
    const pair = { index, order, contexts: {} };
    for (const context of CONTEXTS) {
      pair.contexts[context] = {};
      for (const version of order) {
        if (active.cancelled) throw cancelled(active.cancelled);
        let batch;
        try {
          batch = await measureBatch({
            index, order, context, version, source: sources[version], fx, settings, active,
          });
        } catch (error) {
          if (active.cancelled) throw cancelled(active.cancelled);
          throw error;
        }
        pair.contexts[context][version] = batch;
        appendFileSync(batchesPath, `${JSON.stringify({ runId, ...batch })}\n`);
      }
    }
    pairs.push(pair);
  }
  if (active.cancelled) throw cancelled(active.cancelled);

  const structural = structuralChecks(pairs, settings.mode);
  const summaries = Object.fromEntries(CONTEXTS.map((c) => [c, pairedComparison(pairs, c)]));
  const report = {
    schema: 1,
    mode: settings.mode,
    runId,
    startedAt,
    endedAt: new Date().toISOString(),
    settings: { samples: settings.samples, warmups: settings.warmups, pairs: settings.pairs },
    timingStatus: settings.mode === 'pilot' ? 'pilot-only' : 'review-required',
    boundary: BOUNDARY,
    host: {
      platform: process.platform,
      node: process.version,
      git: gitOutput(fx.root, ['--version']),
      driverRevision: gitOutput(DRIVER_ROOT, ['rev-parse', 'HEAD']),
    },
    sources,
    projects: fx.projects,
    pairs,
    structural,
    summaries,
  };
  writeFileSync(join(fx.root, 'report.json'), `${JSON.stringify(portable(report, fx.root), null, 2)}\n`);

  for (const s of Object.values(summaries)) {
    process.stdout.write(`${s.context}: baseline median ${s.baseline.medianMs.toFixed(2)} ms `
      + `(p95 ${s.baseline.p95Ms.toFixed(2)}), candidate median ${s.candidate.medianMs.toFixed(2)} ms `
      + `(p95 ${s.candidate.p95Ms.toFixed(2)}), paired delta median ${s.deltaMedianMs.toFixed(2)} ms `
      + `(${s.deltaPercent.toFixed(1)}%)\n`);
  }
  process.stdout.write(`report: ${join(fx.root, 'report.json')} (${report.timingStatus})\n`);
  if (!structural.pass) {
    throw new Error(`structural checks failed: ${JSON.stringify(structural.failures.slice(0, 5))}`);
  }
}

// Reports are attached to task records, so no machine path survives in one: fixture paths
// become `<fixture>/...` and a source checkout is named relative to the driver checkout.
function portable(report, fixtureRoot) {
  const driver = DRIVER_ROOT.replace(/\/$/, '');
  const scrub = (value) => {
    if (typeof value === 'string') {
      return value.split(fixtureRoot).join('<fixture>').split(driver).join('<driver>');
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    }
    return value;
  };
  const sources = Object.fromEntries(Object.entries(report.sources).map(([version, source]) => {
    const { bin: _bin, ...rest } = source;
    return [version, { ...rest, root: relative(driver, source.root) || '.' }];
  }));
  return scrub({ ...report, sources });
}

function cancelled(name) {
  return Object.assign(new Error(`cancelled by ${name}`), { exitCode: SIGNAL_EXIT[name] });
}

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

// One hook process, owned: tracked for cancellation and killed at the sample timeout.
function runOwnedChild(file, args, { cwd, env, input }, active) {
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    active.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SAMPLE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (child.pid !== undefined) return;
      clearTimeout(timer);
      active.delete(child);
      done({ status: null, signal: null, stdout, stderr, error });
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      active.delete(child);
      const error = timedOut ? new Error(`hook exceeded ${SAMPLE_TIMEOUT_MS} ms`) : undefined;
      done({ status, signal, stdout, stderr, error });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function worker(specPath) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const active = new Set();
  for (const [name, code] of Object.entries(SIGNAL_EXIT)) {
    process.on(name, async () => {
      await Promise.all([...active].map((child) => new Promise((done) => {
        child.once('close', done);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      })));
      process.exit(code);
    });
  }
  process.stdout.write(`ready ${process.pid}\n`);

  const { FAMILIAR_STATE_DIR: bus } = spec.env;
  const warmups = [];
  const samples = [];
  let lastSeq = -Infinity;
  for (let n = 0; n < spec.warmups + spec.samples; n++) {
    rmSync(spec.gitLogPath, { force: true });
    const started = performance.now();
    const result = await runOwnedChild(process.execPath, [spec.wrapper, spec.measuredBin,
      'hook', 'PreToolUse', '--agent', 'claude-code'], {
      cwd: spec.projectRoot,
      env: { ...spec.env, BENCH_GIT_LOG: spec.gitLogPath },
      input: JSON.stringify({ session_id: spec.sessionId, cwd: spec.projectRoot }),
    }, active);
    const hookMs = performance.now() - started;
    assertClean(result);
    const agents = readJson(join(bus, 'agents.json'));
    const provedState = proveHook(result, agents, readJson(join(bus, 'intent.json')),
      spec.sessionId, process.pid, spec.projectRoot);
    const { seq } = agents[spec.sessionId];
    if (!(seq > lastSeq)) throw new Error(`hook left a stale record (seq ${seq} after ${lastSeq})`);
    lastSeq = seq;
    const git = readJson(spec.gitLogPath);
    if (!Array.isArray(git)) throw new Error('the wrapper recorded no Git metrics');
    (n < spec.warmups ? warmups : samples).push({ hookMs, provedState, seq, git });
  }
  writeFileSync(spec.resultPath, JSON.stringify({ complete: true, warmups, samples }));
}

const invoked = process.argv[1] !== undefined && realpathSync(process.argv[1]) === SELF;
if (invoked) {
  const isWorker = process.argv[2] === '--worker';
  try {
    if (isWorker) await worker(process.argv[3]);
    else await controller(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`bench-hook${isWorker ? ' worker' : ''}: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}
