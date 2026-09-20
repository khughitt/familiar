// familiar's declared command table equals its rows in tools/cli.toml, and the binary
// behaves as the CLI vocabulary requires (ops docs/specs/2026-09-20-cli-conventions-design.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../src/commands.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'familiar');
const key = (row) => JSON.stringify(row);
const normalize = (names) => [...names.filter((n) => n.startsWith('--')), ...names.filter((n) => !n.startsWith('--'))];

function liveRows() {
  const rows = new Set();
  for (const cmd of COMMANDS) {
    rows.add(key(['command', cmd.path, cmd.summary]));
    (cmd.args ?? []).forEach((a, i) => rows.add(key(['arg', cmd.path, i, a.name, a.value, a.values ?? [], a.required, a.variadic ?? false])));
    for (const o of cmd.options ?? []) {
      const flag = o.value === 'none';
      rows.add(key(['option', cmd.path, normalize(o.names), o.value, o.values ?? [], flag ? (o.default === 'true' ? 'true' : null) : (o.default ?? null), flag ? null : (o.arity ?? '1'), o.repeatable ?? false, o.required ?? false]));
    }
  }
  return rows;
}

function tableRows() {
  const text = execFileSync('python3', [path.join(ROOT, 'tools', 'cli_surface.py'), 'rows', 'familiar', path.join(ROOT, 'tools', 'cli.toml')], { encoding: 'utf8' });
  return new Set(text.trim().split('\n').map((line) => key(JSON.parse(line))));
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'familiar-cli-'));
const base = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state') };
const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...base, ...env } });

test('declared surface equals tools/cli.toml', () => {
  const live = liveRows(), table = tableRows();
  assert.deepEqual({ parserOnly: [...live].filter((r) => !table.has(r)), tableOnly: [...table].filter((r) => !live.has(r)) }, { parserOnly: [], tableOnly: [] });
});

test('help on root and every command, families and protocol commands included', () => {
  for (const cmd of [{ path: [] }, ...COMMANDS]) {
    for (const flag of ['--help', '-h']) {
      const r = run([...cmd.path, flag]);
      assert.deepEqual({ path: cmd.path, flag, status: r.status, err: r.stderr, empty: r.stdout === '' }, { path: cmd.path, flag, status: 0, err: '', empty: false });
    }
    if (cmd.path.length) assert.equal(run(['help', ...cmd.path]).stdout, run([...cmd.path, '--help']).stdout);
  }
});

test('version', () => {
  for (const flag of ['--version', '-V']) { const r = run([flag]); assert.equal(r.status, 0); assert.match(r.stdout, /^familiar \d/); }
});

test('usage errors exit 2 with stderr only', () => {
  for (const args of [['bogus'], ['theme', 'bogus'], ['whoami', '--bogus'], ['theme', 'add'], ['help', 'bogus'], ['--json', 'theme', 'list', '--pretty']]) {
    const r = run(args);
    assert.deepEqual({ args, status: r.status, out: r.stdout }, { args, status: 2, out: '' });
    assert.ok(r.stderr.trim().split('\n').length <= 2, r.stderr);
  }
});

test('enum baselines cover every enum row', () => {
  const baselines = [[['scheme', 'set'], 'scheme', ['scheme', 'set', 'dark']]];
  const table = [...tableRows()].map((r) => JSON.parse(r)).filter((r) => (r[0] === 'arg' && r[4] === 'enum') || (r[0] === 'option' && r[3] === 'enum')).map((r) => `${r[1].join(' ')} ${r[0] === 'arg' ? r[3] : r[2][0]}`).sort();
  assert.deepEqual(baselines.map(([p, b]) => `${p.join(' ')} ${b}`).sort(), table, 'every enum row needs a baseline');
  for (const [path, binding, argv] of baselines) {
    assert.equal(run(argv).status, 0, argv.join(' '));
    const bad = [...argv]; bad[path.length] = '__not_in_set__';
    const r = run(bad);
    assert.equal(r.status, 2); assert.ok(r.stderr.includes(binding) && r.stderr.includes('__not_in_set__'), r.stderr);
  }
});

test('global routing, output precedence, json failure', () => {
  for (const args of [['--json', 'theme', 'list'], ['theme', 'list', '--json']]) assert.equal(typeof JSON.parse(run(args).stdout), 'object', args);
  for (const args of [['--pretty', 'theme', 'list'], ['theme', 'list', '--pretty'], ['theme', 'list']]) assert.throws(() => JSON.parse(run(args).stdout), args.join(' '));
  assert.equal(typeof JSON.parse(run(['theme', 'list'], { FAMILIAR_FORMAT: 'json' }).stdout), 'object');
  assert.throws(() => JSON.parse(run(['--pretty', 'theme', 'list'], { FAMILIAR_FORMAT: 'json' }).stdout));
  const r = run(['--json', 'theme', 'show', 'no-such-theme']);
  assert.equal(r.status, 1); assert.equal(r.stdout, '');
  const err = JSON.parse(r.stderr).error;
  assert.equal(typeof err.kind, 'string'); assert.equal(typeof err.detail, 'string');
});

test('color', () => {
  assert.equal(run(['--color', 'never', 'theme', 'list']).status, 0);
  assert.equal(run(['theme', 'list', '--color', 'never']).status, 0);
  assert.equal(run(['--color', 'sometimes', 'theme', 'list']).status, 2);
  assert.equal(run(['theme', 'list'], { FAMILIAR_COLOR: 'always' }).status, 0);
});

test('completion callback and scripts', () => {
  const candidates = (words, index) => run(['--', ...words], { FAMILIAR_COMPLETE: 'zsh', FAMILIAR_COMPLETE_INDEX: String(index) }).stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
  const root = candidates(['familiar', ''], 1);
  for (const cmd of COMMANDS) if (cmd.path.length === 1) assert.ok(root.includes(cmd.path[0]), cmd.path[0]);
  assert.ok(candidates(['familiar', 'theme', ''], 2).includes('preview'));
  assert.ok(candidates(['familiar', 'projects', '--'], 2).includes('--rows'));
  assert.deepEqual(candidates(['familiar', 'scheme', 'set', ''], 3).sort(), ['dark', 'light']);
  assert.deepEqual(candidates(['familiar', 'th'], 1), ['theme']);
  assert.deepEqual(candidates(['familiar', '--json', 'scheme', 'set', 'd'], 4), ['dark']);
  const zsh = path.join(home, '_familiar'); fs.writeFileSync(zsh, run([], { FAMILIAR_COMPLETE: 'zsh' }).stdout);
  assert.equal(execFileSync('zsh', ['-f', '-c', `autoload -Uz compinit; compinit -D -u; source ${zsh}; print -r -- \${_comps[familiar]}`], { encoding: 'utf8' }).trim(), '_familiar');
  const bash = path.join(home, 'familiar.bash'); fs.writeFileSync(bash, run([], { FAMILIAR_COMPLETE: 'bash' }).stdout);
  execFileSync('bash', ['-c', `source ${bash}; complete -p familiar`]);
});
