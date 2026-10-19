import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const bin = fileURLToPath(new URL('../bin/familiar-niri', import.meta.url));

test('familiar-niri rejects trailing arguments', () => {
  const result = spawnSync(process.execPath, [bin, 'sync', 'unexpected'], {
    encoding: 'utf8', env: { ...process.env, PATH: '' },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'usage: familiar-niri <sync | watch>\n');
});

test('the bridge resyncs on a sessions.json rename', { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-niri-watch-'));
  const state = join(dir, 'state');
  const fakeBin = join(dir, 'bin');
  await mkdir(state); await mkdir(fakeBin);
  const ready = join(dir, 'ready');
  const config = join(dir, 'config');
  await mkdir(config);
  await writeFile(join(fakeBin, 'niri'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
if (process.argv.includes('windows')) {
  process.stdout.write(JSON.stringify([{ id: 7, pid: ${process.pid}, workspace_id: 2 }]));
} else {
  writeFileSync(${JSON.stringify(ready)}, 'ready');
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });
  const child = spawn(process.execPath, [bin, 'watch'], { detached: true,
    env: { ...process.env, FAMILIAR_STATE_DIR: state, FAMILIAR_CONFIG_DIR: config,
      PATH: `${fakeBin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = once(child, 'close');
  const stop = () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const onTerm = async () => { stop(); await closed; process.exit(143); };
  const onInt = async () => { stop(); await closed; process.exit(130); };
  process.once('exit', stop);
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  t.after(async () => {
    stop();
    await closed;
    process.removeListener('exit', stop);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    await rm(dir, { recursive: true, force: true });
  });
  const waitFor = async (path, expected) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { if (await readFile(path, 'utf8') === expected) return; } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      assert.equal(child.exitCode, null, stderr);
      await delay(20);
    }
    assert.fail(`timed out waiting for ${expected}: ${stderr}`);
  };
  await waitFor(ready, 'ready');
  await waitFor(join(state, 'niri-windows.json'), '{}\n');
  const session = { sessionId: 's1', harness: 'claude-code', agentId: 'claude-code:s1',
    basis: { generation: 'generation', agentId: 'claude-code:s1', cwd: '/repo', process: null },
    project: 'repo', projectKey: 'path:/repo', cwd: '/repo', remote: null,
    repoRoot: null, repositoryRoot: null, projectColor: null,
    pid: process.pid, starttime: 1, seq: 1, state: 'idle', updatedAt: 1 };
  await writeFile(join(state, 'new-sessions.json'), JSON.stringify({ schema: 1, registry: null,
    sessions: { s1: session }, ended: {} }));
  await rename(join(state, 'new-sessions.json'), join(state, 'sessions.json'));
  await waitFor(join(state, 'niri-windows.json'), '{\n  "s1": {\n    "windowId": 7,\n    "workspaceId": 2\n  }\n}\n');
});
