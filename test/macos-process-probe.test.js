import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as macosProbe from '../src/bus/macos-process-probe.js';

const { captureProcessEvidence } = macosProbe;

const PS_ROWS = new Map([
  [300, {
    comm: '300 200 ?? Sun Aug 23 12:00:02 2026 /opt/familiar/bin/familiar',
    command: '300 200 ?? Sun Aug 23 12:00:02 2026 node /opt/familiar/bin/familiar hook PreToolUse',
  }],
  [200, {
    comm: '200 100 ttys003 Sun Aug 23 12:00:01 2026 /bin/zsh',
    command: '200 100 ttys003 Sun Aug 23 12:00:01 2026 /bin/zsh -c familiar hook PreToolUse; :',
  }],
  [100, {
    comm: '100 1 ttys003 Sun Aug 23 12:00:00 2026 /opt/bin/claude',
    command: '100 1 ttys003 Sun Aug 23 12:00:00 2026 claude',
  }],
  [1, {
    comm: '1 0 ?? Sun Aug 23 11:00:00 2026 /sbin/launchd',
    command: '1 0 ?? Sun Aug 23 11:00:00 2026 /sbin/launchd',
  }],
]);

test('probe writes only the hook ancestor chain with paired raw ps rows', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'familiar-macos-probe-test-'));
  const outDir = join(root, 'private');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const runPs = (args) => {
    calls.push(args);
    assert.equal(args[0], '-p', 'a machine-wide ps read would disclose unrelated processes');
    const pid = Number(args[1]);
    const field = args.at(-1).endsWith('command=') ? 'command' : 'comm';
    return `${PS_ROWS.get(pid)[field]}\n`;
  };

  const path = captureProcessEvidence({
    agent: 'claude-code',
    event: 'PreToolUse',
    hookPid: 300,
    platform: 'darwin',
    outDir,
    capturedAt: '2026-08-23T12:00:03.000Z',
    env: { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '7', SECRET_TOKEN: 'never-record' },
    runPs,
  });

  assert.equal(path, join(outDir, 'claude-code.jsonl'));
  assert.equal(statSync(outDir).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ['-p', '300'], ['-p', '300'],
    ['-p', '200'], ['-p', '200'],
    ['-p', '100'], ['-p', '100'],
    ['-p', '1'], ['-p', '1'],
  ]);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    version: 1,
    agent: 'claude-code',
    event: 'PreToolUse',
    capturedAt: '2026-08-23T12:00:03.000Z',
    hookPid: 300,
    environment: {
      TERM: true,
      TERM_PROGRAM: false,
      KITTY_WINDOW_ID: true,
      KITTY_PID: false,
      GHOSTTY_RESOURCES_DIR: false,
    },
    chain: [...PS_ROWS.entries()].map(([pid, row]) => ({
      pid,
      ppid: pid === 300 ? 200 : pid === 200 ? 100 : pid === 100 ? 1 : 0,
      comm: row.comm,
      command: row.command,
    })),
  });
});

test('execution witness records no payload and uses private permissions', (t) => {
  assert.equal(typeof macosProbe.writeExecutionWitness, 'function');
  const root = mkdtempSync(join(tmpdir(), 'familiar-macos-witness-test-'));
  const path = join(root, 'executed.jsonl');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  macosProbe.writeExecutionWitness({
    path,
    agent: 'codex',
    event: 'PreToolUse',
    capturedAt: '2026-08-23T12:00:03.000Z',
  });

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    capturedAt: '2026-08-23T12:00:03.000Z',
    agent: 'codex',
    event: 'PreToolUse',
  });
});

test('probe refuses an agent label that could escape the output directory', () => {
  assert.throws(
    () => captureProcessEvidence({ agent: '../other', event: 'Stop', runPs: () => '' }),
    /unsupported agent label/,
  );
});

test('probe refuses to run outside Darwin', () => {
  assert.throws(
    () => captureProcessEvidence({ agent: 'opencode', event: 'init', platform: 'linux' }),
    /requires Darwin/,
  );
});

test('probe rejects mismatched comm and command identities', () => {
  let call = 0;
  assert.throws(() => captureProcessEvidence({
    agent: 'codex',
    event: 'PreToolUse',
    hookPid: 300,
    platform: 'darwin',
    runPs: () => call++ === 0
      ? `${PS_ROWS.get(300).comm}\n`
      : `301 200 ?? Sun Aug 23 12:00:02 2026 node familiar hook PreToolUse\n`,
  }), /identity changed while capturing pid 300/);
});

test('probe rejects a process lifetime change between paired ps reads', () => {
  let call = 0;
  assert.throws(() => captureProcessEvidence({
    agent: 'opencode',
    event: 'session.busy',
    hookPid: 300,
    platform: 'darwin',
    runPs: () => call++ === 0
      ? `${PS_ROWS.get(300).comm}\n`
      : `300 200 ?? Sun Aug 23 12:00:03 2026 node familiar hook session.busy\n`,
  }), /identity changed while capturing pid 300/);
});
