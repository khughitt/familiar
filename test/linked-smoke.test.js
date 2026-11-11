import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the macOS linked-command smoke accepts the current setup documents', (t) => {
  const workflow = parse(readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8'));
  const script = workflow.jobs.macos.steps.find((step) => step.name === 'linked command smoke').run;
  const root = mkdtempSync(join(tmpdir(), 'familiar-linked-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  symlinkSync(join(ROOT, 'bin/familiar'), join(bin, 'familiar'));
  // Linking is represented by the fixture symlink; npm must never alter host links.
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = link ] || exit 64\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: home, encoding: 'utf8', timeout: 15_000,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
      FAMILIAR_STATE_DIR: join(root, 'state'), FAMILIAR_CONFIG_DIR: join(root, 'config'),
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});
