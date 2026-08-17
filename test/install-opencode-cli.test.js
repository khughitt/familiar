import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const OPENCODE_BIN = join(root, 'bin', 'familiar-opencode');
const FAMILIAR_BIN = join(root, 'bin', 'familiar');
const mkdir = () => mkdtempSync(join(tmpdir(), 'familiar-oc-'));

// Every spawn points XDG_CONFIG_HOME at a throwaway dir, so even if an arg-parsing regression let
// a call fall through to "the global config", the blast radius is this temp dir — never the
// developer's real ~/.config/opencode. `sandbox` is that dir; assert it stays empty on rejection.
function run(args, sandbox) {
  return spawnSync('node', args, {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: sandbox },
  });
}

test('familiar-opencode: a malformed config exits nonzero and writes nothing', () => {
  const dir = mkdir();
  writeFileSync(join(dir, 'opencode.json'), '{ "plugin": "not-an-array" }');
  const before = readdirSync(dir).sort();
  const res = run([OPENCODE_BIN, '--config-dir', dir], mkdir());
  assert.notEqual(res.status, 0);            // nonzero — NOT swallowed like a hook
  assert.match(res.stderr, /opencode\.json/); // identifies WHICH config is malformed
  assert.match(res.stderr, /must be an array/);
  assert.deepEqual(readdirSync(dir).sort(), before); // no tui.json, no .tmp — nothing changed
});

test('familiar-opencode: a clean config writes both files and exits 0', () => {
  const dir = mkdir();
  const res = run([OPENCODE_BIN, '--config-dir', dir], mkdir());
  assert.equal(res.status, 0);
  const files = readdirSync(dir).sort();
  assert.ok(files.includes('tui.json'));
  assert.ok(files.includes('opencode.json'));
});

test('familiar-opencode: --project with no value is rejected, writes nothing to the global dir', () => {
  const sandbox = mkdir();
  // `--project` last, no value: must NOT silently fall through to the global config.
  const res = run([OPENCODE_BIN, '--project'], sandbox);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /requires a non-empty directory/);
  assert.deepEqual(readdirSync(sandbox).sort(), []); // the global (sandboxed) dir is untouched
});

test('familiar-opencode: an empty flag value is rejected, writes nothing to the global dir', () => {
  for (const flag of ['--project', '--config-dir']) {
    const sandbox = mkdir();
    const res = run([OPENCODE_BIN, flag, ''], sandbox);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /requires a non-empty directory/);
    assert.deepEqual(readdirSync(sandbox).sort(), []); // empty value did NOT select the global dir
  }
});

test('familiar-opencode: an unknown flag is rejected', () => {
  const res = run([OPENCODE_BIN, '--wat', '/x'], mkdir());
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown argument/);
});

test('familiar-opencode: --project and --config-dir together are rejected', () => {
  const res = run([OPENCODE_BIN, '--project', '/a', '--config-dir', '/b'], mkdir());
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /mutually exclusive/);
});

test('familiar-opencode: flag-shaped target values fail before installation', (t) => {
  const sandbox = mkdir();
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const res = spawnSync('node', [OPENCODE_BIN, '--project', '-h'], {
    cwd: sandbox, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: sandbox },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--project requires a non-empty directory value/);
  assert.deepEqual(readdirSync(sandbox), []);
});

test('familiar-opencode: repeated target flags fail before installation', (t) => {
  for (const flag of ['--project', '--config-dir']) {
    const sandbox = mkdir();
    t.after(() => rmSync(sandbox, { recursive: true, force: true }));
    const res = spawnSync('node', [OPENCODE_BIN, flag, 'first', flag, 'second'], {
      cwd: sandbox, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: sandbox },
    });
    assert.notEqual(res.status, 0, flag);
    assert.match(res.stderr, new RegExp(`duplicate ${flag}`));
    assert.deepEqual(readdirSync(sandbox), []);
  }
});

test('familiar install opencode: dispatches to the wrapper and propagates its nonzero exit', () => {
  const dir = mkdir();
  writeFileSync(join(dir, 'opencode.json'), '{ "plugin": 5 }');
  const res = run([FAMILIAR_BIN, 'install', 'opencode', '--config-dir', dir], mkdir());
  assert.notEqual(res.status, 0);            // dispatch preserves the child's failure, not exit-0
  assert.match(res.stderr, /must be an array/);
});

test('familiar install opencode --help is owned by the installer and writes nothing', () => {
  const sandbox = mkdir();
  const res = run([FAMILIAR_BIN, 'install', 'opencode', '--help'], sandbox);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /--project DIR/);
  assert.match(res.stdout, /--config-dir DIR/);
  assert.match(res.stdout, /mutually exclusive/);
  assert.deepEqual(readdirSync(sandbox), []);
});
