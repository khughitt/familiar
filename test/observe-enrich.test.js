import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import nodeModule from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterFor } from 'relay';
import { EMPTY_SESSIONS } from '../src/bus/sessions.js';
import { NO_PROJECT } from '../src/bus/project-color.js';
import { prepareEnrichment, roleFromEnv } from '../src/observe/enrich.js';
import { printsPlaceholderCells, noTerminalMessage } from '../src/render/harness.js';

const { chains } = JSON.parse(readFileSync(new URL(import.meta.resolve('relay/fixtures/ancestry.json')), 'utf8'));
const handle = { platform: 'linux', host: 'host', bootId: 'boot', pid: 7, start: '123' };
const git = { remote: null, repoRoot: '/repo', repositoryRoot: '/repo' };

function fixture(name = 'interactive-codex') {
  const chain = chains.find((entry) => entry.name === name);
  const calls = [];
  const own = { ...handle, pid: chain.session };
  const row = { id: `${chain.harness}:s`, sessionId: 's', harness: chain.harness, cwd: '/repo', process: own };
  return {
    calls, row,
    args: {
      envelope: { type: 'event', registry: { generation: 'g' }, event: { agentId: row.id, sessionId: 's', harness: row.harness } },
      snapshot: { generation: 'g', agents: { [row.id]: row } },
      prior: structuredClone(EMPTY_SESSIONS), startPid: chain.rows[0].pid, adapterFor,
      relayProcess: {
        ancestors: (pid) => { calls.push(['ancestors', pid]); return chain.rows; },
        handleOf: (pid) => { calls.push(['handle', pid]); return own; },
        executableOf: (pid) => chain.rows.find((p) => p.pid === pid).exe,
        argvOf: (pid) => chain.rows.find((p) => p.pid === pid).argv,
      },
      renderProcess: { startTimeOf: (pid) => { calls.push(['starttime', pid]); return 456; } },
      gitContext: async (cwd) => { calls.push(['git', cwd]); return git; },
      lookupProjectColor: async (root) => {
        calls.push(['color', root]);
        return { prefix: 'repo', color: '#abcdef', root: '/registered', warnings: ['warning'] };
      },
      lookupFamily: async (root) => { calls.push(['family', root]); return 'guild'; },
      env: {},
    },
  };
}

test('proven event returns context and root basis for a worker', async () => {
  const { args, row, calls } = fixture();
  const worker = { ...row, id: 'codex:worker', sessionId: 'worker', root: row.id, cwd: '/wrong' };
  args.snapshot.agents[worker.id] = worker;
  args.envelope.event.agentId = worker.id;
  args.envelope.event.root = row.id;
  const result = await prepareEnrichment(args);
  assert.deepEqual(result, {
    ok: true, sessionId: 's', basis: { generation: 'g', agentId: row.id, process: row.process, cwd: row.cwd },
    terminal: { pid: 7, starttime: 456 },
    context: { ...git, cwd: '/repo', projectKey: '/repo', project: 'repo', projectColor: '#abcdef', family: 'guild', role: null }, warnings: ['warning'],
  });
  assert.ok(calls.some(([kind, pid]) => kind === 'handle' && pid === 7));
  assert.ok(calls.some(([kind, cwd]) => kind === 'git' && cwd === row.cwd));
});

test('relay ancestry fixtures keep session proof separate from the rendered terminal', async () => {
  for (const name of ['background-daemon-under-interactive', 'nested-headless-claude', 'darwin-codex', 'darwin-opencode']) {
    const { args, calls } = fixture(name);
    const chain = chains.find((entry) => entry.name === name);
    const result = await prepareEnrichment(args);
    assert.equal(result.ok, true, name);
    assert.equal(result.basis.process.pid, chain.session, name);
    assert.equal(result.terminal.pid, chain.terminal, name);
    assert.ok(calls.some(([kind, pid]) => kind === 'handle' && pid === chain.session), name);
  }
});

test('absence is not an error and runs no process or git work', async () => {
  for (const missing of ['snapshot', 'agent', 'root']) {
    const { args, row, calls } = fixture();
    if (missing === 'snapshot') args.snapshot = null;
    if (missing === 'agent') args.snapshot.agents = {};
    if (missing === 'root') row.root = 'codex:missing';
    const result = await prepareEnrichment(args);
    assert.equal(result.ok, false);
    assert.equal(result.absent, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, 'no registry row for this session');
    assert.deepEqual(calls, []);
  }
});

test('obsolete generation is ignored before process or git work', async () => {
  const { args, calls } = fixture();
  args.envelope.registry.generation = 'old';
  assert.deepEqual(await prepareEnrichment(args), { ok: false, sessionId: 's', exitCode: 0, reason: 'obsolete envelope' });
  assert.deepEqual(calls, []);
});

test('stall before the first read cannot decorate the newer process', async () => {
  for (const [field, value] of Object.entries({ platform: 'darwin', host: 'other', bootId: 'other', pid: 8, start: '124' })) {
    const { args, row, calls } = fixture();
    row.process = { ...row.process, [field]: value };
    assert.deepEqual(await prepareEnrichment(args), { ok: false, sessionId: 's', exitCode: 0, reason: 'a newer process owns this session' });
    assert.equal(calls.some(([kind]) => ['git', 'starttime', 'color'].includes(kind)), false);
  }
});

test('null, unreadable, or unresolved ownership is an error before git', async () => {
  for (const failure of ['row', 'handle-null', 'handle-throw', 'resolve-null', 'resolve-throw']) {
    const { args, row, calls } = fixture();
    if (failure === 'row') row.process = null;
    if (failure === 'handle-null') args.relayProcess.handleOf = () => null;
    if (failure === 'handle-throw') args.relayProcess.handleOf = () => { throw Object.assign(new Error('unreadable'), { code: 'PROCESS_UNREADABLE' }); };
    if (failure === 'resolve-null') args.relayProcess.ancestors = () => [];
    if (failure === 'resolve-throw') args.relayProcess.ancestors = () => { throw new Error('unreadable'); };
    assert.deepEqual(await prepareEnrichment(args), { ok: false, sessionId: 's', exitCode: 1, reason: 'ownership unproven' });
    assert.equal(calls.some(([kind]) => kind === 'git'), false);
  }
});

test('no terminal preserves the Codex daemon hint and does no git work', async () => {
  const { args, calls } = fixture('headless-codex-exec');
  const result = await prepareEnrichment(args);
  assert.equal(result.exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'the codex process 890 owns no terminal: Codex 0.160+ runs hooks under its shared app-server daemon, where no session can be tied to its terminal -- launch it with `codex --no-daemon`. Chain: 900(node) -> 890(codex) -> 880(timeout)');
  assert.equal(calls.some(([kind]) => kind === 'git'), false);
});

test('unreadable terminal stamp fails before git', async () => {
  const { args, calls } = fixture();
  args.renderProcess.startTimeOf = () => null;
  const result = await prepareEnrichment(args);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /could not read the start time/);
  assert.equal(calls.some(([kind]) => kind === 'git'), false);
});

test('git runs per event in an unchanged cwd and ignores relay identity', async () => {
  const { args, row } = fixture();
  row.projectKey = 'wrong'; row.remote = 'wrong';
  const answers = [{ remote: null, repoRoot: null, repositoryRoot: null }, { ...git, remote: 'github.com/me/repo' }];
  args.gitContext = async () => answers.shift();
  const first = await prepareEnrichment(args);
  const second = await prepareEnrichment(args);
  assert.equal(first.context.projectKey, '/repo');
  assert.equal(first.context.projectColor, null);
  assert.deepEqual(first.warnings, NO_PROJECT.warnings);
  assert.equal(second.context.projectKey, 'github.com/me/repo');
});

test('project color carries for the same repoRoot, including null colors, and refreshes on change', async () => {
  for (const color of ['#123456', null]) {
    const { args, calls } = fixture();
    args.prior.sessions.s = { repoRoot: '/repo', projectColor: color, family: null };
    assert.equal((await prepareEnrichment(args)).context.projectColor, color);
    assert.equal(calls.some(([kind]) => kind === 'color'), false);
    args.gitContext = async () => ({ ...git, repoRoot: '/other' });
    assert.equal((await prepareEnrichment(args)).context.projectColor, '#abcdef');
    assert.ok(calls.some(([kind, root]) => kind === 'color' && root === '/other'));
  }
});

test('project colour and family carry together for the same repoRoot, and are looked up together otherwise', async () => {
  for (const [color, family] of [['#123456', 'verifiably'], [null, null], ['#123456', null]]) {
    const { args, calls } = fixture();
    args.prior.sessions.s = { repoRoot: '/repo', projectColor: color, family };
    const carried = await prepareEnrichment(args);
    assert.deepEqual([carried.context.projectColor, carried.context.family], [color, family]);
    assert.deepEqual(carried.warnings, []);
    assert.deepEqual(calls.filter(([kind]) => ['color', 'family'].includes(kind)), []);
  }
  const { args, calls } = fixture();
  let prior = { sessions: {} };
  for (const repoRoot of ['/api', '/api', '/web', '/web']) {
    args.prior = prior;
    args.gitContext = async () => ({ ...git, repoRoot });
    args.lookupProjectColor = async (root) => {
      calls.push(['color', root]);
      return { prefix: 'p', color: '#abcdef', root: `/registered${root}`, warnings: [] };
    };
    args.lookupFamily = async (root) => { calls.push(['family', root]); return root.endsWith('api') ? 'guild' : 'verifiably'; };
    prior = { sessions: { s: (await prepareEnrichment(args)).context } };
  }
  assert.deepEqual(calls.filter(([kind]) => ['color', 'family'].includes(kind)), [
    ['color', '/api'], ['family', '/registered/api'], ['color', '/web'], ['family', '/registered/web'],
  ]);
  assert.equal(prior.sessions.s.family, 'verifiably');
});

// A record written before the family existed carries a colour but no family: it is not
// half-carried. Its next hook looks both up, once each, and the record then owns both.
test('a prior record with a colour but no own family looks up colour and family once each', async () => {
  for (const old of [
    { repoRoot: '/repo', projectColor: '#123456' },
    Object.assign(Object.create({ family: 'guild' }), { repoRoot: '/repo', projectColor: '#123456' }),
  ]) {
    const { args, calls } = fixture();
    args.prior.sessions.s = old;
    const result = await prepareEnrichment(args);
    assert.deepEqual(calls.filter(([kind]) => ['color', 'family'].includes(kind)), [['color', '/repo'], ['family', '/registered']]);
    assert.deepEqual([result.context.projectColor, result.context.family], ['#abcdef', 'guild']);
    assert.deepEqual(result.warnings, ['warning']);
  }
});

// No registered root (unregistered, or tasks absent) means no family and no file read;
// no checkout means neither lookup runs.
test('a null registered root or a null repoRoot gives a null family without reading a family file', async () => {
  const { args, calls } = fixture();
  args.lookupProjectColor = async (root) => { calls.push(['color', root]); return NO_PROJECT; };
  const unregistered = await prepareEnrichment(args);
  assert.deepEqual([unregistered.context.projectColor, unregistered.context.family], [null, null]);
  assert.deepEqual(calls.filter(([kind]) => ['color', 'family'].includes(kind)), [['color', '/repo']]);

  const outside = fixture();
  outside.args.gitContext = async () => ({ remote: null, repoRoot: null, repositoryRoot: null });
  const result = await prepareEnrichment(outside.args);
  assert.deepEqual([result.context.projectColor, result.context.family], [null, null]);
  assert.deepEqual(outside.calls.filter(([kind]) => ['color', 'family'].includes(kind)), []);
});

test('FAMILIAR_ROLE: unset or empty is no role; an id is the role; anything else is refused by name', () => {
  assert.equal(roleFromEnv({}), null);
  assert.equal(roleFromEnv({ FAMILIAR_ROLE: '' }), null);
  assert.equal(roleFromEnv({ FAMILIAR_ROLE: 'reviewer' }), 'reviewer');
  assert.equal(roleFromEnv({ FAMILIAR_ROLE: 'lead-2' }), 'lead-2');
  for (const value of ['Reviewer', 'reviewer/lead', ' reviewer', 'reviewer-', 'a--b']) {
    assert.throws(() => roleFromEnv({ FAMILIAR_ROLE: value }), {
      message: `FAMILIAR_ROLE ${JSON.stringify(value)} is invalid — ids may only contain lowercase letters, `
        + 'digits, and hyphens (e.g. "reviewer")',
    });
  }
  assert.throws(() => roleFromEnv({ FAMILIAR_ROLE: 'default' }), {
    message: 'FAMILIAR_ROLE "default" is reserved for an agent with no role — unset FAMILIAR_ROLE instead',
  });
});

test('enrichment puts the hook environment\'s role on the record and refuses an invalid one before any work', async () => {
  for (const [env, role] of [[{ FAMILIAR_ROLE: 'reviewer' }, 'reviewer'], [{}, null], [{ FAMILIAR_ROLE: '' }, null]]) {
    const { args } = fixture();
    args.env = env;
    assert.equal((await prepareEnrichment(args)).context.role, role);
  }
  for (const value of ['Reviewer', 'reviewer/lead', 'default']) {
    const { args, calls } = fixture();
    args.env = { FAMILIAR_ROLE: value };
    let message;
    try { roleFromEnv(args.env); } catch (error) { ({ message } = error); }
    assert.deepEqual(await prepareEnrichment(args), { ok: false, sessionId: 's', exitCode: 0, reason: message });
    assert.deepEqual(calls, []);
  }
});

// The family file's TOML parser loads only once a family file is found, so a hook for a
// root without one (most checkouts) never pays for it. The control proves the trace sees
// the parser when a file is read, so the absence is meaningful.
const traceHook = fileURLToPath(new URL('fixtures/trace-imports.mjs', import.meta.url));
const enrichUrl = new URL('../src/observe/enrich.js', import.meta.url).href;
const enrichScript = `
const { prepareEnrichment } = await import(${JSON.stringify(enrichUrl)});
const own = { platform: 'linux', host: 'host', bootId: 'boot', pid: 7, start: '1' };
const row = { id: 'codex:s', sessionId: 's', harness: 'codex', cwd: '/repo', process: own };
const result = await prepareEnrichment({
  envelope: { type: 'event', registry: { generation: 'g' }, event: { agentId: row.id, harness: 'codex' } },
  snapshot: { generation: 'g', agents: { [row.id]: row } }, prior: { sessions: {} },
  relayProcess: { ancestors: () => [], executableOf: () => null, argvOf: () => [], handleOf: () => own },
  renderProcess: { startTimeOf: () => 1 },
  adapterFor: () => ({ resolveSessionPid: () => 7, resolveTerminalPid: () => 7 }),
  gitContext: async () => ({ remote: null, repoRoot: '/repo', repositoryRoot: '/repo' }),
  lookupProjectColor: async () => ({ prefix: 'p', color: null, root: process.env.FAMILY_ROOT, warnings: [] }),
  env: {},
});
process.stdout.write(JSON.stringify(result.context.family));
`;
test('enriching for a root without a family file never loads the TOML parser', {
  skip: typeof nodeModule.registerHooks !== 'function' ? 'module.registerHooks needs Node 22.15 or later' : false,
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-enrich-trace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const traced = (root) => {
    const trace = join(dir, 'trace.txt');
    writeFileSync(trace, '');
    const result = spawnSync(process.execPath, ['--import', traceHook, '--input-type=module', '-e', enrichScript], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, FAMILIAR_TRACE_IMPORTS: trace, FAMILY_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr);
    const loaded = readFileSync(trace, 'utf8').split('\n').filter(Boolean);
    assert.ok(loaded.some((url) => url.endsWith('/src/bus/family.js')), 'the trace saw the family read');
    return { family: JSON.parse(result.stdout), toml: loaded.some((url) => url.includes('/node_modules/smol-toml/')) };
  };
  const bare = join(dir, 'bare');
  mkdirSync(bare);
  assert.deepEqual(traced(bare), { family: null, toml: false });
  const guild = join(dir, 'guild');
  mkdirSync(join(guild, 'tools'), { recursive: true });
  writeFileSync(join(guild, 'tools', 'family.toml'), 'name = "guild"\n');
  assert.deepEqual(traced(guild), { family: 'guild', toml: true });
});

test('git and project color faults remain explicit', async () => {
  for (const dependency of ['gitContext', 'lookupProjectColor', 'lookupFamily']) {
    const { args } = fixture();
    args[dependency] = async () => { throw new Error(`${dependency} failed`); };
    await assert.rejects(prepareEnrichment(args), { message: `${dependency} failed` });
  }
});

test('harness presentation policy is explicit and terminal messages show ancestry', () => {
  for (const [harness, prints] of [['claude-code', true], ['codex', false], ['opencode', false]]) {
    assert.equal(printsPlaceholderCells(harness), prints);
    assert.equal(noTerminalMessage(harness, [{ pid: 1, comm: 'node', tty: null }]), `could not find the ${harness} process with a terminal among the ancestors: 1(node)`);
  }
  assert.throws(() => printsPlaceholderCells('other'), /unknown harness/);
});
