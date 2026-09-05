# Codex pet convergence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `<repo>/.codex/config.toml` a self-maintaining artifact, so a Codex session in any repository converges on the same familiar every other surface already resolves.

**Architecture:** The Codex `SessionStart` hook resolves identity anyway (to put the session on the bus). After that resolve, it compares the resolved member against this one repository's managed config and rewrites it when they disagree — gated on the target pet's assets actually being installed for the active theme. Planning is scoped to a single repository; asset compilation stays offline in `install pets`, which gains a per-pet stamp recording what it compiled from.

**Tech Stack:** Node 26, ESM, `node:test` + `node:assert/strict`, `familiar-theme` (vendored via node_modules), no new dependencies.

**Spec:** `docs/specs/2026-09-05-codex-identity-parity-design.md`

## Global Constraints

- **The hook path must stay bounded.** No content hashing, no PNG decode, no unbounded `git`. The only new per-`SessionStart` work is one small file read and, on mismatch, one write. Rationale: the timeout argument at the top of `src/bus/identity.js`.
- **Never rewrite a config Familiar does not own.** Managed means the file matches `MANAGED_CONFIG` in `src/install/codex.js` (the header plus a single `[tui] pet` line). Tracked configs, symlinks, non-regular files, and the user-wide config are all refused, exactly as today.
- **One repository, one blast radius.** Nothing invoked from a hook may plan, refuse, or write on behalf of any other project.
- **Deferred, not in this plan:** the drift-report ledger (§4.5), pruning (§4.4.3), the neutral fallback member (§4.3), worktree pin inheritance (`fam-a940d1`). Do not implement them here.
- **Scope of the promise:** correctness on a launch *following* a successful repair. Do not write code or docs claiming the current session is fixed — §6.1 measured that it is not.

---

### Task 1: Single-root project planning

`planCodexProjectSync` walks every `identities.yaml` path pin before reaching `cwd`, accumulates conflicts across all of them, and throws if any is unmanaged. A hook must never inherit that. This task extracts the per-target body so one repository can be planned alone, with the full catalog still available for pin matching.

**Files:**
- Modify: `src/install/codex.js`
- Test: `test/install-codex-single.test.js` (create)

**Interfaces:**
- Produces: `planCodexProjectForPath({ path, pinned, catalog, pack })` → `{ config, exclude }` where `config` is the same shape `planCodexProjectSync` pushes into `plan.configs`, `exclude` is `{ path }` or `null`; or `{ skip: { path, reason } }`; or `{ manual: { path, setting } }`; throws for a conflict **in this path only**.
- Consumes: existing `gitContext`, `resolveIdentity`, `tracked`, `assertConfigTarget`, `excludePath`, `assertExcludeTarget`, `readIfPresent`, `selectionText`, `configText`, `EXCLUDE`, `codexHome`, `MANAGED_CONFIG`.

- [ ] **Step 1: Write the failing test**

```js
// test/install-codex-single.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planCodexProjectForPath } from '../src/install/codex.js';
import { loadThemePackSync } from 'familiar-theme';

const THEME = loadThemePackSync(new URL('./fixtures/theme', import.meta.url).pathname);

function repo(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `familiar-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin',
    `git@github.com:example/${name}.git`], { encoding: 'utf8' });
  return dir;
}

test("an unmanaged config in another project does not affect this one", async (t) => {
  const mine = repo(t, 'mine');
  const theirs = repo(t, 'theirs');
  mkdirSync(join(theirs, '.codex'), { recursive: true });
  writeFileSync(join(theirs, '.codex', 'config.toml'), 'hand written\n');

  const catalog = { identities: [{ path: theirs, slot: 3 }] };
  const planned = await planCodexProjectForPath({
    path: mine, pinned: false, catalog, pack: THEME,
  });

  assert.ok(planned.config, 'this project plans normally');
  assert.match(planned.config.text, /^# Managed by Familiar\./);
  assert.match(planned.config.text, /pet = "custom:familiar-[a-z0-9-]+"\n$/);
});

test("a conflict in THIS project throws, and names only this project", async (t) => {
  const mine = repo(t, 'mine');
  mkdirSync(join(mine, '.codex'), { recursive: true });
  writeFileSync(join(mine, '.codex', 'config.toml'), 'hand written\n');

  await assert.rejects(
    () => planCodexProjectForPath({ path: mine, pinned: false, catalog: { identities: [] }, pack: THEME }),
    (error) => {
      assert.match(error.message, /refusing unmanaged project config/);
      assert.match(error.message, new RegExp(mine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test("a pin for THIS path still wins, so narrowing the target did not narrow the inputs", async (t) => {
  const mine = repo(t, 'mine');
  const catalog = { identities: [{ path: mine, slot: 3 }] };
  const planned = await planCodexProjectForPath({
    path: mine, pinned: true, catalog, pack: THEME,
  });
  const pinned = await planCodexProjectForPath({
    path: mine, pinned: true, catalog: { identities: [] }, pack: THEME,
  });
  assert.notEqual(planned.config.text, pinned.config.text,
    'the slot-3 pin must produce a different member than the hashed slot');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/install-codex-single.test.js`
Expected: FAIL — `planCodexProjectForPath is not a function`.

- [ ] **Step 3: Extract the per-target body**

In `src/install/codex.js`, lift the body of the `for (const { path, pinned } of targets)` loop into an exported function, leaving the dedupe (`seen`, `seenExcludes`) and the aggregate conflict list in the caller:

```js
// ONE TARGET, ONE BLAST RADIUS. The hook calls this directly, so a refusal here
// must describe THIS repository and nothing else. `planCodexProjectSync` keeps
// its machine-wide behaviour by calling this in a loop -- an explicit,
// user-invoked, foreground command is the right place for that; a hook is not.
//
// THE CATALOG IS NOT NARROWED. `resolveIdentity` matches pins by remote, then
// path, then project name, over the WHOLE catalog. Passing only the pin that
// matched this path would silently change which pin wins.
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

  if (isTracked) return { manual: { path: target, setting: selectionText(identity.member) } };

  const current = readIfPresent(target);
  if (current !== null && !MANAGED_CONFIG.test(current)) {
    throw new Error(`refusing unmanaged project config ${target}`);
  }

  let exclude = null;
  if (repoRoot) {
    const excludeTarget = excludePath(root);
    assertExcludeTarget(excludeTarget);
    exclude = { path: excludeTarget };
  }

  return {
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

- [ ] **Step 4: Rewrite `planCodexProjectSync` on top of it**

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
    let planned;
    try {
      planned = await planCodexProjectForPath({ path, pinned, catalog, pack });
    } catch (error) {
      // Aggregate rather than abort: a machine-wide command should report every
      // refusal at once, which is the behaviour this command already had.
      const conflict = /^refusing unmanaged project config (.*)$/.exec(error.message);
      if (!conflict) throw error;
      conflicts.push(conflict[1]);
      continue;
    }
    if (planned.missing) { missing.push(planned.missing); continue; }
    if (planned.skip) { if (!pinned) unpinnedSkip = planned.skip; continue; }
    if (planned.manual) { manual.push(planned.manual); continue; }
    if (seen.has(planned.config.path)) continue;
    seen.add(planned.config.path);
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

Add `existsSync`/`statSync` to the `node:fs` import if not already present, and `resolveIdentity`, `projectKeyFor`, `displayProject` are already imported.

- [ ] **Step 5: Run the new test and the existing Codex suites**

Run: `node --test test/install-codex-single.test.js test/codex.test.js test/codex-pets.test.js test/bin-familiar.test.js`
Expected: PASS. The existing `--sync-projects` behaviour is unchanged — same aggregate conflict message, same skip and manual reporting.

- [ ] **Step 6: Commit**

```bash
git add src/install/codex.js test/install-codex-single.test.js
git commit -m "refactor(codex): plan one project's pet config without touching the rest"
```

---

### Task 2: A compile stamp that identifies inputs, not provenance

Per spec §4.4.1 the theme receipt cannot answer "was this pet compiled from the bytes on disk now" — `local` receipts carry no commit, absent receipts are normal, and an `https` receipt is unchanged by in-place art edits. The stamp hashes what actually determined the output.

**Files:**
- Create: `src/install/pet-stamp.js`
- Modify: `bin/familiar` (the `install pets` branch)
- Test: `test/pet-stamp.test.js` (create)

**Interfaces:**
- Produces: `STAMP_VERSION` (number), `STAMP_FILE` (`'familiar-stamp.json'`), `stampFor({ themeId, memberId, frame, motionPolicy, anchor, inputs })` → `{ version, themeId, memberId, frame, motionPolicy, anchor, content }` where `inputs` is an array of `Uint8Array` and `content` is an 8-hex-digit string; `readStamp(dir)` → the parsed object or `null`.

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

test('the same bytes stamp the same, in order', () => {
  const a = stampFor({ ...base, inputs: [Uint8Array.from([1, 2]), Uint8Array.from([3])] });
  const b = stampFor({ ...base, inputs: [Uint8Array.from([1, 2]), Uint8Array.from([3])] });
  assert.equal(a.content, b.content);
  assert.equal(a.version, STAMP_VERSION);
});

test('editing art in place changes the stamp — this is the case a receipt cannot see', () => {
  const before = stampFor({ ...base, inputs: [Uint8Array.from([1, 2, 3])] });
  const after = stampFor({ ...base, inputs: [Uint8Array.from([1, 2, 4])] });
  assert.notEqual(before.content, after.content);
});

test('reordering inputs changes the stamp — frame order determines the sheet', () => {
  const a = stampFor({ ...base, inputs: [Uint8Array.from([1]), Uint8Array.from([2])] });
  const b = stampFor({ ...base, inputs: [Uint8Array.from([2]), Uint8Array.from([1])] });
  assert.notEqual(a.content, b.content);
});

test('the compiler contract is part of the stamp, not just the art', () => {
  const art = [Uint8Array.from([1])];
  const full = stampFor({ ...base, inputs: art });
  assert.notEqual(stampFor({ ...base, motionPolicy: 'reduced', inputs: art }).content, full.content);
  assert.notEqual(stampFor({ ...base, anchor: 'center', inputs: art }).content, full.content);
  assert.notEqual(
    stampFor({ ...base, frame: { ...base.frame, rows: 8 }, inputs: art }).content, full.content);
});

test('readStamp returns null rather than throwing when there is no stamp', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-stamp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readStamp(dir), null);
  writeFileSync(join(dir, STAMP_FILE), 'not json');
  assert.equal(readStamp(dir), null, 'an unreadable stamp is absent, not fatal');
  writeFileSync(join(dir, STAMP_FILE), JSON.stringify(stampFor({ ...base, inputs: [] })));
  assert.equal(readStamp(dir).memberId, 'ginger');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/pet-stamp.test.js`
Expected: FAIL — cannot find module `../src/install/pet-stamp.js`.

- [ ] **Step 3: Write the module**

```js
// src/install/pet-stamp.js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fnv1a32Bytes } from '../protocol/hash.js';

// PROVENANCE CANNOT ANSWER THIS QUESTION, which is why this file exists rather
// than a copy of the theme receipt. A `local` receipt carries no commit at all
// (src/theme/receipt.js validates it as { kind, path }), an absent receipt is
// normal for any other install route, and an `https` receipt is unchanged when
// the installed artwork is edited in place. "Where did this theme come from" is
// a different question from "was this pet built from the bytes on disk now".
export const STAMP_VERSION = 1;
export const STAMP_FILE = 'familiar-stamp.json';

// Length-prefixed, so concatenation is unambiguous: without it, [0x01,0x02] and
// [0x02] would hash the same as [0x01] and [0x02,0x02].
function contentHash(inputs) {
  let h = fnv1a32Bytes(new TextEncoder().encode(`v${STAMP_VERSION}`));
  for (const bytes of inputs) {
    h = fnv1a32Bytes(new TextEncoder().encode(`:${bytes.length}:`), h);
    h = fnv1a32Bytes(bytes, h);
  }
  return h.toString(16).padStart(8, '0');
}

// The compiler contract belongs in the stamp alongside the art: a change to the
// frame geometry, the motion policy, or the member's anchor invalidates the
// compiled sheet exactly as surely as new pixels do.
export function stampFor({ themeId, memberId, frame, motionPolicy, anchor, inputs }) {
  const contract = new TextEncoder().encode(JSON.stringify({
    themeId, memberId, frame, motionPolicy, anchor,
  }));
  return {
    version: STAMP_VERSION,
    themeId,
    memberId,
    frame,
    motionPolicy,
    anchor,
    content: contentHash([contract, ...inputs]),
  };
}

// ABSENT AND UNREADABLE ARE THE SAME ANSWER, and both are normal: every pet
// compiled before this file existed has no stamp. A caller decides what to do
// about it; throwing here would make an old install a crash.
export function readStamp(dir) {
  let text;
  try {
    text = readFileSync(join(dir, STAMP_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(text);
    return data?.version === STAMP_VERSION ? data : null;
  } catch {
    return null;
  }
}
```

`fnv1a32Bytes` currently takes only `bytes`. Add an optional seed so the loop can chain without allocating a joined buffer:

```js
// src/protocol/hash.js — change the signature, keeping the default identical
export function fnv1a32Bytes(bytes, seed = 0x811c9dc5) {
  let h = seed;
  ...
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/pet-stamp.test.js test/hash.test.js`
Expected: PASS, including the existing hash suite — the default seed keeps `fnv1a32` byte-identical, which matters because it decides every unpinned project's character.

- [ ] **Step 5: Write the stamp from `install pets`**

In `bin/familiar`, inside the `for (const [memberId, member] of ctx.pack.members)` loop of the `install pets` branch, collect the input bytes as they are already being read and write the stamp beside `pet.json`:

```js
const stampInputs = [];
const poses = Object.fromEntries(STATES.map((state) => {
  const bytes = readFileSync(assets[state].terminal);
  stampInputs.push(bytes);
  return [state, decodeRgba(bytes)];
}));
const { set: animationSet } = await loadAnimationMember(ctx.pack, memberId);
...
writeFileSync(join(dir, SPRITESHEET_PATH), encodeRgba(spritesheet({
  animationSet,
  roots: poses,
  anchor: member.anchor,
  motionPolicy: ctx.motionPolicy,
  readFrame: (path) => {
    const bytes = readFileSync(path);
    stampInputs.push(bytes);
    return decodeRgba(bytes);
  },
})));
writeFileSync(join(dir, STAMP_FILE), JSON.stringify(stampFor({
  themeId: ctx.themeId,
  memberId,
  frame: FRAME,
  motionPolicy: ctx.motionPolicy,
  anchor: member.anchor ?? 'floor',
  inputs: stampInputs,
}), null, 2) + '\n');
```

Import `FRAME` from `../src/render/codex/pets.js` and `{ STAMP_FILE, stampFor }` from `../src/install/pet-stamp.js`.

Note: `readFrame` is only called for frames the compiler actually samples, and only on a cache miss inside `sampledFrames`, so `stampInputs` records exactly the bytes that shaped this sheet.

- [ ] **Step 6: Run the suite and commit**

Run: `just test`
Expected: PASS.

```bash
git add src/install/pet-stamp.js src/protocol/hash.js bin/familiar test/pet-stamp.test.js
git commit -m "feat(codex): stamp each compiled pet with its compiler inputs"
```

---

### Task 3: The asset gate the hook can afford

Per spec §4.4.2 the hook answers "is this pet from the active theme's roster", never "is its art current". The content check belongs to `install pets`, which already has the bytes open.

**Files:**
- Modify: `src/install/pet-stamp.js`
- Test: `test/pet-stamp.test.js`

**Interfaces:**
- Produces: `petUsable({ petsDir, themeId, memberId })` → `{ ok: true }` or `{ ok: false, reason: string }`. Reads at most two small files. Never hashes.

- [ ] **Step 1: Write the failing test**

```js
// append to test/pet-stamp.test.js
import { mkdirSync } from 'node:fs';
import { petUsable } from '../src/install/pet-stamp.js';
import { SPRITESHEET_PATH } from '../src/render/codex/pets.js';

function pet(dir, id, stamp) {
  const petDir = join(dir, id);
  mkdirSync(join(petDir, 'assets'), { recursive: true });
  writeFileSync(join(petDir, SPRITESHEET_PATH), 'png');
  if (stamp) writeFileSync(join(petDir, STAMP_FILE), JSON.stringify(stamp));
  return petDir;
}

test('the gate accepts a pet stamped for this theme and member', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-pets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  pet(dir, 'familiar-ginger', stampFor({ ...base, inputs: [] }));
  assert.deepEqual(petUsable({ petsDir: dir, themeId: 'cats', memberId: 'ginger' }), { ok: true });
});

test('the gate refuses absent, unstamped, and foreign-theme pets, and says which', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-pets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let verdict = petUsable({ petsDir: dir, themeId: 'cats', memberId: 'ginger' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not installed/);

  pet(dir, 'familiar-tuxedo', null);
  verdict = petUsable({ petsDir: dir, themeId: 'cats', memberId: 'tuxedo' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no stamp/);

  pet(dir, 'familiar-persian', stampFor({ ...base, themeId: 'dogs', memberId: 'persian', inputs: [] }));
  verdict = petUsable({ petsDir: dir, themeId: 'cats', memberId: 'persian' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /theme "dogs"/);
});

test('a stamp without its spritesheet is refused — the stamp is not the asset', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-pets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const petDir = join(dir, 'familiar-ginger');
  mkdirSync(petDir, { recursive: true });
  writeFileSync(join(petDir, STAMP_FILE), JSON.stringify(stampFor({ ...base, inputs: [] })));
  const verdict = petUsable({ petsDir: dir, themeId: 'cats', memberId: 'ginger' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /spritesheet/);
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

// WHAT A HOOK CAN AFFORD, AND NOTHING MORE. This answers "is this pet from the
// active theme's roster", which is two small file reads. It deliberately does
// NOT answer "is its art current with the theme's files": that needs the source
// bytes hashed, and hashing on the hook path is the unbounded work the timeout
// argument in ../bus/identity.js exists to keep out. `install pets` owns that
// question -- it already has the bytes open.
export function petUsable({ petsDir, themeId, memberId }) {
  const dir = join(petsDir, `familiar-${memberId}`);
  if (!existsSync(dir)) {
    return { ok: false, reason: `pet "familiar-${memberId}" is not installed` };
  }
  if (!existsSync(join(dir, SPRITESHEET_PATH))) {
    return { ok: false, reason: `pet "familiar-${memberId}" has no spritesheet` };
  }
  const stamp = readStamp(dir);
  if (!stamp) {
    return { ok: false, reason: `pet "familiar-${memberId}" has no stamp from this version of Familiar` };
  }
  if (stamp.themeId !== themeId) {
    return {
      ok: false,
      reason: `pet "familiar-${memberId}" was compiled for theme "${stamp.themeId}", not "${themeId}"`,
    };
  }
  if (stamp.memberId !== memberId) {
    return {
      ok: false,
      reason: `pet "familiar-${memberId}" carries a stamp for member "${stamp.memberId}"`,
    };
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
git commit -m "feat(codex): gate a pet selection on installed, correctly-stamped assets"
```

---

### Task 4: Converge the config from the Codex `SessionStart` hook

**Files:**
- Create: `src/install/codex-converge.js`
- Modify: `bin/familiar` (the `hook` branch)
- Test: `test/codex-converge.test.js` (create)

**Interfaces:**
- Produces: `convergeCodexProject({ cwd, catalog, pack, themeId, petsDir })` → `{ changed: boolean, member?: string, reason?: string }`. Never throws for an ordinary refusal; returns `reason`.

- [ ] **Step 1: Write the failing test**

```js
// test/codex-converge.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadThemePackSync } from 'familiar-theme';
import { convergeCodexProject } from '../src/install/codex-converge.js';
import { stampFor, STAMP_FILE } from '../src/install/pet-stamp.js';
import { SPRITESHEET_PATH, FRAME } from '../src/render/codex/pets.js';

const THEME = loadThemePackSync(new URL('./fixtures/theme', import.meta.url).pathname);

function petsFor(t, pack, themeId) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-pets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [memberId, member] of pack.members) {
    const petDir = join(dir, `familiar-${memberId}`);
    mkdirSync(join(petDir, 'assets'), { recursive: true });
    writeFileSync(join(petDir, SPRITESHEET_PATH), 'png');
    writeFileSync(join(petDir, STAMP_FILE), JSON.stringify(stampFor({
      themeId, memberId, frame: FRAME, motionPolicy: 'full',
      anchor: member.anchor ?? 'floor', inputs: [],
    })));
  }
  return dir;
}

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-converge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin',
    'git@github.com:example/converge.git'], { encoding: 'utf8' });
  return dir;
}

test('a repository with no config gets one, and the exclude entry with it', async (t) => {
  const root = repo(t);
  const petsDir = petsFor(t, THEME, THEME.id);
  const result = await convergeCodexProject({
    cwd: root, catalog: { identities: [] }, pack: THEME, themeId: THEME.id, petsDir,
  });
  assert.equal(result.changed, true);
  const written = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(written, new RegExp(`pet = "custom:familiar-${result.member}"`));
  assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /\.codex\/config\.toml/);
});

test('a second run with nothing changed writes nothing', async (t) => {
  const root = repo(t);
  const petsDir = petsFor(t, THEME, THEME.id);
  const args = { cwd: root, catalog: { identities: [] }, pack: THEME, themeId: THEME.id, petsDir };
  await convergeCodexProject(args);
  const before = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
  const again = await convergeCodexProject(args);
  assert.equal(again.changed, false);
  assert.equal(readFileSync(join(root, '.codex', 'config.toml'), 'utf8'), before);
});

test('a pin change converges the file on the next call', async (t) => {
  const root = repo(t);
  const petsDir = petsFor(t, THEME, THEME.id);
  const first = await convergeCodexProject({
    cwd: root, catalog: { identities: [] }, pack: THEME, themeId: THEME.id, petsDir,
  });
  const second = await convergeCodexProject({
    cwd: root, catalog: { identities: [{ path: root, slot: 3 }] },
    pack: THEME, themeId: THEME.id, petsDir,
  });
  assert.equal(second.changed, true);
  assert.notEqual(second.member, first.member);
});

test('an unmanaged config is left alone and reported, never rewritten', async (t) => {
  const root = repo(t);
  const petsDir = petsFor(t, THEME, THEME.id);
  mkdirSync(join(root, '.codex'), { recursive: true });
  writeFileSync(join(root, '.codex', 'config.toml'), '[tui]\npet = "mine"\n');
  const result = await convergeCodexProject({
    cwd: root, catalog: { identities: [] }, pack: THEME, themeId: THEME.id, petsDir,
  });
  assert.equal(result.changed, false);
  assert.match(result.reason, /unmanaged/);
  assert.equal(readFileSync(join(root, '.codex', 'config.toml'), 'utf8'), '[tui]\npet = "mine"\n');
});

test('a member whose assets are missing is NOT selected — a broken selection is worse than a stale one', async (t) => {
  const root = repo(t);
  const petsDir = mkdtempSync(join(tmpdir(), 'familiar-pets-empty-'));
  t.after(() => rmSync(petsDir, { recursive: true, force: true }));
  const result = await convergeCodexProject({
    cwd: root, catalog: { identities: [] }, pack: THEME, themeId: THEME.id, petsDir,
  });
  assert.equal(result.changed, false);
  assert.match(result.reason, /not installed/);
  assert.match(result.reason, /familiar install pets/);
  assert.equal(existsSync(join(root, '.codex', 'config.toml')), false);
});

test('outside a Git repository nothing is written', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-bare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const petsDir = petsFor(t, THEME, THEME.id);
  const result = await convergeCodexProject({
    cwd: dir, catalog: { identities: [] }, pack: THEME, themeId: THEME.id, petsDir,
  });
  assert.equal(result.changed, false);
  assert.equal(existsSync(join(dir, '.codex')), false);
});
```

Add `existsSync` to the test's `node:fs` import.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test test/codex-converge.test.js`
Expected: FAIL — cannot find module `../src/install/codex-converge.js`.

- [ ] **Step 3: Implement convergence**

```js
// src/install/codex-converge.js
import { planCodexProjectForPath, applyCodexProjectSync } from './codex.js';
import { petUsable } from './pet-stamp.js';

// ONE REPOSITORY, ON SessionStart, AND ONE LAUNCH LATE BY CONSTRUCTION.
// docs/specs/2026-09-05-codex-identity-parity-design.md §6.1 measured it: Codex
// reads `[tui] pet` at TUI start, and no hook of any kind runs before the first
// turn, so what this writes is read by the NEXT launch. That is the ceiling, not
// a bug to fix here -- and it is why nothing in this file tries to signal Codex.
//
// EVERY ORDINARY REFUSAL IS A RETURN, NOT A THROW. This runs inside a cosmetic
// hook: an unmanaged config, a tracked one, a missing pet and a non-repository
// are all normal states of a user's machine, and none of them may take down the
// session's hook.
export async function convergeCodexProject({ cwd, catalog, pack, themeId, petsDir }) {
  let planned;
  try {
    planned = await planCodexProjectForPath({ path: cwd, pinned: false, catalog, pack });
  } catch (error) {
    return { changed: false, reason: error.message };
  }

  if (planned.missing) return { changed: false, reason: `no such directory: ${planned.missing}` };
  if (planned.skip) return { changed: false, reason: planned.skip.reason };
  if (planned.manual) return { changed: false, reason: `tracked project config: ${planned.manual.path}` };

  const member = planned.identity.member;

  // THE GATE COMES BEFORE THE WRITE. Selecting a pet whose assets are absent or
  // belong to another theme replaces a stale-but-drawable selection with one
  // that draws nothing, which is strictly worse.
  const usable = petUsable({ petsDir, themeId, memberId: member });
  if (!usable.ok) {
    return { changed: false, member, reason: `${usable.reason} — run \`familiar install pets\`` };
  }

  if (planned.config.before === planned.config.text) return { changed: false, member };

  applyCodexProjectSync({
    configs: [planned.config],
    excludes: planned.exclude ? [planned.exclude] : [],
  });
  return { changed: true, member };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex-converge.test.js`
Expected: PASS.

- [ ] **Step 5: Call it from the hook, for Codex `SessionStart` only**

In `bin/familiar`, in the `hook` branch, after `emitHookTransition(...)`:

```js
// CODEX ONLY, SessionStart ONLY. claude-code needs none of this -- Familiar
// draws its status line itself, from the bus, live. This exists solely because
// Codex draws its own pet from a file, so the file has to be kept true.
//
// SessionStart only: this is the one event per session, and the write is
// pointless more often than that. PreToolUse fires on every tool call.
if (name === 'codex' && positionals[0] === 'SessionStart') {
  try {
    const { cwd } = adapter.parsePayload(stdin);
    const result = await convergeCodexProject({
      cwd,
      catalog: ctx.catalog,
      pack: ctx.pack,
      themeId: ctx.themeId,
      petsDir: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'pets'),
    });
    // ONE LINE, ON STDERR, ONLY WHEN A USER CAN ACT ON IT. A hook that narrates
    // every no-op is a hook people turn off.
    if (!result.changed && result.reason?.includes('familiar install pets')) {
      process.stderr.write(`familiar: ${result.reason}\n`);
    }
  } catch (error) {
    // The cosmetic layer never degrades the tool it decorates. The boundary in
    // this file turns a throw into exit 0 with one stderr line; this narrower
    // catch keeps a convergence failure from skipping anything after it.
    process.stderr.write(`familiar: could not converge the Codex pet config: ${error.message}\n`);
  }
}
```

Import `convergeCodexProject` from `../src/install/codex-converge.js`.

- [ ] **Step 6: Add the end-to-end hook test**

```js
// append to test/codex-converge.test.js
test('the codex SessionStart hook converges the project config; other events do not', (t) => {
  // Mirrors test/bin-familiar.test.js: spawn bin/familiar with an isolated
  // FAMILIAR_STATE_DIR and a payload naming the temp repository as cwd.
  // Assert: after `hook SessionStart --agent codex`, <repo>/.codex/config.toml
  // exists and names the resolved member; after `hook PreToolUse --agent codex`
  // against a repository with no config, none is written.
});
```

Fill this in following the spawn/env helpers already at the top of `test/bin-familiar.test.js` (`env()`, `bin`, `runEnv`). The assertions are as written in the comment.

- [ ] **Step 7: Run the suite and commit**

Run: `just test`
Expected: PASS.

```bash
git add src/install/codex-converge.js bin/familiar test/codex-converge.test.js
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
