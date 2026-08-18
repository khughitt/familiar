import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:https';
import { devNull, tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateThemePack } from 'familiar-theme';
import { paths } from '../src/bus/paths.js';
import { addTheme, STAGING_DIR_NAME } from '../src/theme/add.js';
import { readReceipt } from '../src/theme/receipt.js';
import { writePack } from './helpers/fixture.js';

// These committed cert/key files are TEST FIXTURES for loopback TLS only.
// The key protects nothing and is deliberately public. caFile is addTheme's
// sole TLS seam; the production HTTPS-only protocol allowlist is used as-is.
const CERT = fileURLToPath(new URL('./fixtures/tls/cert.pem', import.meta.url));
const KEY = fileURLToPath(new URL('./fixtures/tls/key.pem', import.meta.url));

const scratch = () => {
  const cfg = mkdtempSync(join(tmpdir(), 'https-add-'));
  return paths({ FAMILIAR_CONFIG_DIR: cfg, HOME: cfg });
};
const stagingEntries = (p) => {
  const dir = join(p.userThemesDir, STAGING_DIR_NAME);
  return existsSync(dir) ? readdirSync(dir) : [];
};

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_SYSTEM: devNull,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@invalid',
};
const git = (args, cwd) => execFileSync('git', args, {
  cwd, env: GIT_ENV, encoding: 'utf8',
});

function bareRepoFrom(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'fixture pack'], dir);
  const bare = join(mkdtempSync(join(tmpdir(), 'bare-')), 'repo.git');
  execFileSync('git', ['clone', '-q', '--bare', dir, bare], { env: GIT_ENV });
  git(['update-server-info'], bare);
  return bare;
}

async function serveBare(bareDir) {
  // This Git rejects shallow clones over static dumb HTTP, so use the brief's
  // CGI contingency while keeping transport, repository, and TLS hermetic.
  const sockets = new Set();
  const children = new Set();
  const server = createServer(
    { cert: readFileSync(CERT), key: readFileSync(KEY) },
    (req, res) => {
      let url;
      try {
        url = new URL(req.url, 'https://loopback');
        const path = decodeURIComponent(url.pathname);
        if (path !== '/repo.git' && !path.startsWith('/repo.git/')) {
          throw new Error('outside repo');
        }
        const rel = normalize(path.slice('/repo.git'.length)).replace(/^[/\\]+/, '');
        const file = join(bareDir, rel);
        if (file !== bareDir && !file.startsWith(bareDir + sep)) throw new Error('outside root');
      } catch {
        res.statusCode = 404;
        res.end();
        return;
      }

      const child = spawn('git', ['http-backend'], {
        env: {
          ...GIT_ENV,
          GIT_PROJECT_ROOT: dirname(bareDir),
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: req.headers['content-length'] ?? '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      children.add(child);
      child.once('close', () => children.delete(child));
      req.once('aborted', () => child.kill('SIGKILL'));
      req.pipe(child.stdin);

      let pending = Buffer.alloc(0);
      let headersSent = false;
      child.stdout.on('data', (chunk) => {
        if (headersSent) {
          res.write(chunk);
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf('\r\n\r\n');
        if (end === -1) return;
        for (const line of pending.subarray(0, end).toString().split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const name = line.slice(0, colon);
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') res.statusCode = Number.parseInt(value, 10);
          else res.setHeader(name, value);
        }
        headersSent = true;
        res.write(pending.subarray(end + 4));
      });
      child.once('error', () => {
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
      child.once('close', () => res.end());
    }
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    url: `https://127.0.0.1:${server.address().port}/repo.git`,
    close: async () => {
      for (const child of children) child.kill('SIGKILL');
      for (const socket of sockets) socket.destroy();
      await new Promise((closed) => server.close(closed));
    },
  };
}

test('theme add clones over HTTPS end-to-end', async (t) => {
  const p = scratch();
  const bare = bareRepoFrom(writePack());
  const head = git(['rev-parse', 'HEAD'], bare).trim();
  const { url, close } = await serveBare(bare);
  t.after(close);

  const result = await addTheme({ paths: p, source: url, caFile: CERT });

  assert.equal(result.id, 'gate-fixture');
  assert.equal(existsSync(join(result.dir, '.git')), false);
  assert.equal(existsSync(join(result.dir, 'theme.yaml')), true);
  const read = readReceipt(p, 'gate-fixture');
  assert.equal(read.verdict, 'validated');
  assert.deepEqual(read.receipt.source, { kind: 'https', url, commit: head });
  assert.deepEqual(stagingEntries(p), []);
});

test('an LFS-pointer HTTPS pack is rejected legibly and cleaned', async (t) => {
  const p = scratch();
  const work = writePack();
  writeFileSync(
    join(work, 'sprites', 'solo', 'idle.png'),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12\n`
  );
  const { url, close } = await serveBare(bareRepoFrom(work));
  t.after(close);

  await assert.rejects(addTheme({ paths: p, source: url, caFile: CERT }), /LFS pointer/);
  assert.deepEqual(stagingEntries(p), []);
  assert.equal(existsSync(join(p.userThemesDir, 'gate-fixture')), false);
});

test('an invalid HTTPS pack is rejected by the gate and cleaned', async (t) => {
  const p = scratch();
  const work = writePack();
  rmSync(join(work, 'theme.yaml'));
  const { url, close } = await serveBare(bareRepoFrom(work));
  t.after(close);

  await assert.rejects(addTheme({ paths: p, source: url, caFile: CERT }));
  assert.deepEqual(stagingEntries(p), []);
});

test('a hung HTTPS remote is cut off by the named wall clock and cleaned', async (t) => {
  const p = scratch();
  const sockets = new Set();
  const server = createServer(
    { cert: readFileSync(CERT), key: readFileSync(KEY) },
    () => {}
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((closed) => server.close(closed));
  });
  const url = `https://127.0.0.1:${server.address().port}`;

  await assert.rejects(
    addTheme({ paths: p, source: url, caFile: CERT, timeoutMs: 1500 }),
    /exceeded the 1500 ms wall clock/
  );
  assert.deepEqual(stagingEntries(p), []);
});

test('a held HTTPS add makes a zero-retry HTTPS add fail by name', async (t) => {
  const p = scratch();
  const { url, close } = await serveBare(bareRepoFrom(writePack()));
  t.after(close);
  let releaseFirst;
  let markEntered;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const first = addTheme({
    paths: p,
    source: url,
    caFile: CERT,
    timeoutMs: 5000,
    validate: async (dir) => {
      markEntered();
      await gate;
      return validateThemePack(dir);
    },
  });
  await Promise.race([entered, first]);

  let result;
  try {
    await assert.rejects(
      addTheme({
        paths: p,
        source: url,
        caFile: CERT,
        lockOpts: { retries: 0 },
      }),
      /another theme add is running/
    );
  } finally {
    releaseFirst();
    result = await first;
  }
  assert.equal(result.id, 'gate-fixture');
  assert.deepEqual(stagingEntries(p), []);
});
