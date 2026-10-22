import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adapterFor } from 'relay';
import { EMPTY_SESSIONS } from '../src/bus/sessions.js';
import { NO_PROJECT } from '../src/bus/project-color.js';
import { prepareEnrichment } from '../src/observe/enrich.js';
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
      lookupProjectColor: async (root) => { calls.push(['color', root]); return { color: '#abcdef', warnings: ['warning'] }; },
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
    context: { ...git, cwd: '/repo', projectKey: '/repo', project: 'repo', projectColor: '#abcdef' }, warnings: ['warning'],
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
    args.prior.sessions.s = { repoRoot: '/repo', projectColor: color };
    assert.equal((await prepareEnrichment(args)).context.projectColor, color);
    assert.equal(calls.some(([kind]) => kind === 'color'), false);
    args.gitContext = async () => ({ ...git, repoRoot: '/other' });
    assert.equal((await prepareEnrichment(args)).context.projectColor, '#abcdef');
    assert.ok(calls.some(([kind, root]) => kind === 'color' && root === '/other'));
  }
});

test('git and project color faults remain explicit', async () => {
  for (const dependency of ['gitContext', 'lookupProjectColor']) {
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
