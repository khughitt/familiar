import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit } from '../src/render/term/emit.js';
import { withTerminal } from '../src/render/term/terminal-owner.js';
import { withLock } from '../src/bus/lock.js';
import { fileLedger, ledgerPaths, transmitLockOptions } from '../src/render/term/ledger.js';
import { identityColors } from '../src/theme/ramp.js';
import { encodeRgba } from 'familiar-theme';

const COLOR = identityColors({ slot: 6, projectColor: null }, { mode: 'dark', satScale: 1 });
const PNG = encodeRgba({ w: 200, h: 400, buf: new Uint8Array(200 * 400 * 4) });
const intentAt = (state) => ({
  sessionId: 's1', pid: 4242,
  identity: { projectKey: 'k', project: 'api', slot: 6, projectColor: null, source: 'auto', member: 'm', label: 'M' },
  state, urgency: 'none', motion: 'pulse', motionPolicy: 'full', animation: { kind: 'static' },
  color: COLOR, sprite: { terminal: '/c/x.png', rows: 8 },
});

test('two concurrent sections for one session serialize under the real lock and agree with the terminal', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'section-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { entryPath, lockPath } = ledgerPaths(join(dir, 'transmit'), 's1');
  const ledger = fileLedger(entryPath);
  const lock = (fn) => withLock(lockPath, fn, transmitLockOptions({ ownerAlive: () => true, startTimeOf: () => 1 }));
  const terminal = { path: '/dev/null', env: { TERM: 'xterm-kitty' }, tmux: null };
  const painted = [];
  let inside = 0;
  let overlap = 0;
  const run = (seq, state) => emit({
    prev: { sessionId: 's1', projectColor: null, state: 'idle', pid: 4242, starttime: 1 },
    next: { sessionId: 's1', projectColor: null, state, pid: 4242, starttime: 1 },
    intent: intentAt(state), seq, terminal, ledger, lock, ownerAlive: () => true,
    readSprite: () => PNG, readFrame: () => PNG,
    open: () => { inside += 1; if (inside > 1) overlap += 1; return 7; },
    write: (_fd, bytes, offset, length) => {
      if (bytes.subarray(offset, offset + length).includes('_G')) painted.push({ seq, state });
      return length;
    },
    close: () => { inside -= 1; },
    checkTty: () => true,
  });
  const [a, b] = await Promise.all([run(1, 'working'), run(2, 'needs-input')]);
  assert.equal(overlap, 0, 'the fd was never open in two sections at once');
  assert.equal(inside, 0, 'every fd was closed');
  const entry = await ledger.read();
  assert.equal(entry.seq, 2);
  assert.equal(entry.held.intent.state, 'needs-input');
  assert.equal(painted.at(-1).state, 'needs-input');
  assert.ok(['transmitted', 'superseded'].includes(a.kind));
  assert.equal(b.kind, 'transmitted');
});

test("a captured reset paused across another session's paint writes nothing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'section-terminal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const transmitDir = join(dir, 'transmit');
  const terminal = { pid: 4242, starttime: 1 };
  const lockOptions = transmitLockOptions({ ownerAlive: () => true, startTimeOf: () => 1 });
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const painted = [];
  const run = (sessionId, seq, next, lockWith = withLock) => withTerminal({
    transmitDir, terminal, sessionId, seq, lockWith, lockOptions,
  }, () => {
    const { entryPath, lockPath } = ledgerPaths(transmitDir, sessionId);
    return emit({
      prev: { sessionId, state: 'working', ...terminal }, next,
      intent: { ...intentAt('working'), sessionId }, seq,
      terminal: { path: '/dev/null', env: { TERM: 'xterm-kitty' }, tmux: null },
      ledger: fileLedger(entryPath), lock: (fn) => withLock(lockPath, fn, lockOptions), ownerAlive: () => true,
      readSprite: () => PNG, readFrame: () => PNG,
      open: () => 7, checkTty: () => true, close: () => {},
      write: (_fd, bytes, offset, length) => { painted.push({ sessionId, bytes: Buffer.from(bytes.subarray(offset, offset + length)) }); return length; },
    });
  });
  const a = run('A', 10, null, async (...args) => { await deferred; return withLock(...args); });
  const b = await run('B', 11, { sessionId: 'B', state: 'working', ...terminal });
  release();
  assert.equal(b.kind, 'transmitted');
  assert.deepEqual(await a, { kind: 'superseded', reason: 'terminal' });
  assert.equal(painted.length, 1);
  assert.equal(painted[0].sessionId, 'B');
  assert.match(painted[0].bytes.toString(), /a=T,U=1/);
  assert.equal((await fileLedger(ledgerPaths(transmitDir, 'A').entryPath).read()).seq, 0, 'the superseded reset never stamps its session ledger');
});
