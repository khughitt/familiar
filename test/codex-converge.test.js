import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadThemePack } from 'familiar-theme';
import { convergeCodexProject, shouldConverge } from '../src/install/codex-converge.js';
import { stampFor, STAMP_FILE } from '../src/install/pet-stamp.js';
import { SPRITESHEET_PATH, FRAME } from '../src/render/codex/pets.js';

const THEME = await loadThemePack(
  fileURLToPath(new URL('./fixtures/theme-slots', import.meta.url)));

function petsFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-pets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [memberId, member] of THEME.members) {
    const petDir = join(dir, `familiar-${memberId}`);
    mkdirSync(join(petDir, 'assets'), { recursive: true });
    writeFileSync(join(petDir, SPRITESHEET_PATH), 'png');
    writeFileSync(join(petDir, 'pet.json'), '{}');
    writeFileSync(join(petDir, STAMP_FILE), JSON.stringify(stampFor({
      themeId: THEME.id, memberId, frame: FRAME, motionPolicy: 'full',
      anchor: member.anchor ?? 'floor', sheet: Uint8Array.from([1]),
    })));
  }
  return dir;
}

// `git rev-parse --show-toplevel` reports the PHYSICAL path, so resolve the root
// the way the transaction would have.
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-converge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin',
    'git@github.com:example/converge.git'], { encoding: 'utf8' });
  return spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8' }).stdout.trim();
}

const run = (root, petsDir, member, catalog = { identities: [] }) =>
  convergeCodexProject({ repoRoot: root, member, catalog, pack: THEME, themeId: THEME.id, petsDir });

const readConfig = (root) => readFileSync(join(root, '.codex', 'config.toml'), 'utf8');

test('the routing predicate fires for Codex SessionStart and nothing else', () => {
  assert.equal(shouldConverge({ agent: 'codex', event: 'SessionStart' }), true);
  assert.equal(shouldConverge({ agent: 'codex', event: 'PreToolUse' }), false);
  assert.equal(shouldConverge({ agent: 'codex', event: 'Stop' }), false);
  assert.equal(shouldConverge({ agent: 'claude-code', event: 'SessionStart' }), false);
  assert.equal(shouldConverge({ agent: 'opencode', event: 'SessionStart' }), false);
});

test('a repository with no config gets one, and the exclude entry with it', async (t) => {
  const root = repo(t);
  const result = await run(root, petsFor(t), 'gamma');
  assert.equal(result.outcome, 'converged');
  assert.match(readConfig(root), /pet = "custom:familiar-gamma"/);
  assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /\.codex\/config\.toml/);
});

test('an already-correct config is unchanged, and spawns no git', async (t) => {
  const root = repo(t);
  const petsDir = petsFor(t);
  await run(root, petsDir, 'gamma');
  const before = readConfig(root);

  // The no-op path must not reach the planner. Break `git` on PATH for the
  // duration: if convergence spawns one, this fails loudly.
  const bin = mkdtempSync(join(tmpdir(), 'familiar-nogit-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const priorPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = priorPath; });

  const again = await run(root, petsDir, 'gamma');
  assert.equal(again.outcome, 'unchanged');
  assert.equal(again.changed, false);
  assert.equal(readConfig(root), before);
});

test('the member the caller supplied is the member written — not a re-resolved one', async (t) => {
  const root = repo(t);            // unpinned, hashes to slot 8 -> gamma
  const petsDir = petsFor(t);
  await run(root, petsDir, 'gamma');
  const second = await run(root, petsDir, 'alpha');
  assert.equal(second.outcome, 'converged');
  assert.equal(second.member, 'alpha');
  assert.match(readConfig(root), /pet = "custom:familiar-alpha"/);
});

test('a matching config whose pet is missing reports, rather than saying unchanged', async (t) => {
  const root = repo(t);
  await run(root, petsFor(t), 'gamma');
  const before = readConfig(root);

  const empty = mkdtempSync(join(tmpdir(), 'familiar-pets-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const result = await run(root, empty, 'gamma');

  assert.equal(result.outcome, 'actionable');
  assert.match(result.reason, /not installed/);
  assert.equal(readConfig(root), before, 'a correct file is still not rewritten');
});

test('an unmanaged config is left alone and reported as actionable', async (t) => {
  const root = repo(t);
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex', 'config.toml'), '[tui]\npet = "mine"\n');
  const result = await run(root, petsFor(t), 'gamma');
  assert.equal(result.outcome, 'actionable');
  assert.match(result.reason, /unmanaged/);
  assert.equal(readConfig(root), '[tui]\npet = "mine"\n');
});

test('a member whose assets are missing is NOT selected — a broken selection is worse than a stale one', async (t) => {
  const root = repo(t);
  const empty = mkdtempSync(join(tmpdir(), 'familiar-pets-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const result = await run(root, empty, 'gamma');
  assert.equal(result.outcome, 'actionable');
  assert.match(result.reason, /not installed/);
  assert.match(result.reason, /familiar install pets/);
  assert.equal(existsSync(join(root, '.codex', 'config.toml')), false);
});

test('a FIFO at the config path is refused without opening it', async (t) => {
  const root = repo(t);
  mkdirSync(join(root, '.codex'), { recursive: true });
  if (spawnSync('mkfifo', [join(root, '.codex', 'config.toml')]).status !== 0) return;

  // If this returns at all, the implementation did not read the FIFO.
  const result = await run(root, petsFor(t), 'gamma');
  assert.equal(result.outcome, 'error');
  assert.match(result.reason, /not a regular file/);
});

test('the empty .codex marker is migrated, not reported as an error', async (t) => {
  const root = repo(t);
  writeFileSync(join(root, '.codex'), '');     // the zero-byte marker the planner migrates
  const result = await run(root, petsFor(t), 'gamma');
  assert.equal(result.outcome, 'converged');
  assert.match(readConfig(root), /pet = "custom:familiar-gamma"/);
});

test('a session with no repository root is a quiet no-op', async (t) => {
  const result = await run(null, petsFor(t), 'gamma');
  assert.equal(result.outcome, 'quiet');
  assert.equal(result.changed, false);
});

test('the hook branch actually calls the predicate — wiring guard', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../bin/familiar', import.meta.url)), 'utf8');
  assert.match(source, /shouldConverge\(\{\s*agent: name, event: positionals\[0\]\s*\}\)/,
    'bin/familiar must route convergence through shouldConverge');
  assert.match(source, /convergeCodexProject\(/);
});
