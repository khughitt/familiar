import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tmuxFacts, wrapForTmux, transportFor, describeTmux, TMUX_PROBE_TIMEOUT_MS,
} from '../src/render/term/tmux.js';

const TMUX_ENV = { TMUX: '/tmp/tmux-1000/default,4242,0', TMUX_PANE: '%3' };
const LINE = 'all\txterm-kitty\tkitty(0.48.2)\t/dev/pts/16\t9001\t1758200000\n';

test('no TMUX in the environment: the probe is null and nothing is spawned', () => {
  let spawned = 0;
  assert.equal(tmuxFacts({ TERM: 'xterm-kitty' }, { exec: () => { spawned += 1; return LINE; } }), null);
  assert.equal(spawned, 0);
});

test('the probe refuses an implicit environment', () => {
  assert.throws(() => tmuxFacts(), TypeError);
});

test('the probe asks the socket named by $TMUX about the pane named by $TMUX_PANE', () => {
  const calls = [];
  const facts = tmuxFacts(TMUX_ENV, { exec: (file, args, options) => { calls.push({ file, args, options }); return LINE; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'tmux');
  assert.deepEqual(calls[0].args.slice(0, 5), ['-S', '/tmp/tmux-1000/default', 'display-message', '-p', '-t']);
  assert.equal(calls[0].args[5], '%3');
  assert.equal(calls[0].args[6], '#{allow-passthrough}\t#{client_termname}\t#{client_termtype}\t#{client_tty}\t#{client_pid}\t#{client_created}');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(calls[0].options.timeout, TMUX_PROBE_TIMEOUT_MS);
  assert.deepEqual(facts, {
    ok: true, passthrough: 'all', termname: 'xterm-kitty', termtype: 'kitty(0.48.2)',
    client: { tty: '/dev/pts/16', pid: 9001, created: 1758200000 },
  });
  assert.ok(Object.isFrozen(facts) && Object.isFrozen(facts.client));
});

test('each operational failure is a reason, never a throw', () => {
  const enoent = Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' });
  const timedOut = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  const exit = Object.assign(new Error('no server running'), { status: 1 });
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => { throw enoent; } }), { ok: false, reason: 'no-binary' });
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => { throw timedOut; } }), { ok: false, reason: 'timeout' });
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => { throw exit; } }), { ok: false, reason: 'exit' });
  assert.deepEqual(tmuxFacts({ TMUX: TMUX_ENV.TMUX }, { exec: () => LINE }), { ok: false, reason: 'no-pane' });
  // A detached server answers with empty client fields (measured 2026-09-18).
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => 'all\t\t\t\t\t\n' }), { ok: false, reason: 'no-client' });
  // Garbage from the server is an exit failure, not a crash in the hook.
  assert.deepEqual(tmuxFacts(TMUX_ENV, { exec: () => 'maybe\txterm-kitty\tkitty\t/dev/pts/1\tx\ty\n' }), { ok: false, reason: 'exit' });
});

test('wrapForTmux frames the escapes in DCS passthrough and doubles every ESC, preserving the type', () => {
  const apc = '\x1b_Ga=T,q=2;AAAA\x1b\\';
  const wrapped = wrapForTmux(apc);
  assert.equal(wrapped, '\x1bPtmux;\x1b\x1b_Ga=T,q=2;AAAA\x1b\x1b\\\x1b\\');
  const asBuffer = wrapForTmux(Buffer.from(apc));
  assert.ok(Buffer.isBuffer(asBuffer));
  assert.equal(asBuffer.toString('latin1'), wrapped);
  // 9 bytes of framing plus one per ESC: the overhead the spec states (§3.3).
  assert.equal(wrapped.length, apc.length + 9 + 2);
});

test('transportFor names an incarnation of the attached client, not a pathname', () => {
  assert.equal(transportFor(null), 'direct');
  assert.equal(transportFor({ ok: false, reason: 'no-client' }), 'direct');
  assert.equal(transportFor(tmuxFacts(TMUX_ENV, { exec: () => LINE })), 'tmux:/dev/pts/16:9001:1758200000');
});

test('describeTmux explains a refusal in the words of the setting', () => {
  assert.equal(describeTmux(null), '');
  assert.equal(describeTmux({ ok: false, reason: 'no-client' }), ' — tmux probe: no-client');
  assert.equal(describeTmux({ ...tmuxFacts(TMUX_ENV, { exec: () => LINE }), passthrough: 'on' }), ' — tmux allow-passthrough=on, needs all');
  assert.equal(describeTmux(tmuxFacts(TMUX_ENV, { exec: () => LINE.replace('xterm-kitty', 'xterm-256color').replace('kitty(0.48.2)', 'foot(1.0)') })), ' — tmux client xterm-256color (foot(1.0)) is not a terminal familiar can draw on');
});
