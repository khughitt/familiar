# Codex pet convergence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `<repo>/.codex/config.toml` a self-maintaining artifact, so a Codex session in any repository converges on the same familiar every other surface already resolves.

**Architecture:** The Codex `SessionStart` hook resolves identity anyway (to put the session on the bus). After that resolve, it compares the resolved member against this one repository's managed config and rewrites it when they disagree — gated on the target pet's assets actually being installed for the active theme. Planning is scoped to a single repository; asset compilation stays offline in `install pets`, which gains a per-pet stamp recording what it compiled from.

**Tech Stack:** Node 26, ESM, `node:test` + `node:assert/strict`, `familiar-theme` (vendored via node_modules), no new dependencies.

**Spec:** `docs/specs/2026-09-05-codex-identity-parity-design.md`

## Global Constraints

- **The hook path must stay bounded.** No content hashing, no PNG decode, no new `git` subprocesses on the no-op path. The only new per-`SessionStart` work when nothing has changed is **one small file read**; the write preflight (which spawns `git`) runs only after a mismatch is proven. Rationale: the timeout argument at the top of `src/bus/identity.js`.
- **Reuse what the transaction already resolved.** `applyHookEvent` returns `next`, the record it just wrote, carrying `remote`, `repoRoot` and `cwd`; the resolved member is at `intent[next.sessionId].current.identity.member`. Re-deriving either in the hook means a second `gitContext` (two subprocesses) and a second pin sweep, for an answer already in hand.
- **Never rewrite a config Familiar does not own.** Managed means the file matches `MANAGED_CONFIG` in `src/install/codex.js` (the header plus a single `[tui] pet` line). Tracked configs, symlinks, non-regular files, and the user-wide config are all refused, exactly as today.
- **One repository, one blast radius.** Nothing invoked from a hook may plan, refuse, or write on behalf of any other project.
- **Deferred, not in this plan:** the drift-report ledger (§4.5), pruning (§4.4.3), the neutral fallback member (§4.3), worktree pin inheritance (`fam-a940d1`). Do not implement them here.
- **Scope of the promise:** correctness on a launch *following* a successful repair. Do not write code or docs claiming the current session is fixed — §6.1 measured that it is not.

---

### Task 1: Single-root project planning

`planCodexProjectSync` walks every `identities.yaml` path pin before reaching `cwd`, accumulates conflicts across all of them, and throws if any is unmanaged. A hook must never inherit that. This task extracts the per-target body so one repository can be planned alone, with the full catalog still available for pin matching.

**Files:**
- Create: `test/fixtures/theme-slots/` (fixture)
- Modify: `src/install/codex.js`
- Test: `test/install-codex-single.test.js` (create)

**Interfaces:**
- Produces: `planCodexProjectForPath({ path, pinned, catalog, pack })` → an object with `target` (the `.codex/config.toml` path, present on every outcome that reached a repository root, so the caller can deduplicate before dispatching) plus exactly one of: `config` + `exclude`, `manual`, `skip`, `missing`, or `conflict`. It **returns** a conflict rather than throwing, so the caller can decide whether to aggregate or report.
- Consumes: existing `gitContext`, `resolveIdentity`, `tracked`, `assertConfigTarget`, `excludePath`, `assertExcludeTarget`, `readIfPresent`, `selectionText`, `configText`, `EXCLUDE`, `codexHome`, `MANAGED_CONFIG`.

- [ ] **Step 0: Build a fixture with distinguishable members**

The only theme fixture is `test/fixtures/theme-pack`, whose single member `pip` holds **all twelve slots** — so every project resolves to `pip` and no test can observe a slot changing anything. Do not modify it; many suites depend on it. Create a sibling:

```bash
mkdir -p test/fixtures/theme-slots/sprites/{alpha,beta,gamma}
for m in alpha beta gamma; do
  cp test/fixtures/theme-pack/sprites/pip/*.png test/fixtures/theme-slots/sprites/$m/
done
```

```yaml
# test/fixtures/theme-slots/theme.yaml
spec-version: 1
id: slots-fixture
label: Slots Fixture
rows: 4
members:
  - id: alpha
    asset-root: sprites/alpha
    label: Alpha
    slots: [0, 1, 2, 3]
    persona: fixture member for the low slot band
    animation:
      kind: static
    poses:
      idle: flat grey square
      working: flat grey square
      needs-input: flat grey square
      needs-approval: flat grey square
      error: flat grey square
      done: flat grey square
  - id: beta
    asset-root: sprites/beta
    label: Beta
    slots: [4, 5, 6, 7]
    persona: fixture member for the middle slot band
    animation:
      kind: static
    poses:
      idle: flat grey square
      working: flat grey square
      needs-input: flat grey square
      needs-approval: flat grey square
      error: flat grey square
      done: flat grey square
  - id: gamma
    asset-root: sprites/gamma
    label: Gamma
    slots: [8, 9, 10, 11]
    persona: fixture member for the high slot band
    animation:
      kind: static
    poses:
      idle: flat grey square
      working: flat grey square
      needs-input: flat grey square
      needs-approval: flat grey square
      error: flat grey square
      done: flat grey square
```

The bands make a slot change observable as a member change. The remotes used below hash to known slots, so every assertion names the member it expects rather than merely asserting two results differ:

| remote | `projectKey` | `autoSlot` | default member |
|---|---|---:|---|
| `git@github.com:example/mine.git` | `github.com/example/mine` | 2 | `alpha` |
| `git@github.com:example/converge.git` | `github.com/example/converge` | 8 | `gamma` |

- [ ] **Step 1: Write the failing test**

```js
// test/install-codex-single.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadThemePack } from 'familiar-theme';
import { planCodexProjectForPath } from '../src/install/codex.js';

const THEME = await loadThemePack(
  fileURLToPath(new URL('./fixtures/theme-slots', import.meta.url)));

function repo(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `familiar-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin',
    `git@github.com:example/${name}.git`], { encoding: 'utf8' });
  return dir;
}

test('an unmanaged config in another project does not affect this one', async (t) => {
  const mine = repo(t, 'mine');
  const theirs = repo(t, 'theirs');
  mkdirSync(join(theirs, '.codex'), { recursive: true });
  writeFileSync(join(theirs, '.codex', 'config.toml'), 'hand written\n');

  const catalog = { identities: [{ path: theirs, slot: 3 }] };
  const planned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog, pack: THEME,
  });

  assert.ok(planned.config, 'this project plans normally');
  assert.equal(planned.identity.member, 'alpha', 'slot 2 is in the alpha band');
  assert.match(planned.config.text, /^# Managed by Familiar\./);
  assert.match(planned.config.text, /pet = "custom:familiar-alpha"\n$/);
});

test('a conflict in THIS project is returned, not thrown, and names only this project', async (t) => {
  const mine = repo(t, 'mine');
  mkdirSync(join(mine, '.codex'), { recursive: true });
  writeFileSync(join(mine, '.codex', 'config.toml'), 'hand written\n');

  const planned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog: { identities: [] }, pack: THEME,
  });
  assert.equal(planned.conflict, join(mine, '.codex', 'config.toml'));
  assert.equal(planned.target, join(mine, '.codex', 'config.toml'));
  assert.equal(planned.config, undefined);
});

test('a pin for THIS path still wins, so narrowing the target did not narrow the inputs', async (t) => {
  const mine = repo(t, 'mine');
  const unpinned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog: { identities: [] }, pack: THEME,
  });
  const pinned = await planCodexProjectForPath({
    path: mine, pinned: true, catalog: { identities: [{ path: mine, slot: 7 }] }, pack: THEME,
  });
  assert.equal(unpinned.identity.member, 'alpha', 'hashed slot 2');
  assert.equal(pinned.identity.member, 'beta', 'pinned slot 7');
});

test('a target reached by two routes is planned once — dedupe covers every outcome', async (t) => {
  const mine = repo(t, 'mine');
  const { planCodexProjectSync } = await import('../src/install/codex.js');
  mkdirSync(join(mine, '.codex'), { recursive: true });
  writeFileSync(join(mine, '.codex', 'config.toml'), 'hand written\n');

  await assert.rejects(
    () => planCodexProjectSync({
      catalog: { identities: [{ path: mine, slot: 3 }] }, pack: THEME, cwd: mine,
    }),
    (error) => {
      const mentions = error.message.split(', ').length;
      assert.equal(mentions, 1, `the same config must be reported once, got: ${error.message}`);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/install-codex-single.test.js`
Expected: FAIL — `planCodexProjectForPath is not a function`.

- [ ] **Step 3: Extract the per-target body**

In `src/install/codex.js`, lift the body of the `for (const { path, pinned } of targets)` loop into an exported function, leaving the dedupe and the aggregate conflict list in the caller:

```js
// ONE TARGET, ONE BLAST RADIUS. The hook calls this directly, so a refusal here
// must describe THIS repository and nothing else. `planCodexProjectSync` keeps
// its machine-wide behaviour by calling this in a loop -- an explicit,
// user-invoked, foreground command is the right place for that; a hook is not.
//
// THE CATALOG IS NOT NARROWED. `resolveIdentity` matches pins by remote, then
// path, then project name, over the WHOLE catalog. Passing only the pin that
// matched this path would silently change which pin wins.
//
// A CONFLICT IS RETURNED, NOT THROWN, and `target` comes back on every outcome
// that got as far as a repository root. Both exist for the caller's benefit: the
// machine-wide command aggregates conflicts and must deduplicate targets across
// ALL outcomes -- a repository that is both pinned and `cwd` was reported once
// before this refactor and must stay reported once.
export async function planCodexProjectForPath({ path, pinned, catalog, pack }) {
  if (!existsSync(path)) return { missing: path };
  if (!statSync(path).isDirectory()) throw new Error(`identity path is not a directory: ${path}`);

  const { remote, repoRoot } = await gitContext(path);
  if (!pinned && !repoRoot) return { skip: { path, reason: 'not a Git repository' } };

  const root = repoRoot ?? path;
  if (!pinned && join(root, EXCLUDE) === join(codexHome(), 'config.toml')) {
    return { skip: { path: root, reason: 'its Codex config is the user-wide one' } };
  }

  const target = join(root, EXCLUDE);
  const isTracked = repoRoot ? tracked(root) : false;
  const replaceEmptyMarker = !isTracked && assertConfigTarget(
    root, target, !repoRoot || !tracked(root, '.codex'),
  );

  const identity = resolveIdentity({
    projectKey: projectKeyFor({ remote, repoRoot, cwd: path }),
    project: displayProject({ repoRoot, cwd: path }),
    remote, repoRoot, catalog, pack,
  });

  if (isTracked) {
    return { target, identity, manual: { path: target, setting: selectionText(identity.member) } };
  }

  const current = readIfPresent(target);
  if (current !== null && !MANAGED_CONFIG.test(current)) {
    return { target, identity, conflict: target };
  }

  let exclude = null;
  if (repoRoot) {
    const excludeTarget = excludePath(root);
    assertExcludeTarget(excludeTarget);
    exclude = { path: excludeTarget };
  }

  return {
    target,
    identity,
    config: {
      root,
      path: target,
      before: current,
      text: configText(identity.member),
      replaceEmptyMarker,
      gitBacked: Boolean(repoRoot),
    },
    exclude,
  };
}
```

- [ ] **Step 4: Rewrite `planCodexProjectSync` on top of it, deduplicating every outcome**

```js
export async function planCodexProjectSync({ catalog, pack, cwd = null }) {
  const configs = [], excludes = [], manual = [], missing = [];
  const seen = new Set(), seenExcludes = new Set();
  const conflicts = [];
  const targets = [];
  for (const pin of catalog.identities) {
    if (pin.path) targets.push({ path: pinPath(pin.path), pinned: true });
  }
  if (cwd !== null) targets.push({ path: resolve(cwd), pinned: false });
  let unpinnedSkip = null;

  for (const { path, pinned } of targets) {
    const planned = await planCodexProjectForPath({ path, pinned, catalog, pack });

    if (planned.missing) { missing.push(planned.missing); continue; }
    if (planned.skip) { if (!pinned) unpinnedSkip = planned.skip; continue; }

    // DEDUPE BEFORE DISPATCH, not after. A repository that is both pinned and
    // the current directory arrives twice, and every outcome -- managed,
    // tracked, conflicting -- must be reported exactly once.
    if (seen.has(planned.target)) continue;
    seen.add(planned.target);

    if (planned.conflict) { conflicts.push(planned.conflict); continue; }
    if (planned.manual) { manual.push(planned.manual); continue; }

    configs.push(planned.config);
    if (planned.exclude && !seenExcludes.has(planned.exclude.path)) {
      seenExcludes.add(planned.exclude.path);
      excludes.push(planned.exclude);
    }
  }

  if (conflicts.length) {
    throw new Error(`refusing unmanaged project config ${conflicts.join(', ')}`);
  }
  return { configs, excludes, manual, missing, unpinnedSkip };
}
```

Add `existsSync`/`statSync` to the `node:fs` import if not already present.

- [ ] **Step 5: Run the new test and the existing Codex suites**

Run: `node --test test/install-codex-single.test.js test/codex.test.js test/codex-pets.test.js test/bin-familiar.test.js`
Expected: PASS. `--sync-projects` behaviour is unchanged: same aggregate conflict message, same skip and manual reporting, same once-per-target deduplication.

- [ ] **Step 6: Commit**

```bash
git add src/install/codex.js test/install-codex-single.test.js test/fixtures/theme-slots
git commit -m "refactor(codex): plan one project's pet config without touching the rest"
```

---

### Task 2: A compile stamp that identifies the compiled sheet

Per spec §4.4.1 the theme receipt cannot answer "was this pet compiled from the bytes on disk now" — `local` receipts carry no commit, absent receipts are normal, and an `https` receipt is unchanged by in-place art edits.

**The stamp hashes the compiled spritesheet, not the collected inputs.** An input hash is not sound here: `sampledFrames` in `src/render/codex/pets.js` calls `readFrame` only on a **cache miss**, and returns `roots[clip.state]` without calling it at all for `frame.ref === 'root'`. So repeated samples, root-frame selections, and sample *order* all vanish from any list of bytes `readFrame` observed — two animations with different timings that draw on the same distinct files produce different sheets and an identical input list. The sheet is the artifact, it is a total function of every input that matters (art, timing, sampling, geometry, policy, anchor), and it is already in hand at write time.

**Files:**
- Create: `src/install/pet-stamp.js`
- Modify: `src/protocol/hash.js`, `bin/familiar` (the `install pets` branch)
- Test: `test/pet-stamp.test.js` (create)

**Interfaces:**
- Produces: `STAMP_VERSION` (number), `STAMP_FILE` (`'familiar-stamp.json'`), `stampFor({ themeId, memberId, frame, motionPolicy, anchor, sheet })` where `sheet` is the encoded PNG `Uint8Array` → `{ version, themeId, memberId, frame, motionPolicy, anchor, content }`; `readStamp(dir)` → a **fully validated** stamp object or `null`.

- [ ] **Step 1: Write the failing test**

```js
// test/pet-stamp.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stampFor, readStamp, STAMP_FILE, STAMP_VERSION } from '../src/install/pet-stamp.js';

const base = {
  themeId: 'cats', memberId: 'ginger',
  frame: { width: 192, height: 208, columns: 8, rows: 9 },
  motionPolicy: 'full', anchor: 'floor',
};
const sheet = (...bytes) => ({ ...base, sheet: Uint8Array.from(bytes) });

test('the same sheet stamps the same', () => {
  assert.equal(stampFor(sheet(1, 2, 3)).content, stampFor(sheet(1, 2, 3)).content);
  assert.equal(stampFor(sheet(1, 2, 3)).version, STAMP_VERSION);
});

test('any difference in the compiled sheet changes the stamp', () => {
  assert.notEqual(stampFor(sheet(1, 2, 3)).content, stampFor(sheet(1, 2, 4)).content);
  assert.notEqual(stampFor(sheet(1, 2)).content, stampFor(sheet(2, 1)).content);
});

test('the compiler contract is stamped alongside the sheet', () => {
  const full = stampFor(sheet(1));
  assert.notEqual(stampFor({ ...sheet(1), motionPolicy: 'reduced' }).content, full.content);
  assert.notEqual(stampFor({ ...sheet(1), anchor: 'center' }).content, full.content);
  assert.notEqual(
    stampFor({ ...sheet(1), frame: { ...base.frame, rows: 8 } }).content, full.content);
  assert.notEqual(stampFor({ ...sheet(1), themeId: 'dogs' }).content, full.content);
});

test('readStamp rejects anything it cannot fully trust', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-stamp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (value) => writeFileSync(join(dir, STAMP_FILE),
    typeof value === 'string' ? value : JSON.stringify(value));

  assert.equal(readStamp(dir), null, 'absent');
  write('not json');
  assert.equal(readStamp(dir), null, 'unparseable');

  const good = stampFor(sheet(1));
  write({ ...good, version: STAMP_VERSION + 1 });
  assert.equal(readStamp(dir), null, 'a future version is not ours to interpret');

  for (const field of ['themeId', 'memberId', 'content', 'frame', 'motionPolicy', 'anchor']) {
    const partial = { ...good };
    delete partial[field];
    write(partial);
    assert.equal(readStamp(dir), null, `a stamp missing ${field} must be rejected`);
  }

  write({ ...good, content: 42 });
  assert.equal(readStamp(dir), null, 'content must be a hex string');

  write(good);
  assert.equal(readStamp(dir).memberId, 'ginger');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/pet-stamp.test.js`
Expected: FAIL — cannot find module `../src/install/pet-stamp.js`.

- [ ] **Step 3: Add a seed to the byte hash**

```js
// src/protocol/hash.js — new optional parameter; the default keeps fnv1a32 byte-identical,
// which matters because it decides every unpinned project's character.
export function fnv1a32Bytes(bytes, seed = 0x811c9dc5) {
  let h = seed;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
```

- [ ] **Step 4: Write the module**

```js
// src/install/pet-stamp.js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fnv1a32Bytes } from '../protocol/hash.js';

// PROVENANCE CANNOT ANSWER THIS QUESTION, which is why this file exists rather
// than a copy of the theme receipt. A `local` receipt carries no commit at all
// (src/theme/receipt.js validates it as { kind, path }), an absent receipt is
// normal for any other install route, and an `https` receipt is unchanged when
// the installed artwork is edited in place.
//
// AND THE INPUTS CANNOT ANSWER IT EITHER. sampledFrames() reads a frame only on
// a cache MISS and never reads a root frame at all, so the bytes an input hash
// could observe do not distinguish two timings that sample the same files in a
// different order or a different number of times. The compiled sheet does: it is
// a total function of the art, the sampling, the geometry, the motion policy and
// the anchor. Hash the artifact, not the ingredients.
export const STAMP_VERSION = 1;
export const STAMP_FILE = 'familiar-stamp.json';

const HEX8 = /^[0-9a-f]{8}$/;

export function stampFor({ themeId, memberId, frame, motionPolicy, anchor, sheet }) {
  const contract = new TextEncoder().encode(JSON.stringify({
    version: STAMP_VERSION, themeId, memberId, frame, motionPolicy, anchor,
  }));
  const content = fnv1a32Bytes(sheet, fnv1a32Bytes(contract))
    .toString(16).padStart(8, '0');
  return { version: STAMP_VERSION, themeId, memberId, frame, motionPolicy, anchor, content };
}

// A HALF-WRITTEN STAMP MUST NOT READ AS A GOOD ONE. `install pets` can be
// interrupted between writes, and a stamp that validated on `version` alone
// would let a torn install satisfy the asset gate. Absent, unparseable, foreign
// and incomplete are all one answer -- null -- and the caller decides what it
// means; throwing here would make an old install a crash.
export function readStamp(dir) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  if (data.version !== STAMP_VERSION) return null;
  if (typeof data.themeId !== 'string' || data.themeId === '') return null;
  if (typeof data.memberId !== 'string' || data.memberId === '') return null;
  if (typeof data.content !== 'string' || !HEX8.test(data.content)) return null;
  if (typeof data.frame !== 'object' || data.frame === null) return null;
  if (typeof data.motionPolicy !== 'string') return null;
  if (typeof data.anchor !== 'string') return null;
  return data;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/pet-stamp.test.js test/hash.test.js`
Expected: PASS, including the existing hash suite.

- [ ] **Step 6: Write the stamp from `install pets`, last and only last**

In `bin/familiar`, inside the `for (const [memberId, member] of ctx.pack.members)` loop of the `install pets` branch. **Order is the contract:** the stamp is the gate's evidence that a pet is complete, so an old stamp is removed before any output is replaced, and the new one is published only after the sheet *and* the manifest are on disk.

```js
const id = `familiar-${memberId}`;
const dir = join(out, id);
mkdirSync(join(dir, 'assets'), { recursive: true });

// INVALIDATE FIRST. Between here and the stamp write this pet is
// half-replaced; without this unlink an interruption would leave the OLD
// stamp vouching for a NEW, incomplete sheet -- the one state the gate
// cannot detect, because a stamp is exactly what it trusts.
rmSync(join(dir, STAMP_FILE), { force: true });

const sheet = encodeRgba(spritesheet({
  animationSet,
  roots: poses,
  anchor: member.anchor,
  motionPolicy: ctx.motionPolicy,
  readFrame: (path) => decodeRgba(readFileSync(path)),
}));
writeFileSync(join(dir, SPRITESHEET_PATH), sheet);
writeFileSync(
  join(dir, 'pet.json'),
  JSON.stringify(petFile({
    id,
    displayName: member.label ?? memberId,
    description: member.persona ?? `familiar — ${member.label ?? memberId}`,
  }), null, 2) + '\n',
);

// PUBLISH LAST. The stamp is the only thing that says "this pet is complete
// and belongs to this theme", so it must be the last byte written.
writeFileSync(join(dir, STAMP_FILE), JSON.stringify(stampFor({
  themeId: ctx.themeId,
  memberId,
  frame: FRAME,
  motionPolicy: ctx.motionPolicy,
  anchor: member.anchor ?? 'floor',
  sheet,
}), null, 2) + '\n');
```

Import `FRAME` from `../src/render/codex/pets.js`, `{ STAMP_FILE, stampFor }` from `../src/install/pet-stamp.js`, and add `rmSync` to the `node:fs` import.

- [ ] **Step 7: Run the suite and commit**

Run: `just test`
Expected: PASS.

```bash
git add src/install/pet-stamp.js src/protocol/hash.js bin/familiar test/pet-stamp.test.js
git commit -m "feat(codex): stamp each compiled pet with a hash of its compiled sheet"
```

---

### Task 3: The asset gate the hook can afford

Per spec §4.4.2 the hook answers "is this pet from the active theme's roster and complete", never "is its art current". The content question needs the source bytes and belongs to `install pets`.

**Files:**
- Modify: `src/install/pet-stamp.js`
- Test: `test/pet-stamp.test.js`

**Interfaces:**
- Produces: `petUsable({ petsDir, themeId, memberId })` → `{ ok: true }` or `{ ok: false, reason: string }`. Reads at most two small files plus two `existsSync` probes. Never hashes.

- [ ] **Step 1: Write the failing test**

```js
// append to test/pet-stamp.test.js
import { mkdirSync } from 'node:fs';
import { petUsable } from '../src/install/pet-stamp.js';
import { SPRITESHEET_PATH } from '../src/render/codex/pets.js';

function pet(dir, id, { stamp = null, manifest = true, sheetFile = true } = {}) {
  const petDir = join(dir, id);
  mkdirSync(join(petDir, 'assets'), { recursive: true });
  if (sheetFile) writeFileSync(join(petDir, SPRITESHEET_PATH), 'png');
  if (manifest) writeFileSync(join(petDir, 'pet.json'), '{}');
  if (stamp) writeFileSync(join(petDir, STAMP_FILE), JSON.stringify(stamp));
  return petDir;
}

const pets = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-pets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('the gate accepts a complete pet stamped for this theme and member', (t) => {
  const dir = pets(t);
  pet(dir, 'familiar-ginger', { stamp: stampFor(sheet(1)) });
  assert.deepEqual(petUsable({ petsDir: dir, themeId: 'cats', memberId: 'ginger' }), { ok: true });
});

test('the gate refuses every incomplete installation, and says which', (t) => {
  const dir = pets(t);
  const verdict = (memberId) => petUsable({ petsDir: dir, themeId: 'cats', memberId });

  assert.match(verdict('ginger').reason, /not installed/);

  pet(dir, 'familiar-tuxedo', { stamp: null });
  assert.match(verdict('tuxedo').reason, /no valid stamp/);

  // The manifest is what Codex reads to learn the pet's tracks. A sheet
  // without it is a pet Codex cannot use.
  pet(dir, 'familiar-persian', { stamp: stampFor({ ...sheet(1), memberId: 'persian' }), manifest: false });
  assert.match(verdict('persian').reason, /pet\.json/);

  pet(dir, 'familiar-tabby', { stamp: stampFor({ ...sheet(1), memberId: 'tabby' }), sheetFile: false });
  assert.match(verdict('tabby').reason, /spritesheet/);

  pet(dir, 'familiar-siamese', {
    stamp: stampFor({ ...sheet(1), themeId: 'dogs', memberId: 'siamese' }) });
  assert.match(verdict('siamese').reason, /theme "dogs"/);

  pet(dir, 'familiar-manx', { stamp: stampFor({ ...sheet(1), memberId: 'somebody-else' }) });
  assert.match(verdict('manx').reason, /member "somebody-else"/);

  for (const id of ['ginger', 'tuxedo', 'persian', 'tabby', 'siamese', 'manx']) {
    assert.equal(verdict(id).ok, false);
  }
});

test('a torn install — new sheet, stamp not yet published — is refused', (t) => {
  const dir = pets(t);
  pet(dir, 'familiar-ginger', { stamp: null });
  assert.equal(petUsable({ petsDir: dir, themeId: 'cats', memberId: 'ginger' }).ok, false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/pet-stamp.test.js`
Expected: FAIL — `petUsable is not a function`.

- [ ] **Step 3: Implement the gate**

```js
// src/install/pet-stamp.js
import { existsSync } from 'node:fs';
import { SPRITESHEET_PATH } from '../render/codex/pets.js';

// WHAT A HOOK CAN AFFORD, AND NOTHING MORE. This answers "is this pet complete
// and from the active theme's roster" -- four cheap probes. It deliberately does
// NOT answer "is its art current with the theme's files": that needs the source
// bytes hashed, and hashing on the hook path is the unbounded work the timeout
// argument in ../bus/identity.js exists to keep out. `install pets` owns that
// question; it already has the bytes open.
//
// ALL THREE FILES ARE CHECKED, not just the sheet. Codex reads `pet.json` to
// learn the pet's tracks, so a sheet without a manifest is a pet it cannot draw
// -- and `install pets` writes the stamp last precisely so that a stamp present
// means the other two are already there. Checking them anyway costs two
// `existsSync` calls and closes the window where someone deletes one by hand.
export function petUsable({ petsDir, themeId, memberId }) {
  const name = `familiar-${memberId}`;
  const dir = join(petsDir, name);
  if (!existsSync(dir)) return { ok: false, reason: `pet "${name}" is not installed` };
  if (!existsSync(join(dir, SPRITESHEET_PATH))) {
    return { ok: false, reason: `pet "${name}" has no spritesheet` };
  }
  if (!existsSync(join(dir, 'pet.json'))) {
    return { ok: false, reason: `pet "${name}" has no pet.json manifest` };
  }
  const stamp = readStamp(dir);
  if (!stamp) {
    return { ok: false, reason: `pet "${name}" has no valid stamp from this version of Familiar` };
  }
  if (stamp.themeId !== themeId) {
    return { ok: false, reason: `pet "${name}" was compiled for theme "${stamp.themeId}", not "${themeId}"` };
  }
  if (stamp.memberId !== memberId) {
    return { ok: false, reason: `pet "${name}" carries a stamp for member "${stamp.memberId}"` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pet-stamp.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install/pet-stamp.js test/pet-stamp.test.js
git commit -m "feat(codex): gate a pet selection on a complete, correctly-stamped install"
```

---

### Task 4: Converge the config from the Codex `SessionStart` hook

**Files:**
- Create: `src/install/codex-converge.js`
- Modify: `bin/familiar` (the `hook` branch)
- Test: `test/codex-converge.test.js` (create)

**Interfaces:**
- Produces:
  - `shouldConverge({ agent, event })` → boolean. Pure, exported, and unit-tested — this is how the routing is verified without a Codex process (see Step 6).
  - `convergeCodexProject({ repoRoot, member, catalog, pack, themeId, petsDir })` → `{ changed, member, outcome, reason? }` where `outcome` is `'converged' | 'unchanged' | 'quiet' | 'actionable' | 'error'`. Never throws for an ordinary refusal.
- Consumes: `repoRoot` and `member` come from the transaction — `next.repoRoot` and `intent[next.sessionId].current.identity.member` — never re-derived.

**Why the signature takes `repoRoot` and `member`:** calling the planner first would spawn `gitContext` (2 subprocesses), `tracked` (1), `tracked(root, '.codex')` (1) and `excludePath` (1) on **every** `SessionStart`, including the overwhelmingly common case where the config is already correct — five `git` subprocesses and a second pin sweep to discover that nothing needs doing. The hook already holds both answers. So the cheap comparison happens first, and the write preflight runs only after a mismatch is proven.

- [ ] **Step 1: Write the failing test**

```js
// test/codex-converge.test.js
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

// `git rev-parse --show-toplevel` reports the PHYSICAL path, and macOS /tmp is a
// symlink, so resolve the root the way the transaction would have.
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
  assert.match(readFileSync(join(root, '.codex', 'config.toml'), 'utf8'),
    /pet = "custom:familiar-gamma"/);
  assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /\.codex\/config\.toml/);
});

test('an already-correct config is unchanged, and spawns no git', async (t) => {
  const root = repo(t);
  const petsDir = petsFor(t);
  await run(root, petsDir, 'gamma');
  const before = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');

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
  assert.equal(readFileSync(join(root, '.codex', 'config.toml'), 'utf8'), before);
});

test('a member change converges the file on the next call', async (t) => {
  const root = repo(t);
  const petsDir = petsFor(t);
  await run(root, petsDir, 'gamma');
  const second = await run(root, petsDir, 'alpha');
  assert.equal(second.outcome, 'converged');
  assert.match(readFileSync(join(root, '.codex', 'config.toml'), 'utf8'),
    /pet = "custom:familiar-alpha"/);
});

test('an unmanaged config is left alone and reported as actionable', async (t) => {
  const root = repo(t);
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex', 'config.toml'), '[tui]\npet = "mine"\n');
  const result = await run(root, petsFor(t), 'gamma');
  assert.equal(result.outcome, 'actionable');
  assert.match(result.reason, /unmanaged/);
  assert.equal(readFileSync(join(root, '.codex', 'config.toml'), 'utf8'), '[tui]\npet = "mine"\n');
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

test('a session with no repository root is a quiet no-op', async (t) => {
  const result = await run(null, petsFor(t), 'gamma');
  assert.equal(result.outcome, 'quiet');
  assert.equal(result.changed, false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/codex-converge.test.js`
Expected: FAIL — cannot find module `../src/install/codex-converge.js`.

- [ ] **Step 3: Implement convergence**

```js
// src/install/codex-converge.js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planCodexProjectForPath, applyCodexProjectSync, configText, EXCLUDE } from './codex.js';
import { petUsable } from './pet-stamp.js';

// SessionStart ONLY, AND CODEX ONLY. claude-code and opencode need none of this:
// Familiar draws their surfaces itself, from the bus, live. This exists solely
// because Codex draws its own pet from a file, so the file has to be kept true.
// PreToolUse fires on every tool call and would repeat the work for nothing.
export function shouldConverge({ agent, event }) {
  return agent === 'codex' && event === 'SessionStart';
}

// ONE REPOSITORY, ONE LAUNCH LATE BY CONSTRUCTION.
// docs/specs/2026-09-05-codex-identity-parity-design.md §6.1 measured it: Codex
// reads `[tui] pet` at TUI start and no hook runs before the first turn, so what
// this writes is read by the NEXT launch. That is the ceiling, not a bug to fix
// here -- which is why nothing below tries to signal Codex.
//
// `repoRoot` AND `member` ARE ARGUMENTS, NOT DISCOVERIES. The transaction has
// already run gitContext and resolved the identity for this very session. Asking
// the planner first would spawn five `git` subprocesses and repeat the pin sweep
// on EVERY SessionStart just to learn that nothing needs doing. So: compare
// first, and let the planner (with its preflight and its refusals) run only once
// a mismatch is real.
//
// EVERY ORDINARY REFUSAL IS A RETURN, NOT A THROW. This runs inside a cosmetic
// hook; an unmanaged config, a tracked one, a missing pet and a non-repository
// are all normal states of a user's machine, and none may take down the session.
export async function convergeCodexProject({
  repoRoot, member, catalog, pack, themeId, petsDir,
}) {
  // No repository is not a failure -- it is most of the filesystem.
  if (!repoRoot) return { changed: false, member, outcome: 'quiet' };

  const target = join(repoRoot, EXCLUDE);
  const wanted = configText(member);

  // THE CHEAP PATH, and the only one most sessions take: one small read.
  let current = null;
  try {
    current = readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { changed: false, member, outcome: 'error', reason: `${target}: ${error.message}` };
    }
  }
  if (current === wanted) return { changed: false, member, outcome: 'unchanged' };

  // THE GATE COMES BEFORE THE WRITE. Selecting a pet whose assets are absent,
  // incomplete, or from another theme replaces a stale-but-drawable selection
  // with one that draws nothing, which is strictly worse.
  const usable = petUsable({ petsDir, themeId, memberId: member });
  if (!usable.ok) {
    return {
      changed: false, member, outcome: 'actionable',
      reason: `${usable.reason} — run \`familiar install pets\``,
    };
  }

  let planned;
  try {
    planned = await planCodexProjectForPath({
      path: repoRoot, pinned: false, catalog, pack,
    });
  } catch (error) {
    // Only the genuinely exceptional reaches here: a symlinked .codex, a
    // non-regular config, a wedged git. All are worth saying out loud.
    return { changed: false, member, outcome: 'error', reason: error.message };
  }

  if (planned.conflict) {
    return {
      changed: false, member, outcome: 'actionable',
      reason: `refusing unmanaged project config ${planned.conflict}`,
    };
  }
  if (planned.manual) {
    return {
      changed: false, member, outcome: 'actionable',
      reason: `project config is tracked by Git; set it yourself: ${planned.manual.path}`,
    };
  }
  if (planned.skip) return { changed: false, member, outcome: 'quiet', reason: planned.skip.reason };
  if (planned.missing) return { changed: false, member, outcome: 'quiet' };

  try {
    applyCodexProjectSync({
      configs: [planned.config],
      excludes: planned.exclude ? [planned.exclude] : [],
    });
  } catch (error) {
    return { changed: false, member, outcome: 'error', reason: error.message };
  }
  return { changed: true, member: planned.identity.member, outcome: 'converged' };
}
```

Export `configText` and `EXCLUDE` from `src/install/codex.js` (both are currently module-private).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex-converge.test.js`
Expected: PASS, including the no-git assertion.

- [ ] **Step 5: Call it from the hook, and report what a user can act on**

In `bin/familiar`, in the `hook` branch, after `emitHookTransition(...)`:

```js
if (shouldConverge({ agent: name, event: positionals[0] }) && next) {
  try {
    const result = await convergeCodexProject({
      repoRoot: next.repoRoot,
      member: intent[next.sessionId].current.identity.member,
      catalog: ctx.catalog,
      pack: ctx.pack,
      themeId: ctx.themeId,
      petsDir: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'pets'),
    });
    // ORDINARY NO-OPS ARE SILENT; ANYTHING A USER COULD ACT ON IS NOT.
    // `quiet` and `unchanged` are the common cases and say nothing. But an
    // unmanaged config, a tracked one, missing pets, a symlink refusal or a
    // wedged git all mean the pet a user is looking at is NOT the one Familiar
    // resolved -- and saying nothing there is the same silent drift this whole
    // change exists to end.
    if (result.outcome === 'actionable' || result.outcome === 'error') {
      process.stderr.write(`familiar: ${result.reason}\n`);
    }
  } catch (error) {
    // The cosmetic layer never degrades the tool it decorates. The top-level
    // boundary in this file already turns a throw into exit 0 plus one stderr
    // line; this narrower catch keeps a convergence failure from skipping
    // anything after it.
    process.stderr.write(`familiar: could not converge the Codex pet config: ${error.message}\n`);
  }
}
```

Import `{ convergeCodexProject, shouldConverge }` from `../src/install/codex-converge.js`.

Note `next` is `null` on `SessionEnd` (a removal), hence the `&& next` guard.

- [ ] **Step 6: Verify the routing without faking a Codex process**

There is deliberately **no** end-to-end `spawnSync(bin, ['hook', 'SessionStart', '--agent', 'codex'])` test. `resolveAgentPid` requires an ancestor whose `comm` is `codex` and which owns a terminal; a Node test runner is neither, so such a test would fail in the hook long before convergence — and making it pass by running under a live Codex would make the suite depend on the developer's own session. `test/fixtures/tty-familiar.mjs` fakes `process.stdout.isTTY` only; it does not fake ancestry.

The seam is `shouldConverge`, already asserted in Step 1. Agent resolution itself is covered by the synthetic ancestor chains in `test/codex.test.js`, and convergence by the direct tests above. Between them the three pieces are covered without inventing a process tree.

Add one guard so the wiring cannot silently rot:

```js
// append to test/codex-converge.test.js
test('the hook branch actually calls the predicate — wiring guard', async () => {
  const source = readFileSync(
    fileURLToPath(new URL('../bin/familiar', import.meta.url)), 'utf8');
  assert.match(source, /shouldConverge\(\{\s*agent: name, event: positionals\[0\]\s*\}\)/,
    'bin/familiar must route convergence through shouldConverge');
  assert.match(source, /convergeCodexProject\(/);
});
```

- [ ] **Step 7: Run the suite and commit**

Run: `just test`
Expected: PASS.

```bash
git add src/install/codex-converge.js src/install/codex.js bin/familiar test/codex-converge.test.js
git commit -m "feat(codex): converge the project pet config on SessionStart"
```

---

### Task 5: Say what it does, and correct the spec's status

**Files:**
- Modify: `docs/surfaces.md`
- Modify: `docs/specs/2026-09-05-codex-identity-parity-design.md`
- Modify: `README.md` if it documents `install pets --sync-projects` as the way to select a pet

- [ ] **Step 1: Document the behaviour and its limit**

In `docs/surfaces.md`, under the Codex surface, state plainly: the project's pet config is maintained automatically from the first turn of a Codex session; because Codex reads its pet at launch, a change takes effect on the **next** launch; `familiar install pets --sync-projects` forces it immediately.

- [ ] **Step 2: Correct the spec's status header**

Per the repo's rule that a merge is the moment a status goes stale, change the spec's `**Status:**` line to record which sections are implemented (§4.1, §4.4.1, §4.4.2, §4.4 gate) and which remain deferred (§4.3 fallback member, §4.4.3 prune, §4.5 ledger and drift report).

- [ ] **Step 3: Grep for the claim elsewhere**

Run: `grep -rn "sync-projects" README.md docs/ AGENTS.md`
Correct any text presenting it as the only way a project gets a pet.

- [ ] **Step 4: Full verification**

Run: `just gate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs README.md
git commit -m "docs(codex): record automatic pet convergence and its one-launch limit"
```

---

## Revision history

**2026-09-05, after review.** Seven findings, all confirmed against the code.

| | finding | change |
|---|---|---|
| 1 | an input hash cannot identify the sheet: `sampledFrames` calls `readFrame` only on a cache miss and never for a root frame, so timing, repeats and sample order vanish | Task 2 hashes the **compiled sheet** instead — a total function of art, sampling, geometry, policy and anchor |
| 2 | the gate accepted incomplete installs: no `pet.json` check, `readStamp` trusted any object with a matching `version`, and the stamp was written before the manifest | Task 2 unlinks the old stamp first and publishes the new one **last**; `readStamp` validates every field; Task 3 checks sheet **and** manifest |
| 3 | convergence called the full planner before comparing, costing five `git` subprocesses and a second identity resolve on an already-correct config | Task 4 takes `repoRoot` and `member` from the transaction, compares first, and preflights only on mismatch — asserted by a test that empties `PATH` |
| 4 | only reasons containing `familiar install pets` were printed, so unmanaged and tracked configs, symlink refusals and git timeouts were silent | Task 4 classifies outcomes (`quiet`/`unchanged`/`actionable`/`error`) and reports the last two |
| 5 | `test/fixtures/theme` does not exist, and the real fixture's only member holds all twelve slots, so no test could observe a slot change | Task 1 Step 0 adds `test/fixtures/theme-slots` with three members over slot bands; every assertion now names its expected member |
| 6 | the end-to-end hook test was unimplementable: `resolveAgentPid` needs a `codex` ancestor owning a terminal, which a test runner is not | Task 4 Step 6 replaces it with an exported `shouldConverge` predicate, unit tests, and a source-level wiring guard |
| 7 | moving the dedupe check let `manual` and conflict outcomes bypass it, double-reporting a repository that is both pinned and `cwd` | Task 1 returns `target` on every outcome and dedupes **before** dispatch |

