import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalTarget } from '../src/render/term/target.js';

test('Linux binds path and environment to the agent pid', () => {
  const reads = [];
  assert.deepEqual(terminalTarget(42, {
    platform: 'linux',
    readEnviron: (...args) => {
      reads.push(args);
      return 'TERM=xterm-kitty\0A=x=y\0';
    },
  }), {
    path: '/proc/42/fd/1',
    env: { TERM: 'xterm-kitty', A: 'x=y' },
  });
  assert.deepEqual(reads, [['/proc/42/environ', 'utf8']]);
});

test('Darwin combines validated agent tty with hook environment', () => {
  const hookEnv = { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' };
  assert.deepEqual(terminalTarget(42, {
    platform: 'darwin', record: { pid: 42, tty: 'ttys003' }, hookEnv,
  }), { path: '/dev/ttys003', env: hookEnv });
});

test('Darwin refuses missing and noncanonical tty records', () => {
  for (const tty of [null, true, 's003', '../ttys003']) {
    assert.throws(() => terminalTarget(42, {
      platform: 'darwin', record: { pid: 42, tty }, hookEnv: {},
    }), /validated Darwin tty/);
  }
});

test('unreadable Linux environ degrades graphics only', () => {
  assert.deepEqual(terminalTarget(42, {
    platform: 'linux', readEnviron: () => { throw new Error('gone'); },
  }), { path: '/proc/42/fd/1', env: undefined });
});

test('unsupported platforms fail explicitly', () => {
  assert.throws(
    () => terminalTarget(42, { platform: 'win32' }),
    /terminal target: unsupported platform "win32"/,
  );
});
