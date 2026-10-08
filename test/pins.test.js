import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIdentities, loadIdentities, matchPin, pinnedMember } from '../src/bus/pins.js';
import { parseThemePack, memberOrThrow } from 'familiar-theme';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const catsThemeDir = join(REPO, 'themes', 'cats');

// The `members: { cats: X }` example inside parseIdentities' error message is a CLAIM
// ABOUT THE SHIPPED THEME, and nothing checked it. It said `maine-coon` — a deferred
// alternate that exists in no theme — so the message that corrected your config handed
// you a config that hard-errors one line later with `has no member "maine-coon"`.
//
// It rotted precisely because no test read it. This reads it: the member named in the
// guidance must be a member you can actually resolve.
//
// KILLS: renaming or dropping the member the message names, and any future edit that
// puts an aspirational example back. Mutation-verified — point the message at
// `maine-coon` again and this goes RED.
// GUARDED, not converted to the engine fixture: the claim under test is about
// the REAL shipped theme's roster (the error message hardcodes a real cats
// member name), which a synthetic pack cannot stand in for. Post-split the
// engine repo ships no themes/, so this skips there.
test(
  'the member named in the `member:` error message actually exists in the shipped theme',
  { skip: existsSync(catsThemeDir) ? false : 'themes/cats is not present in this checkout' },
  () => {
    let err;
    try {
      parseIdentities('identities:\n  - project: p\n    slot: 0\n    member: anything\n');
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'a `member:` pin must still be rejected — the message under test never fired');

    const named = /members: \{ cats: ([a-z0-9-]+) \}/.exec(err.message);
    assert.ok(named, `the message stopped naming a member — it now reads: ${err.message}`);

    const pack = parseThemePack(readFileSync(`${catsThemeDir}/theme.yaml`, 'utf8'), catsThemeDir);
    memberOrThrow(pack, named[1]);   // throws `theme "cats" has no member "..."` if aspirational
  },
);

// NOTE the path pin is absolute, matching the repoRoot fixture below. A `~/...`
// pin expands against the REAL $HOME, which no invented /home/k/... fixture can
// ever equal — the dedicated tilde test further down covers that separately.
const YAML = `
identities:
  - project: analysis
    slot: 0
  - remote: github.com/me/api
    slot: 6
    members:
      cats: maine-coon
  - path: /home/k/d/work/api
    slot: 9
`;

test('parses the three pin forms', () => {
  const { identities } = parseIdentities(YAML);
  assert.equal(identities.length, 3);
  assert.deepEqual(identities[1], {
    remote: 'github.com/me/api', slot: 6, members: { cats: 'maine-coon' },
  });
});

test('a path pin follows symlinks — a lexical compare would silently ignore the pin', () => {
  // git reports the PHYSICAL repo root; the user pins the symlink they cd
  // through. If matchPin compared strings, the pin the user wrote would match
  // nothing and they would never be told why.
  const catalog = parseIdentities('identities:\n  - path: /link/to/api\n    slot: 6\n');
  const realpath = (p) => (p === '/link/to/api' ? '/physical/api' : p);

  assert.equal(
    matchPin(catalog, { remote: null, repoRoot: '/physical/api', project: 'api' }, { realpath }).slot,
    6
  );
});

test('an out-of-range slot is a validation error, never clamped', () => {
  assert.throws(() => parseIdentities('identities:\n  - project: x\n    slot: 12\n'), /slot out of range: 12/);
  assert.throws(() => parseIdentities('identities:\n  - project: x\n    slot: -1\n'), /slot out of range: -1/);
});

test('a pin with no matcher names nothing and is a config error', () => {
  assert.throws(
    () => parseIdentities('identities:\n  - slot: 3\n'),
    /identity pin needs one of: remote, path, project/
  );
});

test('a missing identities.yaml is not an error — auto-assignment is the default', async () => {
  const readFile = async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  assert.deepEqual(await loadIdentities('/nowhere.yaml', { readFile }), { identities: [] });
});

test('match specificity is remote > path > project', () => {
  const catalog = parseIdentities(YAML);
  const ctx = { remote: 'github.com/me/api', repoRoot: '/home/k/d/work/api', project: 'api' };

  // All three could match; the remote wins.
  assert.equal(matchPin(catalog, ctx).slot, 6);

  // Without a remote, the exact path wins over any bare-basename alias.
  assert.equal(matchPin(catalog, { ...ctx, remote: null }).slot, 9);

  // A bare project pin is a deliberate alias: it matches ANY repo so named.
  assert.equal(
    matchPin(catalog, { remote: null, repoRoot: '/anywhere/analysis', project: 'analysis' }).slot,
    0
  );
});

test('a path pin matches a repo that HAS a remote — the case that would silently fail if the match context were reconstructed from projectKey', () => {
  // projectKeyFor collapses to `remote` whenever a repo has one, discarding
  // repoRoot entirely. If matchPin tried to work backward from a projectKey
  // instead of taking { remote, repoRoot, project } explicitly, a path pin
  // could never match any repo with a remote — silently, since the remote
  // here matches no pin and there is nothing to report. repoRoot must survive
  // independently of remote for this match to succeed.
  const catalog = parseIdentities('identities:\n  - path: /home/k/d/work/other\n    slot: 4\n');
  const realpath = (p) => p;
  assert.equal(
    matchPin(
      catalog,
      { remote: 'github.com/someone/unrelated', repoRoot: '/home/k/d/work/other', project: 'other' },
      { realpath }
    ).slot,
    4
  );
});

test('an unpinned project matches nothing and falls through to its hashed slot', () => {
  const catalog = parseIdentities(YAML);
  assert.equal(matchPin(catalog, { remote: null, repoRoot: '/x/other', project: 'other' }), null);
});

test('path pins expand ~ so the config can be written the way a human writes it', () => {
  const catalog = parseIdentities('identities:\n  - path: ~/code/work/api\n    slot: 9\n');
  const home = process.env.HOME;
  assert.equal(matchPin(catalog, { remote: null, repoRoot: `${home}/code/work/api`, project: 'api' }).slot, 9);
});

test('member pins are theme-scoped: a pin for an inactive theme is inert', () => {
  const pin = { remote: 'github.com/me/api', slot: 6, members: { cats: 'maine-coon' } };
  assert.equal(pinnedMember(pin, 'cats'), 'maine-coon');
  assert.equal(pinnedMember(pin, 'elements'), null);   // inert, NOT an error
  assert.equal(pinnedMember({ slot: 6 }, 'cats'), null);
});

// --- Worktree inheritance: the repository's choices reach its worktrees -----
//
// Tiers, each over the whole catalog with its first entry winning: effective remote, exact
// current checkout path, inherited repository path, exact current checkout name, inherited
// repository name (never `.git`). The winning entry is returned whole: its slot and members.

const MAIN = '/fixture/api';
const TREE = '/fixture/fix-api';
const identity = (p) => p;
const linked = (over = {}) => ({
  remote: null, repoRoot: TREE, repositoryRoot: MAIN, project: 'fix-api', ...over,
});

test('worktree path wins within path tier and remote still wins overall', () => {
  const main = '/fixture/api';
  const tree = '/fixture/fix-api';
  const context = { remote: 'github.com/example/api',
    repoRoot: tree, repositoryRoot: main, project: 'fix-api' };
  const pins = [
    { project: 'api', slot: 0 },
    { project: 'fix-api', slot: 1 },
    { path: main, slot: 7 },
    { path: tree, slot: 3 },
    { remote: 'github.com/example/api', slot: 6 },
  ];
  const realpath = (p) => p;
  const slot = (catalog) => matchPin({ identities: catalog }, context, { realpath }).slot;
  assert.equal(slot(pins), 6);
  assert.equal(slot(pins.slice(0, 4)), 3);
  assert.equal(slot(pins.slice(0, 3)), 7);
  assert.equal(slot(pins.slice(0, 2)), 1);
  assert.equal(slot(pins.slice(0, 1)), 0);
});

test('within an inherited tier the first catalog entry wins', () => {
  const first = { path: MAIN, slot: 7 };
  const second = { path: MAIN, slot: 2 };
  const match = (pins) => matchPin({ identities: pins }, linked(), { realpath: identity });
  assert.equal(match([first, second]), first);
  assert.equal(match([second, first]), second);

  const nameA = { project: 'fix-api', slot: 4 };
  const nameB = { project: 'fix-api', slot: 5 };
  assert.equal(match([nameA, nameB]), nameA);
  assert.equal(match([nameB, nameA]), nameB);
});

test('a combined-selector entry is returned whole from whichever tier it wins', () => {
  const combined = {
    remote: 'github.com/example/api', path: MAIN, project: 'api', slot: 6,
    members: { cats: 'schrodingers-cat' },
  };
  const pins = [{ project: 'fix-api', slot: 1 }, combined];
  const match = (context) => matchPin({ identities: pins }, context, { realpath: identity });
  assert.equal(match(linked({ remote: 'github.com/example/api' })), combined);
  // No remote: the inherited path tier still outranks the earlier current-name entry.
  assert.equal(match(linked()), combined);
  assert.deepEqual(match(linked()).members, { cats: 'schrodingers-cat' });
});

test('outside a repository only the remote and the current name can match', () => {
  const pins = [{ path: '/tmp/scratch', slot: 2 }, { project: 'scratch', slot: 8 }];
  const context = { remote: null, repoRoot: null, repositoryRoot: null, project: 'scratch' };
  assert.equal(matchPin({ identities: pins }, context, { realpath: identity }).slot, 8);
  assert.equal(matchPin({ identities: pins.slice(0, 1) }, context, { realpath: identity }), null);
});

test('inherited and current paths are both canonicalized', () => {
  const links = { '/links/api': MAIN, '/links/fix': TREE };
  const realpath = (p) => links[p] ?? p;
  assert.equal(matchPin({ identities: [{ path: '/links/api', slot: 7 }] }, linked(), { realpath }).slot, 7);
  assert.equal(matchPin({ identities: [{ path: '/links/api', slot: 7 }, { path: '/links/fix', slot: 3 }] },
    linked(), { realpath }).slot, 3);
});

test('a main checkout evaluates its path and name once', () => {
  const pinned = '/elsewhere/other';
  let calls = 0;
  const realpath = (p) => {
    if (p === pinned) calls += 1;
    return p;
  };
  const context = { remote: null, repoRoot: MAIN, repositoryRoot: MAIN, project: 'api' };
  const pins = [{ path: pinned, slot: 2 }, { project: 'api', slot: 9 }];
  assert.equal(matchPin({ identities: pins }, context, { realpath }).slot, 9);
  assert.equal(calls, 1, 'the shared root is not matched a second time as the inherited tier');
});

test('a bare .git anchor contributes no inherited name; other names stay verbatim', () => {
  const bareDotGit = linked({ repositoryRoot: '/fixture/.git', project: 'tree' });
  assert.equal(matchPin({ identities: [{ project: '.git', slot: 5 }] }, bareDotGit,
    { realpath: identity }), null);

  const bare = linked({ repositoryRoot: '/fixture/familiar.git', project: 'tree' });
  const suffixed = { project: 'familiar.git', slot: 2 };
  assert.equal(matchPin({ identities: [{ project: 'familiar', slot: 1 }, suffixed] }, bare,
    { realpath: identity }), suffixed);
  assert.equal(matchPin({ identities: [{ project: 'familiar', slot: 1 }] }, bare,
    { realpath: identity }), null);

  // An exact checkout name is untouched, even one actually named .git.
  const named = linked({ repoRoot: '/fixture/.git', project: '.git' });
  assert.equal(matchPin({ identities: [{ project: '.git', slot: 5 }] }, named,
    { realpath: identity }).slot, 5);
});

test('the inherited name tier yields to the current name and to both paths', () => {
  const pins = [{ project: 'api', slot: 0 }];
  assert.equal(matchPin({ identities: pins }, linked(), { realpath: identity }).slot, 0);
  assert.equal(matchPin({ identities: [...pins, { project: 'fix-api', slot: 1 }] }, linked(),
    { realpath: identity }).slot, 1);
  assert.equal(matchPin({ identities: [...pins, { path: MAIN, slot: 7 }] }, linked(),
    { realpath: identity }).slot, 7);
  assert.equal(matchPin({ identities: [{ project: 'other', slot: 3 }] }, linked(),
    { realpath: identity }), null);
});
