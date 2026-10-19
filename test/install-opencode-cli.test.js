import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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

test('familiar-opencode: a clean config writes only tui.json and exits 0', () => {
  const dir = mkdir();
  const res = run([OPENCODE_BIN, '--config-dir', dir], mkdir());
  assert.equal(res.status, 0);
  const files = readdirSync(dir).sort();
  assert.ok(files.includes('tui.json'));
  assert.deepEqual(files, ['tui.json']);
});

test('familiar-opencode: --project-dir with no value is rejected, writes nothing to the global dir', () => {
  const sandbox = mkdir();
  // `--project-dir` last, no value: must NOT silently fall through to the global config.
  const res = run([OPENCODE_BIN, '--project-dir'], sandbox);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /requires a non-empty directory/);
  assert.deepEqual(readdirSync(sandbox).sort(), []); // the global (sandboxed) dir is untouched
});

test('familiar-opencode: an empty flag value is rejected, writes nothing to the global dir', () => {
  for (const flag of ['--project-dir', '--config-dir']) {
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

test('familiar-opencode: --project-dir and --config-dir together are rejected', () => {
  const res = run([OPENCODE_BIN, '--project-dir', '/a', '--config-dir', '/b'], mkdir());
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /mutually exclusive/);
});

test('familiar-opencode: flag-shaped target values fail before installation', (t) => {
  const sandbox = mkdir();
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const res = spawnSync('node', [OPENCODE_BIN, '--project-dir', '-h'], {
    cwd: sandbox, encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: sandbox },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--project-dir requires a non-empty directory value/);
  assert.deepEqual(readdirSync(sandbox), []);
});

test('familiar-opencode: repeated target flags fail before installation', (t) => {
  for (const flag of ['--project-dir', '--config-dir']) {
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

test('familiar install opencode: an undeclared option is a usage error before the wrapper runs', () => {
  const sandbox = mkdir();
  for (const args of [['--project', '/x'], ['--wat', '/x'], ['--config-dir']]) {
    const res = run([FAMILIAR_BIN, 'install', 'opencode', ...args], sandbox);
    assert.equal(res.status, 2, args.join(' '));          // this binary's usage error, not the child's exit 1
    assert.equal(res.stdout, '');
    assert.doesNotMatch(res.stderr, /opencode install failed/); // the child never ran
    assert.deepEqual(readdirSync(sandbox), []);
  }
});

test('familiar install opencode --project-dir writes into DIR/.opencode', () => {
  const dir = mkdir();
  const res = run([FAMILIAR_BIN, 'install', 'opencode', '--project-dir', dir], mkdir());
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readdirSync(join(dir, '.opencode')).sort(), ['tui.json']);
});

test('familiar install opencode --help is owned by the installer and writes nothing', () => {
  const sandbox = mkdir();
  const res = run([FAMILIAR_BIN, 'install', 'opencode', '--help'], sandbox);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /--project-dir DIR/);
  assert.match(res.stdout, /--config-dir DIR/);
  assert.match(res.stdout, /mutually exclusive/);
  assert.deepEqual(readdirSync(sandbox), []);
});

for (const kind of ['this checkout', 'renamed checkout', 'relay', 'gone', 'no legacy']) {
  test(`familiar install opencode retires legacy entries: ${kind}`, (t) => {
    const dir = mkdir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const checkout = kind === 'this checkout' ? root : join(dir, kind === 'relay' ? 'node_modules/relay' : 'pets-x');
    const entry = kind === 'no legacy' ? '/another/plugin.js' : join(checkout, 'integrations/opencode/plugin.js');
    if (kind === 'renamed checkout' || kind === 'relay') {
      mkdirSync(join(checkout, 'integrations/opencode'), { recursive: true });
      writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: kind === 'relay' ? 'relay' : 'familiar' }));
      writeFileSync(entry, '');
    }
    const config = join(dir, 'opencode.json');
    const original = `{ // keep formatting when unchanged
 "plugin": ${JSON.stringify([entry, 'other'])}
}
`;
    writeFileSync(config, original);
    const result = run([FAMILIAR_BIN, 'install', 'opencode', '--config-dir', dir], dir);
    assert.equal(result.status, kind === 'gone' ? 1 : 0, result.stderr);
    assert.ok(readdirSync(dir).includes('tui.json'));
    if (kind === 'this checkout' || kind === 'renamed checkout') {
      assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')).plugin, ['other']);
      assert.ok(result.stdout.includes(`removed familiar's legacy OpenCode server plugin ${entry} from ${config}`));
    } else {
      assert.equal(readFileSync(config, 'utf8'), original);
      if (kind === 'gone') assert.ok(result.stdout.includes(`kept ${entry}: cannot tell whether it is familiar's (no package.json beside it); remove it by hand if so`));
    }
  });
}
