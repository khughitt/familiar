import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnHook, FAMILIAR_BIN } from './hook.js';

test('FAMILIAR_BIN resolves to the repo\'s own bin/familiar, not to $PATH', () => {
  // $PATH inside opencode's process is whatever the user's launcher happened to export. A plugin
  // that silently stops working because a shell profile changed is the failure mode this project
  // spends its time avoiding.
  assert.ok(FAMILIAR_BIN.endsWith('/bin/familiar'));
  assert.ok(existsSync(FAMILIAR_BIN), `${FAMILIAR_BIN} does not exist`);
});

test('a zero exit resolves', async () => {
  await spawnHook('session.busy', { session_id: 'opencode:1', cwd: '/tmp' }, { bin: '/bin/true' });
});

test('a nonzero exit rejects, and says which event and what the hook said', async () => {
  await assert.rejects(
    () => spawnHook('session.idle', { session_id: 'opencode:1', cwd: '/tmp' }, { bin: '/bin/false' }),
    /exited 1/,
  );
});

test('the hook\'s stderr is CAPTURED and carried in the rejection — never inherited', async () => {
  // Never inherited: in an opencode plugin, our stderr IS the tty opentui is rendering into, and
  // familiar's hook writes eviction diagnostics to its own stderr. Inheriting them would spray
  // them across opencode's screen.
  await assert.rejects(
    () => spawnHook('session.busy', {}, { bin: '/bin/sh', args: ['-c', 'echo "pack has no member" >&2; exit 3'] }),
    /exited 3.*pack has no member/s,
  );
});

test('a binary that does not exist rejects rather than throwing out of band', async () => {
  await assert.rejects(
    () => spawnHook('init', {}, { bin: '/nonexistent/familiar' }),
    /ENOENT/,
  );
});

// THE PAYLOAD IS THE POINT OF THE SPAWN, so the test has to actually read it. A child that merely
// exits 0 (`/bin/cat`) proves only that a process ran — it would pass just as happily if we sent
// an empty string, the wrong keys, or nothing at all.
//
// So the child PARSES stdin and exits nonzero unless the JSON is exactly right, which makes the
// assertion the process exit itself.
//
// Note `process.exitCode = 9` and NOT `process.exit(9)`. stderr is a pipe here, so its writes are
// asynchronous; calling process.exit() immediately after one can tear the process down before the
// pipe flushes, and the diagnostic this child exists to produce would be lost -- intermittently,
// which is the worst way to lose it. Setting exitCode lets the event loop drain and exit on its own.
const ASSERT_PAYLOAD = `
  let s = '';
  process.stdin.on('data', (c) => { s += c; });
  process.stdin.on('end', () => {
    let p;
    try { p = JSON.parse(s); } catch { process.exitCode = 8; return; }
    const ok = p.session_id === 'opencode:42' && p.cwd === '/proj';
    if (!ok) { process.stderr.write('got ' + s); process.exitCode = 9; return; }
    process.exitCode = 0;
  });
`;

test('the payload reaches the child on stdin, as JSON, with the exact keys familiar parses', async () => {
  await spawnHook(
    'init',
    { session_id: 'opencode:42', cwd: '/proj' },
    { bin: process.execPath, args: ['-e', ASSERT_PAYLOAD] },
  );
});

test('...and the payload assertion is not vacuous — a wrong payload fails it', async () => {
  // Without this, the test above would pass even if spawnHook sent nothing at all.
  await assert.rejects(
    () => spawnHook(
      'init',
      { session_id: 'wrong', cwd: '/proj' },
      { bin: process.execPath, args: ['-e', ASSERT_PAYLOAD] },
    ),
    /exited 9.*got .*wrong/s,
  );
});
