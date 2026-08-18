import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listThemes, stagingStatus } from '../src/theme/catalog.js';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliColor, cliSwatch } from '../bin/familiar';
import { SLOT_COUNT, ROW_MIN, ROW_MAX, STATES, encodeRgba } from 'familiar-theme';

// Injected roots. Nothing here touches disk: catalog.js takes `readdir` and
// `exists` so the enumeration rules can be tested without building a tree.
const paths = { themesDir: '/repo/themes', userThemesDir: '/cfg/themes' };

// Dirent-LIKE, not bare strings: catalog.js reads dirents (readdirSync with
// withFileTypes) so it can tell a stray file from a theme directory without
// opening it. A plain string entry here is shorthand for "a directory named
// this"; a caller wanting to fake a stray FILE passes an explicit dirent.
function direntFor(entry) {
  return typeof entry === 'string' ? { name: entry, isDirectory: () => true } : entry;
}
function file(name) {
  return { name, isDirectory: () => false };
}

function fake(shipped = [], user = []) {
  return {
    readdir: (dir) => {
      if (dir === paths.themesDir) return shipped.map(direntFor);
      if (dir === paths.userThemesDir) return user.map(direntFor);
      throw Object.assign(new Error('unexpected dir'), { code: 'ENOENT' });
    },
    exists: (dir) => dir === paths.themesDir || dir === paths.userThemesDir,
  };
}

test('a shipped theme is listed from the shipped root', () => {
  assert.deepEqual(listThemes(paths, fake(['cats'])), [
    { id: 'cats', dir: '/repo/themes/cats', source: 'shipped', shadowed: false },
  ]);
});

test('a user theme is listed from the user root', () => {
  assert.deepEqual(listThemes(paths, fake([], ['ember'])), [
    { id: 'ember', dir: '/cfg/themes/ember', source: 'user', shadowed: false },
  ]);
});

// The whole point of the shadowing rule: themeDirFor returns the USER dir when
// it exists, so a listing that showed both would describe a resolution that
// cannot happen. One id resolves to exactly one directory.
test('a user theme shadowing a shipped one collapses to a single user entry', () => {
  assert.deepEqual(listThemes(paths, fake(['cats'], ['cats'])), [
    { id: 'cats', dir: '/cfg/themes/cats', source: 'user', shadowed: true },
  ]);
});

test('entries are sorted by id regardless of readdir order', () => {
  const rows = listThemes(paths, fake(['zebra', 'cats'], ['ember']));
  assert.deepEqual(rows.map((r) => r.id), ['cats', 'ember', 'zebra']);
});

// An absent user themes dir is the DEFAULT state — nobody has authored a theme
// yet. It is not an error and must not become one.
test('an absent user themes dir yields the shipped themes alone', () => {
  const io = {
    readdir: (dir) => {
      if (dir === paths.themesDir) return [direntFor('cats')];
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    },
    exists: (dir) => dir === paths.themesDir,
  };
  assert.deepEqual(listThemes(paths, io).map((r) => r.id), ['cats']);
});

// Fail early, with the offending name. A directory that cannot be a theme id
// cannot be resolved by themeDirFor either, so silently skipping it would hide
// a theme the user believes they installed.
test('a directory name that is not a valid theme id is refused by name', () => {
  assert.throws(
    () => listThemes(paths, fake(['Cats'])),
    /Cats/,
  );
});

// FIX 3: a stray FILE — .DS_Store, .gitkeep, a downloaded theme.tar.gz left in
// either themes root — is not a theme, full stop. Every entry used to be fed
// to assertId regardless of file type, so a stray file bricked all three
// browsing verbs. A file is skipped; a directory with a bad name is still a
// named error (that rule does not change — see the test above).
test('a stray file in a themes root is skipped, not treated as a theme id', () => {
  const rows = listThemes(paths, fake(['cats', file('.DS_Store')], [file('theme.tar.gz')]));
  assert.deepEqual(rows.map((r) => r.id), ['cats']);
});

test('.staging is reserved: excluded from ids, other dot-dirs still error', () => {
  const rows = listThemes(paths, fake([], ['cats', '.staging']));
  assert.deepEqual(rows.map((r) => r.id), ['cats']);
  assert.throws(() => listThemes(paths, fake([], ['.other'])), /\.other/);
});

test('stagingStatus: absent, empty, occupied', () => {
  const enoent = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  const dir = { isDirectory: () => true };
  assert.equal(stagingStatus(paths, { lstat: enoent, readdir: () => [] }), 'absent');
  assert.equal(stagingStatus(paths, { lstat: () => dir, readdir: () => [] }), 'empty');
  assert.equal(stagingStatus(paths, { lstat: () => dir, readdir: () => ['run-x'] }), 'occupied');
});

test('stagingStatus: a symlink or file is not-a-directory and is never read', () => {
  const notDir = { isDirectory: () => false };
  const readdir = () => { throw new Error('must not be called'); };
  assert.equal(stagingStatus(paths, { lstat: () => notDir, readdir }), 'not-a-directory');
});

const bin = fileURLToPath(new URL('../bin/familiar', import.meta.url));
const ttyBin = fileURLToPath(new URL('fixtures/tty-familiar.mjs', import.meta.url));
const runTty = (args, options) => spawnSync(process.execPath, [ttyBin, ...args], options);
const themeFixture = fileURLToPath(new URL('../test/fixtures/theme-pack', import.meta.url));

// The engine ships no art: FAMILIAR_THEMES_DIR (src/bus/paths.js) redirects
// the SHIPPED themes root away from the repo's own themes/ (absent
// post-split) to this once-built fixture root, where the committed pack is
// installed under the "cats" id — the id every test below that does not pass
// its own `theme` still resolves to by default. Built once and reused.
const shippedThemesFixture = mkdtempSync(join(tmpdir(), 'familiar-catalog-shipped-'));
cpSync(themeFixture, join(shippedThemesFixture, 'cats'), { recursive: true });

// A second, independently-generated theme with two members (able covering
// eleven slots, baker covering the twelfth) — the engine fixture is
// deliberately single-member, so it cannot stand in for a test whose whole
// point is fault isolation ACROSS members. Self-authored, so this needs no
// real art either.
function writeTwoMemberTheme(dir) {
  const buf = Buffer.alloc(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      buf[i] = 150;
      if (x >= 1 && x <= 6 && y >= 1) buf[i + 3] = 255;
    }
  }
  const png = encodeRgba({ w: 8, h: 8, buf });
  const poseBlock = STATES.map((state) => `      ${state}: flat grey square`).join('\n');
  for (const [member, slots] of [
    ['able', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
    ['baker', [11]],
  ]) {
    const spritesDir = join(dir, 'sprites', member);
    mkdirSync(spritesDir, { recursive: true });
    for (const state of STATES) writeFileSync(join(spritesDir, `${state}.png`), png);
  }
  writeFileSync(join(dir, 'theme.yaml'), [
    'spec-version: 1',
    'id: broken',
    'label: Broken',
    'rows: 4',
    'members:',
    '  - id: able',
    '    asset-root: sprites/able',
    '    label: Able',
    '    slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]',
    '    persona: covers eleven slots so removing baker still leaves eleven',
    '    animation:',
    '      kind: static',
    '    poses:',
    poseBlock,
    '  - id: baker',
    '    asset-root: sprites/baker',
    '    label: Baker',
    '    slots: [11]',
    '    persona: the one member whose sprite directory gets removed',
    '    animation:',
    '      kind: static',
    '    poses:',
    poseBlock,
    '',
  ].join('\n'));
}

// A config dir with a scheme already written, because every verb that reaches
// context() calls loadTone(), which throws by design when no scheme exists.
// Kitty graphics are OFF unless the environment advertises them, so a test that
// wants to see art must say so. graphicsCapability() returns ANIMATION for
// TERM=xterm-kitty, and NONE whenever TMUX is set or TERM starts with
// screen/tmux — so the multiplexer markers are cleared too, or the suite fails
// inside tmux for a reason that has nothing to do with themes.
const GRAPHICAL = { graphical: true };

function cliEnv({ theme, userThemes = {}, graphical = false } = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'familiar-catalog-cfg-'));
  writeFileSync(join(configDir, 'scheme.json'), JSON.stringify({ mode: 'dark', satScale: 1 }));
  if (theme) writeFileSync(join(configDir, 'config.yaml'), `theme: ${theme}\n`);
  for (const [id, from] of Object.entries(userThemes)) {
    mkdirSync(join(configDir, 'themes'), { recursive: true });
    cpSync(from, join(configDir, 'themes', id), { recursive: true });
  }
  const env = {
    ...process.env,
    FAMILIAR_CONFIG_DIR: configDir,
    FAMILIAR_STATE_DIR: mkdtempSync(join(tmpdir(), 'familiar-catalog-state-')),
    FAMILIAR_THEMES_DIR: shippedThemesFixture,
  };
  delete env.NO_COLOR;
  delete env.TMUX;
  if (graphical) env.TERM = 'xterm-kitty';
  else { delete env.TERM; delete env.KITTY_WINDOW_ID; delete env.TERM_PROGRAM;
         delete env.GHOSTTY_RESOURCES_DIR; delete env.GHOSTTY_BIN_DIR; }
  return env;
}

test('familiar theme list names the shipped theme active', () => {
  const result = spawnSync(process.execPath, [bin, 'theme', 'list'], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}cats {8}active {4}Fixture/m);
  assert.match(result.stdout, / 1 members/);
  assert.match(result.stdout, /shipped/);
});

// An inactive theme keeps the fixed status column blank, so its details align
// with the active row and with any description continuation below it.
//
// The fixture also pins a real distinction: the copied directory is named
// `spare` while the theme.yaml inside it still says `id: fixture`. themeDirFor
// resolves by DIRECTORY name, so the directory is what the listing must print.
test('a theme that is not active has a blank status and aligns its description', () => {
  const env = cliEnv({ theme: 'cats', userThemes: { spare: themeFixture } });
  const descriptor = join(env.FAMILIAR_CONFIG_DIR, 'themes', 'spare', 'theme.yaml');
  writeFileSync(descriptor, `${readFileSync(descriptor, 'utf8')}\ndescription: Spare roster\n`);
  const result = spawnSync(process.execPath, [bin, 'theme', 'list'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}cats {8}active {4}Fixture/m);
  assert.match(result.stdout, /^ {2}spare {7} {10}Fixture/m);
  assert.match(result.stdout, /^ {24}Spare roster$/m);
});

test('an unreadable active theme still prints active on its row', () => {
  const broken = mkdtempSync(join(tmpdir(), 'familiar-unreadable-theme-'));
  const env = cliEnv({ theme: 'broken', userThemes: { broken } });
  const result = spawnSync(process.execPath, [bin, 'theme', 'list'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}broken {6}active {4}— unreadable:/m);
});

// FIX 3, at the CLI: a stray file left in the user themes root (a downloaded
// theme.tar.gz, a .DS_Store) must not brick a working command. `preview`
// reached themes through themeDirFor before catalog.js's idsIn existed, so
// this is a NEW way for a working command to break, and the one this test
// targets directly.
test('a stray file in the user themes root does not brick themes, theme, or preview', () => {
  const env = cliEnv({ theme: 'cats' });
  mkdirSync(join(env.FAMILIAR_CONFIG_DIR, 'themes'), { recursive: true });
  writeFileSync(join(env.FAMILIAR_CONFIG_DIR, 'themes', 'theme.tar.gz'), 'not a theme');

  const themes = spawnSync(process.execPath, [bin, 'theme', 'list'], { encoding: 'utf8', env });
  assert.equal(themes.status, 0, themes.stderr);
  assert.match(themes.stdout, /cats/);

  const theme = spawnSync(process.execPath, [bin, 'theme', 'show'], { encoding: 'utf8', env });
  assert.equal(theme.status, 0, theme.stderr);

  const preview = spawnSync(process.execPath, [bin, 'theme', 'preview', 'pip'], { encoding: 'utf8', env });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Pip · cats · slots 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11/);
});

test('familiar theme list reports a user theme that shadows a shipped one', () => {
  const env = cliEnv({ userThemes: { cats: themeFixture } });
  const result = spawnSync(process.execPath, [bin, 'theme', 'list'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shadows shipped/);
  // One row, not two: the shipped copy is unreachable while the user one exists.
  //
  // THE ID FIELD, NOT THE WHOLE LINE. This counted /\bcats\b/ and passed for as
  // long as `cats` was the only shipped theme — then `cats-v2` shipped alongside
  // it and this read two rows, because `-` is a word boundary and \bcats\b
  // matches inside "cats-v2". That roster has since been promoted INTO `cats` and
  // the old one retired, so the tree is back to one theme and the naive pattern
  // would pass again — which is exactly why the anchor stays. The listing prints
  // the id first, padded, so anchoring to the start
  // of the row and requiring whitespace after the id counts rows for THIS theme
  // and no other. A shadowing assertion that grows a false positive every time a
  // theme is added with a related name is measuring the roster, not the shadow.
  const rows = result.stdout.split('\n').filter((l) => /^ {2}cats {8}active {4}/.test(l));
  assert.equal(rows.length, 1, `expected one \`cats\` row, got:\n${result.stdout}`);
});

// maxBuffer, and it is NOT a nicety (see the identical note in
// test/bin-familiar.test.js). `theme` transmits all twelve of the shipped
// cats theme's idle masters in one process: ~1.6 MB raw, ~2.1 MB base64 on
// the wire — well past spawnSync's 1 MiB default, which truncates stdout and
// sets status to null. Every GRAPHICAL call below needs the same raise.
const THEME_MAX_BUFFER = 64 * 1024 * 1024;

// FIX 2: graphicsCapability returns NONE for a plain TERM and for any tmux
// session (src/render/term/capability.js). The verb's entire value is the
// art, so a human looking at a bare slot listing in tmux needs to be told
// that is not the full view — one stderr line naming the capability.
test('familiar theme show without graphics names the capability on stderr', () => {
  const result = runTty(['theme', 'show'], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /familiar: .*\bnone\b.*art/i);
  assert.match(result.stdout, /Fixture/);
  assert.doesNotMatch(result.stdout, /\x1b_G/);
});

// preview is deliberately silent about this (it prints poses and no escapes,
// and test/bin-familiar.test.js pins that) — only theme gets the notice.
test('familiar theme show WITH graphics prints no capability notice', () => {
  const result = runTty(['theme', 'show'], {
    encoding: 'utf8', env: cliEnv(GRAPHICAL), maxBuffer: THEME_MAX_BUFFER,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('familiar theme show prints one row per slot for the active theme', () => {
  const result = runTty(['theme', 'show'], {
    encoding: 'utf8', env: cliEnv(GRAPHICAL), maxBuffer: THEME_MAX_BUFFER,
  });
  assert.equal(result.status, 0, result.stderr);
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    assert.match(result.stdout, new RegExp(`^\\s*${slot}\\s`, 'm'), `slot ${slot} missing`);
  }
});

// THE LOAD-BEARING ASSERTION, and the one an earlier draft of this plan omitted.
// Slot numbers are text; a version of this verb that printed twelve labels and
// no art would satisfy every other test here while being useless as the cohesion
// decision surface. Assert the kitty transmissions themselves.
test('familiar theme show transmits one image per slot', () => {
  const result = runTty(['theme', 'show'], {
    encoding: 'utf8', env: cliEnv(GRAPHICAL), maxBuffer: THEME_MAX_BUFFER,
  });
  assert.equal(result.status, 0, result.stderr);
  // transmit() opens every image with the APC graphics introducer and a=T.
  const transmissions = result.stdout.match(/\x1b_Ga=T,/g) ?? [];
  assert.equal(transmissions.length, SLOT_COUNT);
});

// FIX 1: the build workflow writes all twelve member blocks up front and fills
// sprites one at a time, so every intermediate state of a theme under
// construction has twelve members and fewer than twelve sprite sets. A single
// faulted member (here: baker's whole sprite directory removed, which
// loadThemePackSync records as an assetRootFault) must not abort the view —
// the other eleven slots still have to draw. The engine fixture is
// single-member and cannot prove fault ISOLATION across members, so this
// uses its own two-member pack instead of either the fixture or real cats.
test('a theme with one members sprite directory removed still renders the other eleven slots', () => {
  const brokenSrc = mkdtempSync(join(tmpdir(), 'familiar-broken-theme-'));
  writeTwoMemberTheme(brokenSrc);
  rmSync(join(brokenSrc, 'sprites', 'baker'), { recursive: true, force: true });

  const env = cliEnv({ userThemes: { broken: brokenSrc }, graphical: true });
  const result = runTty(['theme', 'show', 'broken'], {
    encoding: 'utf8', env, maxBuffer: THEME_MAX_BUFFER,
  });

  assert.equal(result.status, 0, result.stderr);
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    assert.match(result.stdout, new RegExp(`^\\s*${slot}\\s`, 'm'), `slot ${slot} missing`);
  }
  // baker is slot 11 — its row must name the fault, not silently vanish or crash.
  assert.match(result.stdout, /baker/);
  // Eleven good slots still transmit their art; the broken one does not.
  const transmissions = result.stdout.match(/\x1b_Ga=T,/g) ?? [];
  assert.equal(transmissions.length, SLOT_COUNT - 1);
});

test('each slot row carries a coloured hue swatch', () => {
  const result = runTty(['theme', 'show'], {
    encoding: 'utf8', env: cliEnv(GRAPHICAL), maxBuffer: THEME_MAX_BUFFER,
  });
  // sgr.fg() emits a 24-bit foreground sequence; the swatch is a block glyph in it.
  assert.match(result.stdout, /\x1b\[38;2;\d+;\d+;\d+m█/);
});

test('--rows lowers the render height so more of the roster fits', () => {
  const tall = runTty(['theme', 'show'], {
    encoding: 'utf8', env: cliEnv(GRAPHICAL), maxBuffer: THEME_MAX_BUFFER,
  }).stdout;
  const short = runTty(['theme', 'show', '--rows', '2'], {
    encoding: 'utf8', env: cliEnv(GRAPHICAL), maxBuffer: THEME_MAX_BUFFER,
  }).stdout;
  assert.ok(short.split('\n').length < tall.split('\n').length);
  assert.match(short, /r=2,/);
});

test('redirected theme output is plain and quiet', () => {
  const result = spawnSync(process.execPath, [bin, 'theme', 'show'], {
    encoding: 'utf8', env: cliEnv(GRAPHICAL), maxBuffer: THEME_MAX_BUFFER,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\x1b(?:\[|_G)/);
  assert.doesNotMatch(result.stderr, /graphics|art was drawn/i);
  assert.match(result.stdout, /#[0-9a-f]{6}/i);
  assert.match(result.stdout, /Pip/);
});

test('CLI color requires a TTY and honours NO_COLOR', () => {
  assert.equal(cliColor({ stream: { isTTY: false }, env: {} }), false);
  assert.equal(cliColor({ stream: { isTTY: true }, env: { NO_COLOR: '' } }), true);
  assert.equal(cliColor({ stream: { isTTY: true }, env: { NO_COLOR: '1' } }), false);
  assert.equal(cliColor({ stream: { isTTY: true }, env: {} }), true);
  assert.equal(cliSwatch('#112233', { color: false }), '#112233');
  assert.match(cliSwatch('#112233', { color: true }), /\x1b\[38;2;17;34;51m███/);
});

test('NO_COLOR keeps interactive kitty art but removes SGR swatches', () => {
  const env = cliEnv(GRAPHICAL);
  env.NO_COLOR = '1';
  const result = runTty(['theme', 'show'], { encoding: 'utf8', env, maxBuffer: THEME_MAX_BUFFER });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/\x1b_Ga=T,/g) ?? []).length, SLOT_COUNT);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

// FIX 4: `--rows` bounds must come from familiar-theme's ROW_MIN/ROW_MAX, not
// a second hand-copied "1 and 40" — pack.js's own comment on ROW_MIN/ROW_MAX
// names this exact defect: a second copy of the bound is free to drift from
// the one the parser enforces. bin/familiar already imports from
// familiar-theme, so there is no reason for the CLI's own error message to
// spell the numbers again. This is a source-level invariant (the numbers
// happen to already agree, so no runtime input distinguishes a copy from the
// real constants) — asserted the same way test/seam.test.js asserts its own
// no-drift rules.
test('--rows bounds are read from familiar-theme, not copied as literal numbers', () => {
  const text = readFileSync(fileURLToPath(new URL('../bin/familiar', import.meta.url)), 'utf8');
  assert.match(
    text,
    /import\s*\{[^}]*\bROW_MIN\b[^}]*\bROW_MAX\b[^}]*\}\s*from\s*['"]familiar-theme['"]/,
    'bin/familiar does not import ROW_MIN/ROW_MAX from familiar-theme',
  );
  const rowsCheck = text.slice(text.indexOf('viewRows'), text.indexOf('viewRows') + 400);
  assert.ok(rowsCheck.includes('ROW_MIN') && rowsCheck.includes('ROW_MAX'),
    'the --rows bound check does not reference ROW_MIN/ROW_MAX');
  assert.ok(!/between 1 and 40/.test(text),
    'the --rows error message still hand-copies "between 1 and 40" instead of interpolating the constants');
});

test("--rows out of familiar-theme's bounds is refused, naming ROW_MIN and ROW_MAX", () => {
  const tooLow = spawnSync(process.execPath, [bin, 'theme', 'show', '--rows', String(ROW_MIN - 1)], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.match(tooLow.stderr, new RegExp(`between ${ROW_MIN} and ${ROW_MAX}`));

  const tooHigh = spawnSync(process.execPath, [bin, 'theme', 'show', '--rows', String(ROW_MAX + 1)], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.match(tooHigh.stderr, new RegExp(`between ${ROW_MIN} and ${ROW_MAX}`));
});

// The point of the verb: judging a theme you have not switched to. The header
// names the DIRECTORY, because that is what resolves — the copied pack's own
// theme.yaml still says `id: fixture`.
test('familiar theme show renders a named theme that is not active', () => {
  const env = cliEnv({ userThemes: { spare: themeFixture } });
  const result = spawnSync(process.execPath, [bin, 'theme', 'show', 'spare'], {
    encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /spare/);
});

// Fail early, and name what WAS available — a typo'd id is the common case.
test('familiar theme show names the unknown id and lists the known ones', () => {
  const result = spawnSync(process.execPath, [bin, 'theme', 'show', 'nope'], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.match(result.stderr, /nope/);
  assert.match(result.stderr, /cats/);
});

// FIX 5: `familiar theme` had no argument discipline at all — a trailing
// positional and a duplicate --rows were both discarded in silence.
// `preview` already rejects unknown flags, missing values, duplicates, and
// trailing positionals by name; `theme` gets the same discipline for its own
// shape (one optional positional, one optional flag) without importing
// preview's parser wholesale.
test('familiar theme show refuses a trailing positional argument', () => {
  const result = spawnSync(process.execPath, [bin, 'theme', 'show', 'cats', 'extra'], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.match(result.stderr, /unexpected argument/);
  assert.match(result.stderr, /extra/);
});

test('familiar theme show refuses a positional beginning with -- as an unknown flag', () => {
  const result = spawnSync(process.execPath, [bin, 'theme', 'show', '--bogus'], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.match(result.stderr, /unknown option/i);
  assert.match(result.stderr, /--bogus/);
  assert.match(result.stderr, /familiar theme show --help/);
});

test('familiar theme show refuses a repeated --rows flag', () => {
  const result = spawnSync(process.execPath, [bin, 'theme', 'show', '--rows', '2', '--rows', '3'], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.match(result.stderr, /duplicate --rows/);
});

test('preview accepts a theme that is not active', () => {
  const env = cliEnv({ userThemes: { spare: themeFixture } });
  const result = spawnSync(
    process.execPath, [bin, 'theme', 'preview', 'pip', '--theme', 'spare'],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Pip · spare · slots 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11/);
});

test('preview --state shows exactly the named state', () => {
  const result = spawnSync(
    process.execPath, [bin, 'theme', 'preview', 'pip', '--state', 'error'],
    { encoding: 'utf8', env: cliEnv() },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /error:/);
  assert.doesNotMatch(result.stdout, /needs-approval:/);
});

// No defaults, and the error names the six legal values — a misspelled state
// silently showing all six would look like the flag was ignored.
test('preview names an unknown state and lists the legal ones', () => {
  const result = spawnSync(
    process.execPath, [bin, 'theme', 'preview', 'pip', '--state', 'sleeping'],
    { encoding: 'utf8', env: cliEnv() },
  );
  assert.match(result.stderr, /sleeping/);
  assert.match(result.stderr, /needs-approval/);
});

// THE SILENT FALLBACK. An index lookup returns undefined for a trailing flag,
// and undefined resolved to the active theme — the user asked for one thing,
// got another, and was told nothing.
test('preview refuses --theme with no value instead of falling back', () => {
  const result = spawnSync(
    process.execPath, [bin, 'theme', 'preview', 'pip', '--theme'],
    { encoding: 'utf8', env: cliEnv() },
  );
  assert.match(result.stderr, /--theme <value>.*missing/i);
});

test('preview refuses an unknown flag and points to its help', () => {
  const result = spawnSync(
    process.execPath, [bin, 'theme', 'preview', 'pip', '--thmee', 'cats'],
    { encoding: 'utf8', env: cliEnv() },
  );
  assert.match(result.stderr, /--thmee/);
  assert.match(result.stderr, /familiar theme preview --help/);
});

test('preview refuses a duplicate flag', () => {
  const result = spawnSync(
    process.execPath, [bin, 'theme', 'preview', 'pip', '--state', 'idle', '--state', 'error'],
    { encoding: 'utf8', env: cliEnv() },
  );
  assert.match(result.stderr, /duplicate --state/);
});

test('preview refuses a trailing positional argument', () => {
  const result = spawnSync(
    process.execPath, [bin, 'theme', 'preview', 'pip', 'extra'],
    { encoding: 'utf8', env: cliEnv() },
  );
  assert.match(result.stderr, /unexpected argument/);
});

// FIX 8: the error boundary exited 0 for every command but `pets`, which made
// these three human-invoked browsing verbs impossible to script against —
// `familiar theme show nope` printed its error and still reported success. The
// boundary's own rationale (`hook` runs on every tool call of the user's
// coding agent, so a cosmetic layer must never degrade the tool it decorates)
// does not cover a human typing `familiar theme show nope` at a prompt.
test('familiar theme list exits non-zero on error, unlike the cosmetic hook path', () => {
  const env = cliEnv();
  writeFileSync(join(env.FAMILIAR_CONFIG_DIR, 'config.yaml'), 'motion: sideways\n');
  const result = spawnSync(process.execPath, [bin, 'theme', 'list'], { encoding: 'utf8', env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /motion/);
});

test('familiar theme show exits non-zero on an unknown id', () => {
  const result = spawnSync(process.execPath, [bin, 'theme', 'show', 'nope'], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nope/);
});

test('familiar theme preview exits non-zero on an unknown member', () => {
  const result = spawnSync(process.execPath, [bin, 'theme', 'preview', 'nobody'], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /nobody/);
});
