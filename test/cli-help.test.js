import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderHelp } from '../bin/familiar';

const bin = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const ttyBin = fileURLToPath(new URL('fixtures/tty-familiar.mjs', import.meta.url));
const themeFixture = fileURLToPath(new URL('../test/fixtures/theme-pack', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'familiar-cli-help-'));
  const config = join(root, 'config');
  const state = join(root, 'state');
  const xdg = join(root, 'xdg');
  mkdirSync(config);
  mkdirSync(state);
  mkdirSync(xdg);
  writeFileSync(join(config, 'config.yaml'), 'motion: sideways\n');
  writeFileSync(join(config, 'scheme.json'), '{not json');
  writeFileSync(join(state, 'sentinel'), 'unchanged');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    config,
    state,
    xdg,
    env: {
      ...process.env,
      FAMILIAR_CONFIG_DIR: config,
      FAMILIAR_STATE_DIR: state,
      XDG_CONFIG_HOME: xdg,
    },
  };
}

const run = (args, env) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env });

function gitRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'familiar-whoami-'));
  const dir = join(root, 'widget');
  mkdirSync(dir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [['init'], ['remote', 'add', 'origin', 'https://github.com/acme/widget.git']]) {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  return dir;
}

test('root and bare families print offline help with status zero', (t) => {
  const f = fixture(t);
  for (const args of [[], ['-h'], ['--help'], ['theme'], ['install'], ['scheme']]) {
    const result = run(args, f.env);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Usage:/);
  }

  const root = run([], f.env).stdout;
  for (const heading of ['Explore', 'Set up', 'Runtime']) {
    assert.equal(root.match(new RegExp(`^${heading}$`, 'gm'))?.length, 1);
  }
  for (const command of [
    'whoami [PATH]', 'theme list', 'theme add SOURCE', 'theme validate DIR', 'theme show [ID]', 'theme preview MEMBER', 'theme sheet',
    'scheme set dark|light', 'install pets', 'install opencode', 'hook EVENT', 'statusline', 'reap',
  ]) {
    assert.equal(root.split(command).length - 1, 1, command);
  }
  assert.deepEqual(readdirSync(f.state).sort(), ['sentinel']);
  assert.deepEqual(readdirSync(f.xdg).sort(), []);
});

const leaves = [
  ['whoami'], ['theme', 'list'], ['theme', 'add'], ['theme', 'show'], ['theme', 'preview'],
  ['theme', 'sheet'], ['theme', 'validate'], ['scheme', 'set'], ['install', 'pets'],
  ['install', 'opencode'], ['hook'], ['statusline'], ['reap'],
];

test('every leaf owns -h and --help before config or work', (t) => {
  const f = fixture(t);
  for (const leaf of leaves) for (const flag of ['-h', '--help']) {
    const result = run([...leaf, flag], f.env);
    assert.equal(result.status, 0, `${leaf.join(' ')} ${flag}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, leaf.join(' ') === 'theme add' ? /^Usage$/m : /Usage:/);
  }
  assert.deepEqual(readdirSync(f.state).sort(), ['sentinel']);
  assert.deepEqual(readdirSync(f.xdg).sort(), []);
});

test('help color changes headings only and honours NO_COLOR', (t) => {
  const plain = renderHelp('root');
  const colored = renderHelp('root', { color: true });
  assert.match(colored, /\x1b\[/);
  assert.equal(colored.replace(/\x1b\[[0-9;]*m/g, ''), plain);

  const f = fixture(t);
  const env = { ...f.env };
  delete env.NO_COLOR;
  const interactive = spawnSync(process.execPath, [ttyBin, '--help'], { encoding: 'utf8', env });
  assert.equal(interactive.status, 0, interactive.stderr);
  assert.match(interactive.stdout, /familiar — your coding agent gets a face/);
  assert.match(interactive.stdout, /\x1b\[/);

  env.NO_COLOR = '1';
  const uncolored = spawnSync(process.execPath, [ttyBin, '--help'], { encoding: 'utf8', env });
  assert.equal(uncolored.status, 0, uncolored.stderr);
  assert.match(uncolored.stdout, /familiar — your coding agent gets a face/);
  assert.doesNotMatch(uncolored.stdout, /\x1b\[/);
});

test('misplaced help flags reach strict parsing and point to the leaf', (t) => {
  const f = fixture(t);
  const result = run(['theme', 'preview', '--state', '--help'], f.env);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--state requires a value/i);
  assert.match(result.stderr, /familiar theme preview --help/);
  assert.deepEqual(readdirSync(f.state).sort(), ['sentinel']);
});

test('empty and flag-shaped inline option values fail before work', (t) => {
  const f = fixture(t);
  for (const [args, status, option, help] of [
    [['theme', 'preview', 'ginger', '--state=--help'], 1, '--state', 'theme preview'],
    [['install', 'pets', '--out='], 1, '--out', 'install pets'],
    [['statusline', '--with='], 0, '--with', 'statusline'],
  ]) {
    const result = run(args, f.env);
    assert.equal(result.status, status, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`${option} requires a value`));
    assert.match(result.stderr, new RegExp(`familiar ${help} --help`));
  }
  assert.deepEqual(readdirSync(f.state).sort(), ['sentinel']);
});

test('unknown commands point to the nearest help scope', (t) => {
  const f = fixture(t);
  for (const args of [['themes'], ['preview', 'ginger'], ['contact'], ['pets']]) {
    const root = run(args, f.env);
    assert.equal(root.status, 1, args.join(' '));
    assert.match(root.stderr, /unknown command/i);
    assert.match(root.stderr, new RegExp(args[0]));
    assert.match(root.stderr, /familiar --help/);
  }

  const family = run(['theme', 'cats'], f.env);
  assert.equal(family.status, 1);
  assert.match(family.stderr, /unknown theme command.*cats/i);
  assert.match(family.stderr, /familiar theme --help/);
});

test('whoami reports the resolver and proves selected assets', (t) => {
  const f = fixture(t);
  const repo = gitRepo(t);
  // The engine ships no art, so whoami is exercised against the committed
  // fixture pack, installed as a user theme (the same shadow mechanism a
  // real cats install uses).
  mkdirSync(join(f.config, 'themes'));
  cpSync(themeFixture, join(f.config, 'themes', 'fixture'), { recursive: true });
  writeFileSync(join(f.config, 'config.yaml'), 'theme: fixture\nmotion: full\n');
  writeFileSync(join(f.config, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));

  const result = run(['whoami', repo], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^widget$/m);
  assert.match(result.stdout, /^  theme\s+fixture$/m);
  assert.match(result.stdout, /^  slot\s+\d+ · hue \d+°$/m);
  assert.match(result.stdout, /^  member\s+.+ \([a-z0-9-]+\)$/m);

  const member = result.stdout.match(/^  member\s+.+ \(([a-z0-9-]+)\)$/m)?.[1];
  assert.ok(member, result.stdout);
  const broken = join(f.config, 'themes', 'broken');
  cpSync(themeFixture, broken, { recursive: true });
  writeFileSync(join(f.config, 'config.yaml'), 'theme: broken\nmotion: full\n');
  const missing = join(broken, 'sprites', member, 'idle.png');
  unlinkSync(missing);

  const failed = run(['whoami', repo], f.env);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, new RegExp(member));
  assert.match(failed.stderr, /idle/);
  assert.match(failed.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('current user and agent surfaces contain no retired CLI invocations', () => {
  // splitAway: true for a surface classified away from engine by the split
  // manifest (spec §1) — themes/cats/** to cats-main, tools/art/**,
  // docs/art/**, skills/art-discovery/** to forge — which carries no engine
  // copy at all once the repository splits, so its absence there is
  // expected rather than a defect. Every other surface is engine-owned and
  // must exist in ANY correctly composed tree, monolith or post-split; a
  // missing one is a real failure this scan must catch, not something to
  // shrug past.
  const currentSurfaces = [
    { path: 'README.md', splitAway: false },
    { path: 'docs/install.md', splitAway: false },
    { path: 'docs/art/discovery.md', splitAway: true },
    { path: 'docs/art/lessons.md', splitAway: true },
    { path: 'docs/surfaces.md', splitAway: false },
    { path: 'AGENTS.md', splitAway: false },
    { path: 'skills/art-discovery/SKILL.md', splitAway: true },
    { path: 'themes/cats/theme.yaml', splitAway: true },
    { path: 'tools/art/theme/scaffold.js', splitAway: true },
    { path: 'src', splitAway: false },
    { path: 'bin', splitAway: false },
    { path: 'test', splitAway: false },
  ];
  const oldRootLeaves = ['themes', 'preview', 'contact', 'pets'];
  const retired = new RegExp(
    `familiar (?:${oldRootLeaves.join('|')})\\b|tools/whoami\\.mjs|` +
    'familiar theme (?!list\\b|add\\b|validate\\b|show\\b|preview\\b|sheet\\b|--help\\b|<command>)',
    'u',
  );
  const textExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.md', '.yaml', '.yml']);
  const failures = [];

  function inspect(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (entry.isFile() && (
        textExtensions.has(extname(entry.name)) || (path === join(repoRoot, 'bin') && extname(entry.name) === '')
      )) {
        const name = relative(repoRoot, file);
        if (name === 'test/cli-help.test.js') continue;
        readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
          if (retired.test(line)) failures.push(`${name}:${index + 1}: ${line.trim()}`);
        });
      }
    }
  }

  for (const { path: surface, splitAway } of currentSurfaces) {
    const path = join(repoRoot, surface);
    if (!existsSync(path)) {
      // A split-away surface's absence is expected and this scan skips it
      // (its retired-CLI text, if any, is someone else's problem once it
      // lives in a different repo). An engine-owned surface's absence is
      // never expected — assert.ok fails LOUDLY here rather than letting
      // the scan silently pass having checked nothing.
      assert.ok(splitAway, `${surface} is engine-owned and must exist, but is missing`);
      continue;
    }
    if (extname(path)) {
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        if (retired.test(line)) failures.push(`${surface}:${index + 1}: ${line.trim()}`);
      });
    } else inspect(path);
  }
  assert.deepEqual(failures, []);
});
