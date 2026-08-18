import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, symlinkSync, existsSync, readFileSync, realpathSync,
  readdirSync, readlinkSync, renameSync, rmSync, truncateSync, watch, writeFileSync,
} from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  acquireSource, buildCloneEnv, classifySource, cloneSource, collapseStderr, copySource,
  DEFAULT_GROWTH_LIMIT_BYTES,
} from '../src/theme/acquire.js';
import { LIMITS } from 'familiar-theme';
import { writePack } from './helpers/fixture.js';

const destDir = () => mkdtempSync(join(tmpdir(), 'dest-'));
const acquireModule = new URL('../src/theme/acquire.js', import.meta.url).href;
const fileCopyModule = new URL('../src/theme/copy-regular-file.js', import.meta.url).href;

function makeDeepTree(root, depth) {
  let dir = root;
  for (let i = 0; i < depth; i++) {
    dir = join(dir, `level-${i}`);
    mkdirSync(dir);
  }
}

function hasOpenDirectory(target) {
  return readdirSync('/proc/self/fd').some((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === target;
    } catch {
      return false;
    }
  });
}

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

test('a FIFO at the regular-file open boundary is rejected without blocking', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fifo-open-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const fifo = join(dir, 'swapped-file');
  const out = join(dir, 'out');
  execFileSync('mkfifo', [fifo]);
  const script = `
const { copyRegularFile } = await import(${JSON.stringify(fileCopyModule)});
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('test timeout')), 50);
try {
  await copyRegularFile(process.argv[1], process.argv[1], process.argv[2], controller.signal);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
} finally {
  clearTimeout(timer);
}
`;
  const result = spawnSync(process.execPath,
    ['--input-type=module', '--eval', script, fifo, out],
    { encoding: 'utf8', timeout: 1000 });
  assert.equal(result.signal, null, 'regular-file open blocked on the FIFO');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /swapped-file.*regular file or directory/);
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

test('a queued directory swapped for a symlink is never followed', async (t) => {
  const src = mkdtempSync(join(tmpdir(), 'src-swap-'));
  const victim = join(src, 'aa-victim');
  const held = join(src, 'held-victim');
  const delay = join(src, 'zz-delay');
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  mkdirSync(victim);
  mkdirSync(delay);
  writeFileSync(join(victim, 'safe.txt'), 'safe');
  writeFileSync(join(outside, 'secret.txt'), 'must not be copied');
  for (let i = 0; i < 32; i++) mkdirSync(join(delay, `entry-${i}`));
  const dest = destDir();
  let copySettled = false;
  let swappedBeforeTraversal = false;
  let swappedBeforeSettlement = false;
  let resolveSwap;
  const swapped = new Promise((resolveSwapPromise) => { resolveSwap = resolveSwapPromise; });
  const watcher = watch(dest, (event, name) => {
    if (name !== 'aa-victim' || existsSync(held)) return;
    swappedBeforeTraversal = !existsSync(join(dest, 'aa-victim', 'safe.txt'));
    swappedBeforeSettlement = !copySettled;
    renameSync(victim, held);
    symlinkSync(outside, victim, 'dir');
    resolveSwap();
  });
  t.after(() => {
    watcher.close();
    rmSync(src, { recursive: true });
    rmSync(outside, { recursive: true });
    rmSync(dest, { recursive: true });
  });

  let failure;
  try {
    await copySource(src, dest);
  } catch (error) {
    failure = error;
  } finally {
    copySettled = true;
  }
  await swapped;
  assert.equal(swappedBeforeTraversal, true, 'swap occurred after victim traversal');
  assert.equal(swappedBeforeSettlement, true, 'swap occurred after copy settled');
  if (failure) assert.match(failure.message, /aa-victim.*regular file or directory/);
  else assert.equal(readFileSync(join(dest, 'aa-victim', 'safe.txt'), 'utf8'), 'safe');
  assert.equal(existsSync(join(dest, 'aa-victim', 'secret.txt')), false);
});

test('copy depth fails by name before a reduced fd limit can produce EMFILE', (t) => {
  const src = mkdtempSync(join(tmpdir(), 'src-deep-copy-'));
  const dest = destDir();
  t.after(() => {
    rmSync(src, { recursive: true });
    rmSync(dest, { recursive: true });
  });
  makeDeepTree(src, 100);
  const script = `
const { copySource } = await import(${JSON.stringify(acquireModule)});
try {
  await copySource(process.argv[1], process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
`;
  const result = spawnSync('bash', [
    '-c', 'ulimit -n 96; exec "$@"', 'bash', process.execPath,
    '--input-type=module', '--eval', script, src, dest,
  ], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.signal, null, 'deep copy hung under the reduced fd limit');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /exceeds the 64-directory traversal depth limit.*flatten/);
  assert.doesNotMatch(result.stderr, /EMFILE|too many open files/i);
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

test('the wall clock interrupts local topology traversal before it finishes', async () => {
  const src = mkdtempSync(join(tmpdir(), 'src-many-'));
  for (let i = 0; i < 500; i++) mkdirSync(join(src, `entry-${i}`));
  const dest = destDir();
  await assert.rejects(
    acquireSource({ kind: 'local', path: src }, dest,
      { timeoutMs: 0, pollMs: 60_000 }),
    /exceeded the 0 ms wall clock/
  );
  assert.ok(readdirSync(dest).length < 500);
});

test('growth measurement enforces the same named traversal depth limit', async (t) => {
  const src = mkdtempSync(join(tmpdir(), 'src-empty-'));
  const dest = destDir();
  t.after(() => {
    rmSync(src, { recursive: true });
    rmSync(dest, { recursive: true });
  });
  makeDeepTree(dest, 70);
  await assert.rejects(
    acquireSource({ kind: 'local', path: src }, dest, { pollMs: 60_000 }),
    /exceeds the 64-directory traversal depth limit.*flatten/
  );
});

test('Git diagnostics are bounded and disclose truncation', async (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'fake-git-'));
  const fakeGit = join(bin, 'git');
  writeFileSync(fakeGit, `#!/usr/bin/env node
process.stdout.write('o'.repeat(256 * 1024));
process.stderr.write('remote: ' + 'e'.repeat(256 * 1024));
process.exitCode = 1;
`);
  chmodSync(fakeGit, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  let caught;
  try {
    await cloneSource('https://example.test/repo', destDir());
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /output truncated/);
  assert.ok(caught.message.length < 70_000, `diagnostic was ${caught.message.length} chars`);
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

test('acquisition failure waits for the observed active growth scan to close',
  { timeout: 5000 }, async (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'fake-git-'));
  const control = mkdtempSync(join(tmpdir(), 'git-control-'));
  const fakeGit = join(bin, 'git');
  const release = join(control, 'fail');
  const dest = destDir();
  writeFileSync(fakeGit, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { watch } from 'node:fs/promises';
import { dirname } from 'node:path';
const release = process.env.FAMILIAR_TEST_RELEASE;
if (!existsSync(release)) {
  for await (const event of watch(dirname(release))) {
    if (existsSync(release)) break;
  }
}
process.stderr.write('fixture failure\\n');
process.exitCode = 1;
`);
  chmodSync(fakeGit, 0o755);
  for (let i = 0; i < 5000; i++) writeFileSync(join(dest, `prefill-${i}`), '');
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.FAMILIAR_TEST_RELEASE = release;
  t.after(() => {
    process.env.PATH = originalPath;
    delete process.env.FAMILIAR_TEST_RELEASE;
    rmSync(bin, { recursive: true });
    rmSync(control, { recursive: true });
    rmSync(dest, { recursive: true });
  });

  let settled = false;
  const acquisition = acquireSource(
    { kind: 'https', url: 'https://example.test/theme' }, dest,
    { pollMs: 0, timeoutMs: 2000 }
  );
  acquisition.then(() => { settled = true; }, () => { settled = true; });
  while (!hasOpenDirectory(dest)) {
    assert.equal(settled, false, 'acquisition settled before an interval scan opened staging');
    await new Promise((resume) => setImmediate(resume));
  }
  assert.equal(settled, false, 'scan was not active before clone failure');
  writeFileSync(release, 'fail');
  await assert.rejects(acquisition, /clone failed: fixture failure/);
  assert.equal(hasOpenDirectory(dest), false, 'growth scan directory remained open');
});
