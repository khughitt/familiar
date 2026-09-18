import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync, writeSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapForTmux } from '../src/render/term/tmux.js';

// Capture the attached client's PTY: these are the bytes an outer terminal receives.
const has = (binary) => spawnSync('sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' }).status === 0;
const missing = ['tmux', 'script', 'mkfifo'].filter((binary) => !has(binary));
if (missing.length > 0 && process.env.CI === 'true') {
  throw new Error(`tmux pty test cannot run in CI: missing ${missing.join(', ')}`);
}
const skip = missing.length > 0 ? `missing ${missing.join(', ')}` : false;

const bin = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const APC = '\x1b_Ga=T,f=100,q=2,r=2,C=1,m=0;AAAA\x1b\\';
const WRAPPED_APC = '\x1b_Ga=T,f=100,q=2,r=2,C=1,m=0;BBBB\x1b\\';
const bareApcs = (text) => (text.match(/(?<!\x1b)\x1b_G/g) ?? []).length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer({ passthrough, paneCommand, paneEnv = {} }, body) {
  const dir = mkdtempSync(join(tmpdir(), 'tmux-pty-'));
  const sock = join(dir, 'sock');
  const conf = join(dir, 'tmux.conf');
  const log = join(dir, 'client.log');
  writeFileSync(conf, `set -g allow-passthrough ${passthrough}\nset -g status off\n`);
  const envArgs = Object.entries(paneEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const started = spawnSync('tmux', ['-S', sock, '-f', conf, 'new-session', '-d', '-x', '80', '-y', '24', ...envArgs, paneCommand], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const clientEnv = { ...process.env, TERM: 'xterm-kitty' };
  delete clientEnv.TMUX;
  const client = process.platform === 'darwin'
    ? spawn('script', ['-q', log, 'tmux', '-S', sock, 'attach'], { env: clientEnv, stdio: 'ignore' })
    : spawn('script', ['-qfc', `tmux -S ${sock} attach`, log], { env: clientEnv, stdio: 'ignore' });
  try {
    let attached = false;
    for (let i = 0; i < 50 && !attached; i += 1) {
      const tty = spawnSync('tmux', ['-S', sock, 'display-message', '-p', '#{client_tty}'], { encoding: 'utf8' }).stdout.trim();
      attached = tty !== '';
      if (!attached) await sleep(100);
    }
    assert.ok(attached, 'a client attached through the pty within 5 s');
    return await body({ readClient: () => readFileSync(log, 'latin1') });
  } finally {
    spawnSync('tmux', ['-S', sock, 'kill-server']);
    client.kill();
  }
}

for (const [passthrough, wrappedForwarded] of [['all', true], ['off', false]]) {
  test(`allow-passthrough ${passthrough}: bare APC is dropped, wrapped APC ${wrappedForwarded ? 'reaches the client unframed' : 'is dropped'}`, { skip }, async () => {
    const fifoDir = mkdtempSync(join(tmpdir(), 'fifo-'));
    const fifo = join(fifoDir, 'in');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    await withServer({ passthrough, paneCommand: `cat ${fifo}` }, async ({ readClient }) => {
      const fd = openSync(fifo, 'w');
      writeSync(fd, 'BARE>');
      writeSync(fd, APC);
      writeSync(fd, '<WRAPPED>');
      writeSync(fd, wrapForTmux(WRAPPED_APC));
      writeSync(fd, '<END\n');
      closeSync(fd);
      await sleep(500);
      const seen = readClient();
      assert.ok(seen.includes('END'), 'the pane text was redrawn to the client');
      assert.equal(seen.includes(APC), false, 'the bare command is dropped');
      assert.equal(seen.includes(WRAPPED_APC), wrappedForwarded, 'the wrapped command reaches the client only with passthrough all');
      assert.equal(bareApcs(seen), wrappedForwarded ? 1 : 0, `${passthrough}: forwarded APC count`);
      assert.equal(seen.includes('\x1bPtmux;'), false, 'the client never sees the DCS framing itself');
    });
  });
}

test('familiar theme preview inside a passthrough-all pane paints the client', { skip }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const config = mkdtempSync(join(tmpdir(), 'config-'));
  const themes = mkdtempSync(join(tmpdir(), 'themes-'));
  cpSync(fileURLToPath(new URL('fixtures/theme-pack', import.meta.url)), join(themes, 'cats'), { recursive: true });
  const go = join(state, 'go');
  const paneEnv = { FAMILIAR_STATE_DIR: state, FAMILIAR_CONFIG_DIR: config, FAMILIAR_THEMES_DIR: themes };
  assert.equal(spawnSync(process.execPath, [bin, 'scheme', 'set', 'dark'], { env: { ...process.env, ...paneEnv } }).status, 0);
  // Wait for attachment: a detached server has no client to forward preview's bytes to.
  const paneCommand = `sh -c 'while [ ! -e ${go} ]; do sleep 0.1; done; ${process.execPath} ${bin} theme preview pip --state idle; sleep 2'`;
  await withServer({ passthrough: 'all', paneEnv, paneCommand }, async ({ readClient }) => {
    writeFileSync(go, '');
    await sleep(2000);
    const seen = readClient();
    assert.ok(bareApcs(seen) > 0, `the sprite reached the client unframed:\n${JSON.stringify(seen.slice(0, 200))}`);
    assert.equal(seen.includes('\x1bPtmux;'), false);
  });
});
