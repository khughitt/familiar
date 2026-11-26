import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { spawnAll } from './helpers/spawn-all.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8'));
const script = workflow.jobs.macos.steps.find((step) => step.name === 'linked command smoke').run;

test('the macOS linked-command smoke accepts the current setup documents', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-linked-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  symlinkSync(join(ROOT, 'bin/familiar'), join(bin, 'familiar'));
  // Linking is represented by the fixture symlink; npm must never alter host links.
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = link ] || exit 64\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: home, encoding: 'utf8', timeout: 15_000,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
      FAMILIAR_STATE_DIR: join(root, 'state'), FAMILIAR_CONFIG_DIR: join(root, 'config'),
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test('the macOS linked-command smoke rejects stale or malformed setup outputs and names the failing check', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-linked-smoke-cases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = link ] || exit 64\n');
  chmodSync(join(bin, 'npm'), 0o755);
  writeFileSync(join(bin, 'familiar'), [
    '#!/bin/sh',
    'case "$*" in',
    '  --help) printf "familiar help\\n" ;;',
    '  "setup claude-code") printf "%s\\n" "$CLAUDE_OUT" ;;',
    '  "setup relay") printf "%s\\n" "$RELAY_OUT" ;;',
    '  "setup codex") exit "$CODEX_EXIT" ;;',
    '  *) exit 64 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'familiar'), 0o755);

  const validClaude = JSON.stringify({
    statusLine: { type: 'command', command: "'/opt/familiar/bin/familiar' statusline", refreshInterval: 2 },
  });
  const makeRelay = (overrides = {}, subscriberPatch = {}) => JSON.stringify({
    schema: 2,
    subscribers: ['familiar', 'familiar-codex-workers', 'familiar-teardown'].map((name) => ({
      name, role: 'observer', registry: 'snapshot', argv: ['familiar', 'observe'], ...subscriberPatch,
    })),
    ...overrides,
  });
  const cases = [
    { name: 'valid', claude: validClaude, relay: makeRelay(), codex: '2', ok: true },
    {
      name: 'unlinked claude command',
      claude: JSON.stringify({ statusLine: { type: 'command', command: 'familiar statusline', refreshInterval: 2 } }),
      relay: makeRelay(), codex: '2', stderr: /setup claude-code check failed/,
    },
    {
      name: 'stale schema 1',
      claude: validClaude,
      relay: JSON.stringify({
        schema: 1,
        subscribers: ['familiar', 'familiar-opencode', 'familiar-teardown', 'familiar-teardown-codex'].map((name) => ({
          name, role: 'observer', argv: ['/opt/familiar/bin/familiar', 'observe'],
        })),
      }),
      codex: '2', stderr: /setup relay check failed/,
    },
    {
      name: 'extra top-level key',
      claude: validClaude, relay: makeRelay({ extra: true }), codex: '2', stderr: /setup relay check failed/,
    },
    {
      name: 'wrong subscriber names',
      claude: validClaude,
      relay: JSON.stringify({
        schema: 2,
        subscribers: ['familiar', 'familiar-teardown'].map((name) => ({
          name, role: 'observer', registry: 'snapshot', argv: ['familiar', 'observe'],
        })),
      }),
      codex: '2', stderr: /setup relay check failed/,
    },
    {
      name: 'missing snapshot registry',
      claude: validClaude, relay: makeRelay({}, { registry: undefined }), codex: '2', stderr: /setup relay check failed/,
    },
    {
      name: 'path-valued argv[0]',
      claude: validClaude,
      relay: makeRelay({}, { argv: ['/opt/familiar/bin/familiar', 'observe'] }),
      codex: '2', stderr: /setup relay check failed/,
    },
    { name: 'setup codex exits 0', claude: validClaude, relay: makeRelay(), codex: '0' },
  ];

  const results = await spawnAll(cases.map((entry) => ({
    command: '/bin/bash',
    args: ['-e', '-o', 'pipefail', '-c', `cd "$HOME"\n${script}`],
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
      CLAUDE_OUT: entry.claude, RELAY_OUT: entry.relay, CODEX_EXIT: entry.codex,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  })));

  for (let i = 0; i < cases.length; i++) {
    const entry = cases[i];
    const result = results[i];
    assert.equal(result.error, undefined, entry.name);
    if (entry.ok) {
      assert.equal(result.status, 0, `${entry.name}: ${result.stderr}\n${result.stdout}`);
      assert.equal(result.stderr, '', entry.name);
    } else {
      assert.notEqual(result.status, 0, `${entry.name} unexpectedly passed`);
      if (entry.stderr) assert.match(result.stderr, entry.stderr, entry.name);
    }
  }
});
