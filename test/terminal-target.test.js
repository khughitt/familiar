import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalTarget } from '../src/render/term/target.js';

test('Linux binds path and environment to the agent pid', () => {
  const reads = [];
  assert.deepEqual(terminalTarget(42, {
    platform: 'linux',
    probe: () => null,
    readEnviron: (...args) => {
      reads.push(args);
      return 'TERM=xterm-kitty\0A=x=y\0';
    },
  }), {
    path: '/proc/42/fd/1',
    env: { TERM: 'xterm-kitty', A: 'x=y' },
    tmux: null,
  });
  assert.deepEqual(reads, [['/proc/42/environ', 'utf8']]);
});

test('Darwin combines validated agent tty with hook environment', () => {
  const hookEnv = { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' };
  assert.deepEqual(terminalTarget(42, {
    platform: 'darwin', record: { pid: 42, tty: 'ttys003' }, hookEnv, probe: () => null,
  }), { path: '/dev/ttys003', env: hookEnv, tmux: null });
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
  }), { path: '/proc/42/fd/1', env: undefined, tmux: undefined });
});

test('unsupported platforms fail explicitly', () => {
  assert.throws(
    () => terminalTarget(42, { platform: 'win32' }),
    /terminal target: unsupported platform "win32"/,
  );
});

test('the probe runs against the AGENT environment and rides on the target', () => {
  const probed = [];
  const facts = { ok: true, passthrough: 'all', termname: 'xterm-kitty', termtype: 'kitty(0.48.2)', client: { tty: '/dev/pts/1', pid: 1, created: 1 } };
  const target = terminalTarget(42, {
    platform: 'linux',
    readEnviron: () => 'TERM=tmux-256color\0TMUX=/tmp/s,1,0\0TMUX_PANE=%0\0',
    probe: (env) => { probed.push(env); return facts; },
  });
  assert.deepEqual(probed, [{ TERM: 'tmux-256color', TMUX: '/tmp/s,1,0', TMUX_PANE: '%0' }]);
  assert.equal(target.tmux, facts);
});

test('an unreadable environ leaves both env and tmux undefined — tint and bell need neither', () => {
  let probed = 0;
  const target = terminalTarget(42, {
    platform: 'linux',
    readEnviron: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    probe: () => { probed += 1; return null; },
  });
  assert.deepEqual(target, { path: '/proc/42/fd/1', env: undefined, tmux: undefined });
  assert.equal(probed, 0);
});

test('Darwin probes the hook environment, which the agent shares', () => {
  const hookEnv = { TERM: 'tmux-256color', TMUX: '/private/tmp/s,1,0', TMUX_PANE: '%2' };
  const facts = { ok: false, reason: 'no-client' };
  const target = terminalTarget(42, { platform: 'darwin', record: { pid: 42, tty: 'ttys003' }, hookEnv, probe: (env) => (env === hookEnv ? facts : null) });
  assert.deepEqual(target, { path: '/dev/ttys003', env: hookEnv, tmux: facts });
});
