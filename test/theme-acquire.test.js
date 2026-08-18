import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, symlinkSync, existsSync, readFileSync, realpathSync,
  rmSync, truncateSync, writeFileSync,
} from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireSource, buildCloneEnv, classifySource, collapseStderr, copySource,
  DEFAULT_GROWTH_LIMIT_BYTES,
} from '../src/theme/acquire.js';
import { LIMITS } from 'familiar-theme';
import { writePack } from './helpers/fixture.js';

const destDir = () => mkdtempSync(join(tmpdir(), 'dest-'));

test('an https URL classifies as a clone source', () => {
  assert.deepEqual(classifySource('https://example.test/themes/cats'),
    { kind: 'https', url: 'https://example.test/themes/cats' });
});

test('credentials in the URL are rejected before anything runs', () => {
  assert.throws(() => classifySource('https://user:token@example.test/r'), /credential/);
  assert.throws(() => classifySource('https://token@example.test/r'), /credential/);
});

test('an invalid https source gets the named source instruction', () => {
  assert.throws(() => classifySource('https://%'), /HTTPS URLs or local directories/);
});

test('non-https transports are rejected by the stated rule', () => {
  for (const raw of ['http://example.test/r', 'ssh://example.test/r',
    'git://example.test/r', 'file:///tmp/r', 'git@example.test:r.git']) {
    assert.throws(() => classifySource(raw), /HTTPS URLs or local directories/, raw);
  }
});

test('scheme and scp-style transports are rejected before filesystem work', () => {
  for (const raw of ['file:/tmp/theme', 'ssh:host:path', 'mailto:x',
    'user@example.test:repo.git']) {
    assert.throws(() => classifySource(raw, {
      stat: () => { throw new Error('stat should not run'); },
    }), /HTTPS URLs or local directories/, raw);
  }
});

test('an existing directory classifies as a local source, absolute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'src-'));
  assert.deepEqual(classifySource(dir), { kind: 'local', path: resolve(dir) });
});

test('a missing local path is a named error', () => {
  assert.throws(() => classifySource('/no/such/dir/exists'), /no directory at/);
});

test('a file is not a directory source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'src-'));
  const file = join(dir, 'theme.tar.gz');
  writeFileSync(file, 'x');
  assert.throws(() => classifySource(file), /not a directory/);
});

test('stderr collapses to one sanitized line', () => {
  const raw = "Cloning into 'x'...\nremote: \x1b[31mnope\x1b[0m\r\nfatal: repository not found\n";
  const line = collapseStderr(raw);
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes('\r'), false);
  assert.match(line, /Cloning into 'x'\.\.\.; remote: nope; fatal: repository not found/);
});

test('bare CR, backspace, and BEL cannot rewrite the message', () => {
  const line = collapseStderr('progress 1%\rprogress 100%\bdone\x07!');
  assert.equal(/[\p{Cc}]/u.test(line), false);
  assert.match(line, /progress 1%; progress 100%/);
});

test('a pack copies byte-for-byte, excluding any .git', async () => {
  const src = writePack();
  mkdirSync(join(src, '.git'));
  writeFileSync(join(src, '.git', 'config'), 'x');
  mkdirSync(join(src, 'sprites', '.git'));
  writeFileSync(join(src, 'sprites', '.git', 'HEAD'), 'x');
  const dest = destDir();
  await copySource(src, dest);
  assert.equal(existsSync(join(dest, '.git')), false);
  assert.equal(existsSync(join(dest, 'sprites', '.git')), false);
  assert.deepEqual(readFileSync(join(dest, 'theme.yaml')),
    readFileSync(join(src, 'theme.yaml')));
  assert.deepEqual(readFileSync(join(dest, 'sprites', 'solo', 'idle.png')),
    readFileSync(join(src, 'sprites', 'solo', 'idle.png')));
});

test('a symlink in the source fails acquisition by path, undereferenced', async () => {
  const src = writePack();
  symlinkSync('/etc/hostname', join(src, 'link.png'));
  await assert.rejects(copySource(src, destDir()), /link\.png/);
});

test('a FIFO fails acquisition by path', async () => {
  const src = writePack();
  execFileSync('mkfifo', [join(src, 'pipe')]);
  await assert.rejects(copySource(src, destDir()), /pipe/);
});

test('a Unix socket fails acquisition by path', async () => {
  const src = writePack();
  const sock = join(src, 'listen.sock');
  const server = createNetServer();
  await new Promise((ready) => server.listen(sock, ready));
  try {
    await assert.rejects(copySource(src, destDir()), /listen\.sock/);
  } finally {
    await new Promise((closed) => server.close(closed));
  }
});

test('a destination beneath the source is rejected before the walk', async () => {
  const src = writePack();
  const dest = join(src, 'nested', 'dest');
  mkdirSync(dest, { recursive: true });
  await assert.rejects(copySource(src, dest), /inside the source/);
});

test('an aborted signal stops the copy with its reason', async () => {
  const src = writePack();
  const controller = new AbortController();
  controller.abort(new Error('bound tripped'));
  await assert.rejects(copySource(src, destDir(), { signal: controller.signal }),
    /bound tripped/);
});

test('isolation env wins over anything the caller injects', () => {
  const env = buildCloneEnv({ caFile: '/fixture/ca.pem' }, {
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_ASKPASS: '/evil/askpass',
    GIT_CONFIG_GLOBAL: '/evil/gitconfig',
    GIT_CONFIG_SYSTEM: '/evil/system-config',
    GIT_TERMINAL_PROMPT: '1',
    GIT_SSL_CAINFO: '/evil/ca.pem',
    SSH_ASKPASS: '/evil/ssh-askpass',
  });
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https');
  assert.equal(env.GIT_CONFIG_GLOBAL, devNull);
  assert.equal(env.GIT_CONFIG_SYSTEM, devNull);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_ASKPASS, '');
  assert.equal(env.SSH_ASKPASS, '');
  assert.equal(env.GIT_SSL_CAINFO, '/fixture/ca.pem');
});

test('uncontrolled Git environment is stripped when no CA file is supplied', () => {
  const env = buildCloneEnv({}, {
    PATH: '/fixture/bin',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.sslVerify',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_SSL_CAINFO: '/evil/ca.pem',
    GIT_SSL_NO_VERIFY: '1',
  });
  assert.equal(env.PATH, '/fixture/bin');
  for (const key of [
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_SSL_CAINFO', 'GIT_SSL_NO_VERIFY',
  ]) assert.equal(key in env, false, key);
});

test('the default growth limit derives from the contract limit', () => {
  assert.equal(DEFAULT_GROWTH_LIMIT_BYTES, 4 * LIMITS.MAX_TOTAL_BYTES);
});

test('the post-acquisition size check rejects a fast local copy past the bound', async () => {
  const src = writePack();
  const dest = destDir();
  await assert.rejects(
    acquireSource({ kind: 'local', path: src }, dest,
      { growthLimitBytes: 16, pollMs: 60_000 }),
    /grew past the 16-byte bound \(\d+ bytes fetched\)/
  );
});

test('a completed local acquisition returns local provenance', async () => {
  const src = writePack();
  const dest = destDir();
  const provenance = await acquireSource({ kind: 'local', path: src }, dest);
  assert.deepEqual(provenance, { kind: 'local', path: realpathSync(src) });
  assert.equal(existsSync(join(dest, 'theme.yaml')), true);
});

test('a zero-millisecond acquisition cannot outrun the absolute deadline', async () => {
  const src = mkdtempSync(join(tmpdir(), 'src-empty-'));
  await assert.rejects(
    acquireSource({ kind: 'local', path: src }, destDir(),
      { timeoutMs: 0, pollMs: 60_000 }),
    /exceeded the 0 ms wall clock/
  );
});

test('the final growth scan fails closed on an unreadable directory', async (t) => {
  const src = mkdtempSync(join(tmpdir(), 'src-empty-'));
  const dest = destDir();
  const blocked = join(dest, 'blocked');
  mkdirSync(blocked);
  chmodSync(blocked, 0);
  t.after(() => {
    chmodSync(blocked, 0o700);
    rmSync(src, { recursive: true });
    rmSync(dest, { recursive: true });
  });
  await assert.rejects(
    acquireSource({ kind: 'local', path: src }, dest, { pollMs: 60_000 }),
    /could not measure staging growth.*blocked/
  );
});

test('an interval scan error aborts acquisition instead of throwing out of band', async (t) => {
  const src = mkdtempSync(join(tmpdir(), 'src-large-'));
  const bulk = join(src, 'bulk.bin');
  writeFileSync(bulk, '');
  truncateSync(bulk, 64 * 1024 * 1024);
  const dest = destDir();
  const blocked = join(dest, 'blocked');
  mkdirSync(blocked);
  chmodSync(blocked, 0);
  t.after(() => {
    chmodSync(blocked, 0o700);
    rmSync(src, { recursive: true });
    rmSync(dest, { recursive: true });
  });
  await assert.rejects(
    acquireSource({ kind: 'local', path: src }, dest, { pollMs: 1 }),
    /could not measure staging growth.*blocked/
  );
});
