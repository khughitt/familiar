# Pack Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A theme pack is its descriptor and what the descriptor names. The contract's gate validates only that content, and `familiar theme add` installs only that content, so working theme checkouts validate and install as they stand.

**Architecture:** `familiar-theme` gains one pure, exported rule, `packEntryRole(pack, relPath)`, and its gate walks the pack root by role, reading the descriptor exactly once. It is released as v0.3.0. The engine bumps to it. `copySource` stages `theme.yaml` first, parses the staged bytes, and copies only `content` and `ancestor` entries. Both transports then promote `<run>/pack`; a clone is first made in `<run>/clone`.

**Tech Stack:** Node ≥ 22 ESM, `node:test`, `node:fs/promises`; the `familiar-theme` git dependency; `just` (engine), `npm test` (contract package).

**Spec:** `docs/specs/2026-10-14-pack-content-design.md` (approved 2026-10-14). The 2026-08-18 theme-add spec's §2 step 4 and §3 "Local copy" are amended by it.

## Global Constraints

- The licence rule is exactly: the path's first segment matches `/^(licen|copying|notice)/i`, and everything beneath such a directory is content.
- `asset-root` semantics are unchanged: relative, no empty, `.` or `..` segments, ending in `sprites/<member-id>`.
- `SPEC_VERSION` does not change. A pack that passed v0.2.0 must pass v0.3.0.
- The engine imports only from `familiar-theme`'s package export (`src/index.js`), never a deep path.
- Every failure is a named, single-line message naming the path. Inside content, symlinks, FIFOs, sockets and devices still fail by path. `.git` is never copied.
- The gate reads the descriptor once. The roles, the walk and `loadThemePack` share those bytes.
- In the engine, the selection is parsed from the **staged** descriptor's bytes, and the walk never copies the root `theme.yaml` a second time.
- Every installed byte was validated by the gate. Both transports promote `<run>/pack`, never a whole clone.
- Engine tests run only through `just test-fast` (the project's test front door). The contract package has no justfile: use `npm test`, or `node --test <file>` for one file.
- Pushing `familiar-theme` (branch and tag) is an external action: stop and get the user's approval at Task 3 Step 6.

## Review Focus

1. **A source path that is itself a symlink to a checkout** (a checkout reached through a linked directory). Expected: it resolves through `realpath` and installs. Pinned in Task 5.
2. **Outside siblings under a shared ancestor** (`sprites/README.md`, `sprites/.DS_Store` beside `sprites/solo/`). Expected: skipped, never installed. Pinned in Task 4.
3. **Case and suffix variants of licence names** (`License.md`, `copying.txt`, `NOTICE`, `LICENSES/`). Expected: content. Pinned in Task 1.
4. **A `.git` inside a member tree** (`sprites/solo/.git/`). Expected: never copied, even though it is under content. Pinned in Task 4.
5. **A checkout whose clutter alone exceeds `MAX_ENTRY_COUNT`** (a `node_modules/` or `.venv/` with hundreds of entries). Expected: installs, because neither the copy nor the gate counts `outside` entries. Pinned in Task 5.

---

## Setup (once, before Task 1)

The engine worktree already exists: `.worktrees/theme-add-copy` on branch `fix/theme-add-copy`. The contract package lives in its own repository, `familiar-theme`, a sibling of the engine's main checkout.

- [ ] In the `familiar-theme` checkout: `work-link --ensure .worktrees`, then `git worktree add -b feat/pack-content .worktrees/pack-content main`, then `git worktree lock --reason "on WORK_ROOT storage (host: $(uname -n))" .worktrees/pack-content`, then `npm ci` inside it.
- [ ] Baseline: `npm test` in that worktree passes, and `just test-fast` in the engine worktree passes. Record both counts in a `tasks note` on fam-13999b.

---

### Task 1: `packEntryRole`, the pack-content rule (familiar-theme)

**Files:**
- Create: `src/theme/content.js`
- Modify: `src/index.js` (add the export)
- Test: `test/content.test.js` (new)

**Interfaces:**
- Consumes: `parseThemePack(text, dir)` from `src/theme/pack.js`. It returns `{ members: Map<id, { assetRoot: string, … }> }`, where `assetRoot` is the `/`-joined `asset-root`.
- Produces: `packEntryRole(pack, relPath) -> 'content' | 'ancestor' | 'outside'`, exported from `familiar-theme`. `relPath` is a nonempty `/`-joined relative path with no empty, `.` or `..` segments. Anything else throws `packEntryRole: expected a relative / path, got <json>`.

- [ ] **Step 1: Write the failing test**

`test/content.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packEntryRole, parseThemePack } from 'familiar-theme';
import { DESCRIPTOR } from './helpers/fixture.js';

// Two members with different ancestors. Every slot needs a member and no member
// may hold none, so solo gives up slot 11 to duo.
const TWO = DESCRIPTOR.replace(
  'slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]',
  'slots: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]',
).replace(
  'members:\n',
  `members:
  - id: duo
    label: Duo
    slots: [11]
    persona: second fixture
    asset-root: art/sprites/duo
    animation:
      kind: static
    poses:
      idle: i
      working: w
      needs-input: n
      needs-approval: a
      error: e
      done: d
`,
);
const pack = parseThemePack(TWO, '/pack');

test('the descriptor and licence entries are content', () => {
  for (const rel of [
    'theme.yaml', 'LICENSE', 'LICENSE-assets', 'License.md', 'LICENCE.txt',
    'copying.txt', 'COPYING', 'NOTICE', 'notice.md', 'LICENSES',
    'LICENSES/MIT.txt', 'LICENSES/assets/CC-BY-4.0.txt', 'licensed-art/a.png',
  ]) assert.equal(packEntryRole(pack, rel), 'content', rel);
});

test('member trees are content at every depth', () => {
  for (const rel of [
    'sprites/solo', 'sprites/solo/idle.png', 'sprites/solo/animation/idle/f01.png',
    'art/sprites/duo', 'art/sprites/duo/provenance.json',
  ]) assert.equal(packEntryRole(pack, rel), 'content', rel);
});

test('proper prefixes of an asset-root are ancestors, shared or not', () => {
  for (const rel of ['sprites', 'art', 'art/sprites']) {
    assert.equal(packEntryRole(pack, rel), 'ancestor', rel);
  }
});

test('everything else is outside, including siblings under an ancestor', () => {
  for (const rel of [
    '.worktrees', '.superpowers', '.superpowers/x', 'README.md', 'docs', 'docs/a.md',
    '.git', 'sprites/README.md', 'sprites/.DS_Store', 'sprites/solo-old',
    'art/README', 'art/sprites/other', 'theme.yaml.bak', 'node_modules',
  ]) assert.equal(packEntryRole(pack, rel), 'outside', rel);
});

test('a malformed relative path is a named error, not a role', () => {
  for (const rel of ['', '/abs', 'a//b', './a', 'a/../b', 'a/.', 7]) {
    assert.throws(() => packEntryRole(pack, rel), /packEntryRole: expected a relative \/ path/);
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test test/content.test.js`
Expected: FAIL. `packEntryRole` is not exported (`SyntaxError: The requested module 'familiar-theme' does not provide an export named 'packEntryRole'`).

- [ ] **Step 3: Write the implementation**

`src/theme/content.js`:

```js
// Pack content (familiar docs/specs/2026-10-14-pack-content-design.md §1). A
// pack is its descriptor and what the descriptor names, not the directory that
// holds it. Content is closed under descent: both content subtrees (licence
// directories and member asset trees) are defined by a prefix of the path, so a
// walker that asks at every depth never drops a descendant.
//
// The licence rule is the one convention here: an installed copy keeps the terms
// its assets were granted under, and every repository already names those files
// this way. It is deliberately broad; a false positive installs one more small
// file, which the gate still validates.
const LICENCE_NAME = /^(licen|copying|notice)/i;

export function packEntryRole(pack, relPath) {
  const segments = typeof relPath === 'string' && relPath !== '' && !relPath.startsWith('/')
    ? relPath.split('/') : null;
  if (segments === null || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`packEntryRole: expected a relative / path, got ${JSON.stringify(relPath)}`);
  }
  if (relPath === 'theme.yaml' || LICENCE_NAME.test(segments[0])) return 'content';
  let ancestor = false;
  for (const member of pack.members.values()) {
    const root = member.assetRoot.split('/');
    let shared = 0;
    while (shared < root.length && shared < segments.length
      && root[shared] === segments[shared]) shared += 1;
    if (shared === root.length) return 'content';
    if (shared === segments.length) ancestor = true;
  }
  return ancestor ? 'ancestor' : 'outside';
}
```

`src/index.js`: add the export line after the `assetsFor` export:

```js
export { packEntryRole } from './theme/content.js';
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `node --test test/content.test.js`, then `npm test`
Expected: PASS. The full suite stays green.

- [ ] **Step 5: Commit**

```bash
git add src/theme/content.js src/index.js test/content.test.js
git commit -m "feat(pack): packEntryRole, the pack-content rule"
```

---

### Task 2: the gate walks pack content, reading the descriptor once (familiar-theme)

**Files:**
- Modify: `src/validate.js` (`preflight`, `validateThemePackWithLoader`, `validateResolved`; new `readDescriptor`, `kindOf`)
- Modify: `test/validate-preflight.test.js` (relocate root fixtures; new cases)
- Test: `test/validate-content.test.js` (new)

**Interfaces:**
- Consumes: `packEntryRole` (Task 1); `parseThemePack(text, dir, { descriptorLabel })`; `loadThemePack(dir, { descriptorPath, descriptorLabel, readFile })`. `loadThemePack` reads the descriptor only through `readFile(descriptorRealPath, 'utf8')`.
- Produces:
  - `validateThemePack(dir, { descriptorPath })`: same signature and return value. It now ignores `outside` entries.
  - `validateThemePackWithLoader(dir, { descriptorPath, loadAnimation, afterDescriptorRead })`: an intra-package test seam. `afterDescriptorRead(path)` runs once, after the descriptor's single read and before the walk. It is not exported from `src/index.js`.

- [ ] **Step 1: Relocate the existing root fixtures in `test/validate-preflight.test.js`**

Root entries become `outside` and would be skipped, so each fixture that must still be examined moves into the member tree. Make exactly these edits:

- `'a symlink is rejected by type even when it points INSIDE the pack'`: the link becomes `join(dir, 'sprites', 'solo', 'inner-link')`. The regex stays `/inner-link.*symlink/`.
- `'a unix socket is rejected by type'`: listen on `join(dir, 'sprites', 'solo', 'sock')`.
- `'a FIFO is rejected by type, not opened …'`: `mkfifo` at `join(dir, 'sprites', 'solo', 'trap')`. The old `sprites/trap` is now an `outside` sibling.
- `'an empty-directory tree breaches MAX_ENTRY_COUNT …'`: both loops create `join(at|over, 'sprites', 'solo', \`d${i}\`)`. The arithmetic (`MAX_ENTRY_COUNT - 9`) is unchanged, because `sprites` is an ancestor and is still counted.
- `'MAX_TOTAL_BYTES: sparse filler …'`: `fill` writes `join(dir, 'sprites', 'solo', 'filler.bin')`.
- `'a candidate descriptorPath replaces theme.yaml …'`: the loop creates `join(dir, 'sprites', 'solo', \`d${i}\`)`.
- `'a pack at EXACTLY both limits …'`: the loop creates `join(dir, 'sprites', 'solo', \`d${i}\`)`, and both filler writes use `join(dir, 'sprites', 'solo', 'filler.bin')`. `logicalBytes` is unchanged: it already skips the root descriptors, and nothing else is left at the root.

Run: `npm test`
Expected: PASS. The relocated fixtures are still under content, so the v0.2.0 gate rejects or counts them exactly as before. This step proves the relocations are behaviour-neutral before the gate changes.

- [ ] **Step 2: Write the failing tests**

`test/validate-content.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync, ftruncateSync, mkdirSync, openSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { LIMITS, validateThemePack } from 'familiar-theme';
import { validateThemePackWithLoader } from '../src/validate.js';
import { DESCRIPTOR, writePack } from './helpers/fixture.js';

const pack = (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n';

test('a working checkout validates: clutter outside the pack is never examined', async (t) => {
  const dir = pack(t);
  symlinkSync('../elsewhere/.worktrees', join(dir, '.worktrees'));
  mkdirSync(join(dir, '.superpowers'));
  symlinkSync('/etc/passwd', join(dir, '.superpowers', 'link'));
  writeFileSync(join(dir, 'README.md'), POINTER);
  mkdirSync(join(dir, 'docs'));
  symlinkSync('../theme.yaml', join(dir, 'docs', 'alias.yaml'));
  writeFileSync(join(dir, 'sprites', 'README.md'), POINTER);
  execFileSync('mkfifo', [join(dir, 'pipe')]);
  const server = createServer();
  await new Promise((ok) => server.listen(join(dir, 'sock'), ok));
  t.after(() => server.close());
  const p = await validateThemePack(dir);
  assert.equal(p.id, 'gate-fixture');
});

test('the entry and byte bounds count pack content only', async (t) => {
  const dir = pack(t);
  for (let i = 0; i < LIMITS.MAX_ENTRY_COUNT + 1; i++) mkdirSync(join(dir, 'node_modules', `m${i}`), { recursive: true });
  const fd = openSync(join(dir, 'big.bin'), 'w');
  ftruncateSync(fd, LIMITS.MAX_TOTAL_BYTES + 1);
  closeSync(fd);
  await validateThemePack(dir);
});

test('an ancestor of an asset-root must be a real directory', async (t) => {
  const dir = pack(t);
  renameSync(join(dir, 'sprites'), join(dir, 'real-sprites'));
  symlinkSync('real-sprites', join(dir, 'sprites'));
  await assert.rejects(() => validateThemePack(dir), /^Error: sprites: is a symlink/);
});

test('a symlink inside a member tree still fails by path', async (t) => {
  const dir = pack(t);
  symlinkSync('/etc/passwd', join(dir, 'sprites', 'solo', 'evil.txt'));
  await assert.rejects(() => validateThemePack(dir), /sprites\/solo\/evil\.txt: is a symlink/);
});

test('licence directories are walked at every depth', async (t) => {
  const nested = pack(t);
  mkdirSync(join(nested, 'LICENSES', 'assets'), { recursive: true });
  writeFileSync(join(nested, 'LICENSES', 'MIT.txt'), 'MIT');
  writeFileSync(join(nested, 'LICENSES', 'assets', 'CC-BY-4.0.txt'), POINTER);
  await assert.rejects(() => validateThemePack(nested),
    /LICENSES\/assets\/CC-BY-4\.0\.txt is a Git LFS pointer/);

  const linked = pack(t);
  mkdirSync(join(linked, 'LICENSES'));
  symlinkSync('/etc/passwd', join(linked, 'LICENSES', 'MIT.txt'));
  await assert.rejects(() => validateThemePack(linked), /LICENSES\/MIT\.txt: is a symlink/);

  const piped = pack(t);
  mkdirSync(join(piped, 'LICENSES'));
  execFileSync('mkfifo', [join(piped, 'LICENSES', 'pipe')]);
  await assert.rejects(() => validateThemePack(piped), /LICENSES\/pipe: is a FIFO/);
});

test('a root licence symlink fails by path', async (t) => {
  const dir = pack(t);
  symlinkSync('/etc/passwd', join(dir, 'LICENSE'));
  await assert.rejects(() => validateThemePack(dir), /LICENSE: is a symlink/);
});

test('the descriptor is read once: a rewrite through an outside alias is never seen', async (t) => {
  const dir = pack(t);
  symlinkSync('.', join(dir, 'alias'));
  let reads = 0;
  const p = await validateThemePackWithLoader(dir, {
    afterDescriptorRead() {
      reads += 1;
      writeFileSync(join(dir, 'theme.yaml'),
        DESCRIPTOR.replace('asset-root: sprites/solo', 'asset-root: alias/sprites/solo'));
    },
  });
  assert.equal(reads, 1);
  assert.equal(p.members.get('solo').assetRoot, 'sprites/solo');
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `node --test test/validate-content.test.js`
Expected: FAIL. The clutter test rejects on `.worktrees` (or another root entry), the bounds test rejects on `MAX_ENTRY_COUNT`, and the drift test fails because `afterDescriptorRead` is never called (`reads` is 0). The ancestor, member-tree, licence and root-licence tests may already pass: they pin behaviour that must survive the change.

- [ ] **Step 4: Write the implementation**

In `src/validate.js`:

1. Add `constants` to the `node:fs` imports (`import { constants } from 'node:fs';`), import `parseThemePack` beside `loadThemePack` from `./theme/pack.js`, and import `packEntryRole` from `./theme/content.js`.
2. Add these helpers above `preflight`:

```js
const kindOf = (stat, entry) => (stat.isSymbolicLink() || entry?.isSymbolicLink() ? 'a symlink'
  : stat.isFIFO() ? 'a FIFO' : stat.isSocket() ? 'a socket'
  : stat.isFile() ? 'a regular file' : 'not a regular file');

// The descriptor's one read (spec §2): roles, walk and load all use these bytes.
// A second read could be rewritten to name an outside alias that resolves to an
// already-walked directory, and coverage would pass through it.
async function readDescriptor(path, rel) {
  const stat = await fsLstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(rel, `is ${kindOf(stat)} — packs may contain only regular files and directories`);
  }
  if (stat.size > LIMITS.MAX_DESCRIPTOR_BYTES) {
    fail(rel, `is ${stat.size} bytes — descriptors are bounded at ${LIMITS.MAX_DESCRIPTOR_BYTES} (MAX_DESCRIPTOR_BYTES)`);
  }
  const handle = await fsOpen(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const held = await handle.stat();
    if (!held.isFile() || held.dev !== stat.dev || held.ino !== stat.ino) {
      fail(rel, 'changed while the gate read it — validate a stable pack');
    }
    const bytes = await handle.readFile();
    if (bytes.length > LIMITS.MAX_DESCRIPTOR_BYTES) {
      fail(rel, `is ${bytes.length} bytes — descriptors are bounded at ${LIMITS.MAX_DESCRIPTOR_BYTES} (MAX_DESCRIPTOR_BYTES)`);
    }
    if (bytes.subarray(0, LFS_SIG.length).equals(LFS_SIG)) {
      throw new Error(`${rel} is a Git LFS pointer; v1 themes must contain materialized files`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}
```

3. Replace `preflight` with a role-driven walk. It now takes the parsed pack and the descriptor's byte count. The descriptor is counted once here, and both root descriptor names are skipped as before:

```js
async function preflight(root, { candidatePath, pack, descriptorBytes }) {
  let entries = 0;
  let totalBytes = 0;
  const pngs = [];
  const count = (n) => {
    entries += n;
    if (entries > LIMITS.MAX_ENTRY_COUNT) {
      throw new Error(`pack has more than ${LIMITS.MAX_ENTRY_COUNT} entries (MAX_ENTRY_COUNT)`);
    }
  };
  const addBytes = (n, rel) => {
    totalBytes += n;
    if (totalBytes > LIMITS.MAX_TOTAL_BYTES) {
      fail(rel, `pushes the pack past ${LIMITS.MAX_TOTAL_BYTES} total bytes (MAX_TOTAL_BYTES)`);
    }
  };
  const checkFile = async (path, rel, stat) => {
    addBytes(stat.size, rel);
    if (rel.endsWith('.png') && stat.size > LIMITS.MAX_ASSET_BYTES) {
      fail(rel, `is ${stat.size} bytes — the bound is ${LIMITS.MAX_ASSET_BYTES} (MAX_ASSET_BYTES)`);
    }
    if (basename(rel) === 'animation.yaml' && stat.size > LIMITS.MAX_DESCRIPTOR_BYTES) {
      fail(rel, `is ${stat.size} bytes — descriptors are bounded at ${LIMITS.MAX_DESCRIPTOR_BYTES} (MAX_DESCRIPTOR_BYTES)`);
    }
    await assertMaterialized(path, rel);
    if (rel.endsWith('.png')) pngs.push(path);
  };
  count(1);
  addBytes(descriptorBytes, 'theme.yaml');
  const walk = async (dir, relDir) => {
    const handle = await opendir(dir);
    for await (const entry of handle) {
      const path = join(dir, entry.name);
      if (relDir === '' && (entry.name === 'theme.yaml' || path === candidatePath)) continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const role = packEntryRole(pack, rel);
      if (role === 'outside') continue;
      const stat = await fsLstat(path);
      if (stat.isDirectory() && !entry.isSymbolicLink()) { count(1); await walk(path, rel); continue; }
      if (role === 'ancestor') {
        fail(rel, `is ${kindOf(stat, entry)} — it lies on a member's asset-root and must be a directory`);
      }
      if (!stat.isFile() || entry.isSymbolicLink() || stat.isSymbolicLink()) {
        fail(rel, `is ${kindOf(stat, entry)} — packs may contain only regular files and directories`);
      }
      count(1);
      await checkFile(path, rel, stat);
    }
  };
  await walk(root, '');
  return { pngs };
}
```

The ancestor message keeps the asset-root wording (`sprites: is a symlink — it lies on a member's asset-root and must be a directory`): it tells the author why `sprites` was examined at all. The test's `/^Error: sprites: is a symlink/` matches it, because `assert.rejects` tests a RegExp against the error's `toString()`.

4. Thread the seam through `validateThemePackWithLoader`: add `afterDescriptorRead = () => {}` to its options and pass it to `validateResolved(root, candidatePath, loadAnimation, afterDescriptorRead)`.
5. In `validateResolved`, replace `const found = await preflight(root, { candidatePath, isCandidate });` and the `loadThemePack` call with:

```js
  if (isCandidate) {
    const stat = await fsLstat(candidatePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('candidate descriptor must be a regular non-symlink file');
    }
  }
  const descriptorBytes = await readDescriptor(candidatePath, 'theme.yaml');
  afterDescriptorRead(candidatePath);
  const descriptorText = descriptorBytes.toString('utf8');
  const parsed = parseThemePack(descriptorText, root, { descriptorLabel: 'theme.yaml' });
  const found = await preflight(root, { candidatePath, pack: parsed, descriptorBytes: descriptorBytes.length });
  const pack = await loadThemePack(root, {
    descriptorPath: candidatePath,
    descriptorLabel: 'theme.yaml',
    readFile: async (path) => {
      if (path !== candidatePath) {
        throw new Error('theme.yaml: the descriptor moved during validation — validate a stable pack');
      }
      return descriptorText;
    },
  });
```

The rest of `validateResolved` (asset-root faults, both PNG passes, coverage, animation) is unchanged. The old `isCandidate` branch at the end of `preflight` is gone: the descriptor is counted once at the walk's start, whichever descriptor it is.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `node --test test/validate-content.test.js`, then `npm test`
Expected: PASS, the full suite included. If `'an oversized descriptor rejects before parsing'` now matches a different alternative of its regex, that is fine: its regex allows both forms.

- [ ] **Step 6: Commit**

```bash
git add src/validate.js test/validate-preflight.test.js test/validate-content.test.js
git commit -m "feat(validate): walk pack content only, reading the descriptor once"
```

---

### Task 3: document and release familiar-theme v0.3.0

**Files:**
- Modify: `README.md` (a "Pack content" section)
- Modify: `package.json` (`"version": "0.3.0"`)

**Interfaces:**
- Produces: the tag `v0.3.0` on `origin`, which Task 4 installs as `git+https://github.com/khughitt/familiar-theme.git#v0.3.0`.

- [ ] **Step 1: Add the README section**

Append to `README.md`:

```markdown
## Pack content

A pack is its descriptor and what the descriptor names, not the directory
that holds it. `packEntryRole(pack, relPath)` gives every path one role:

- `content`: `theme.yaml`; any path whose first segment starts,
  case-insensitively, with `licen`, `copying` or `notice` (licence files and
  licence directories, with everything beneath them); each member's
  `asset-root` and everything beneath it.
- `ancestor`: a proper prefix of some member's `asset-root` (`sprites`). It
  must be a real directory.
- `outside`: everything else. The gate never examines it, and installers
  never copy it.

The gate reads the descriptor once and validates content only, so a working
checkout with tool workspaces, symlinks or build output beside the pack
validates as it stands. Installers copy exactly the content.
```

- [ ] **Step 2: Bump the version**

In `package.json`, change `"version": "0.2.0"` to `"version": "0.3.0"`.

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json
git commit -m "chore: release 0.3.0"
```

- [ ] **Step 5: Merge locally and tag**

In the `familiar-theme` main checkout: `git merge --ff-only feat/pack-content`, then `git tag v0.3.0`. Run `npm test` there once more.

- [ ] **Step 6: Push (approval gate)**

Stop and ask the user to approve pushing `familiar-theme` `main` and tag `v0.3.0`. Park fam-13999b with `--waiting-on user --reason approval` if the session ends first. On approval: `git push origin main` and `git push origin v0.3.0`.

- [ ] **Step 7: Remove the contract worktree**

Run `git -C .worktrees/pack-content status --ignored --porcelain` and confirm only `node_modules/` is ignored. Then `git worktree unlock .worktrees/pack-content`, `git worktree remove .worktrees/pack-content` and `git branch -d feat/pack-content`.

---

### Task 4: `copySource` copies pack content only (engine)

**Files:**
- Modify: `package.json`, `package-lock.json` (the dependency bump)
- Modify: `src/theme/acquire.js` (`copySource`; new `stageDescriptor`, `notADirectory`, `descriptorTooLarge`)
- Modify: `test/theme-acquire.test.js` (relocations and new cases)

**Interfaces:**
- Consumes: `packEntryRole`, `parseThemePack` and `LIMITS` from `familiar-theme` v0.3.0. Also `copyRegularFile(src, display, out, signal, { dev, ino })` and `unsupportedEntry(path)` from `src/theme/copy-regular-file.js`.
- Produces: `copySource(sourceDir, dest, { signal, platform, afterDirectoryRead })`, with the same signature. It now stages `dest/theme.yaml` first, then copies only content and ancestors. New errors: `theme add: <source> has no theme.yaml`, `theme add: <path> is <n> bytes — descriptors are bounded at <max> (MAX_DESCRIPTOR_BYTES)`, and `theme add: <path> lies on a member's asset-root but is not a directory`.

- [ ] **Step 1: Bump the dependency**

Run: `npm install 'familiar-theme@git+https://github.com/khughitt/familiar-theme.git#v0.3.0'`
Then check: `grep -n '"familiar-theme"' package.json` shows `#v0.3.0`, and `grep -n -A2 '"node_modules/familiar-theme"' package-lock.json` shows `"version": "0.3.0"`.
Run: `just test-fast`
Expected: PASS. The narrowed gate is more permissive, and no engine test relied on root clutter being rejected (checked while planning).

- [ ] **Step 2: Relocate the copy-level fixtures in `test/theme-acquire.test.js`**

A source must now be a pack (it needs a `theme.yaml`), and hostile entries must sit inside content to be examined. Make exactly these edits:

- `'a pack copies byte-for-byte, excluding any .git'`: keep the root `.git`. Replace the `sprites/.git` lines with `mkdirSync(join(src, 'sprites', 'solo', '.git'))` and `writeFileSync(join(src, 'sprites', 'solo', '.git', 'HEAD'), 'x')`, and assert `existsSync(join(dest, 'sprites', 'solo', '.git')) === false`.
- `'a symlink in the source fails acquisition by path, undereferenced'`: link at `join(src, 'sprites', 'solo', 'link.png')`.
- `'a FIFO fails acquisition by path'`: `mkfifo` at `join(src, 'sprites', 'solo', 'pipe')`.
- `'a Unix socket fails acquisition by path'`: `sock = join(src, 'sprites', 'solo', 's')`.
- `'a contract-valid deep pack copies …'`: `deepRoot = join(src, 'sprites', 'solo', 'extra')`.
- `copyAfterQueuedSwap`: build on a pack. Use `const src = writePack();` and `const member = join(src, 'sprites', 'solo');`, with `victim = join(member, 'aa-victim')` and `held = join(member, 'held-victim')`. The hook's guard becomes `task.openPath !== join(sourceReal, 'sprites', 'solo') || !existsSync(join(dest, 'sprites', 'solo', 'aa-victim'))`. `swappedBeforeTraversal` checks `join(dest, 'sprites', 'solo', 'aa-victim', 'safe.txt')`. In both callers, the final assertion checks `join(dest, 'sprites', 'solo', 'aa-victim', 'secret.txt')`.
- `'a zero-millisecond acquisition cannot outrun the absolute deadline'`: `const src = writePack();`.
- `'the wall clock interrupts local topology traversal …'`: `const src = writePack();`, then create the 500 directories under `join(src, 'sprites', 'solo', \`entry-${i}\`)`. The assertion becomes `const member = join(dest, 'sprites', 'solo'); assert.ok(!existsSync(member) || readdirSync(member).length < 500);`.
- `'the final growth scan fails closed on an unreadable directory'`: `const src = writePack();`.
- `'an interval scan error aborts acquisition …'`: `const src = writePack();`, with `bulk = join(src, 'sprites', 'solo', 'bulk.bin')`.

- [ ] **Step 3: Write the failing tests**

Append to `test/theme-acquire.test.js`, and add `import { DESCRIPTOR } from './helpers/fixture.js';` to the existing fixture import:

```js
const treeOf = (root) => {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel === '' ? entry.name : `${rel}/${entry.name}`;
      out.push(entry.isDirectory() ? `${r}/` : r);
      if (entry.isDirectory()) walk(join(dir, entry.name), r);
    }
  };
  walk(root, '');
  return out;
};

function clutteredCheckout() {
  const src = writePack();
  symlinkSync('../../elsewhere/.worktrees', join(src, '.worktrees'));
  mkdirSync(join(src, '.superpowers'));
  symlinkSync('/etc/hostname', join(src, '.superpowers', 'link'));
  writeFileSync(join(src, 'README.md'), 'readme');
  mkdirSync(join(src, 'docs'));
  writeFileSync(join(src, 'docs', 'a.md'), 'doc');
  writeFileSync(join(src, 'sprites', 'README.md'), 'sibling of a member');
  execFileSync('mkfifo', [join(src, 'pipe')]);
  writeFileSync(join(src, 'LICENSE'), 'MIT');
  writeFileSync(join(src, 'LICENSE-assets'), 'CC-BY-4.0');
  mkdirSync(join(src, 'LICENSES'));
  writeFileSync(join(src, 'LICENSES', 'MIT.txt'), 'MIT');
  return src;
}

const CONTENT_TREE = [
  'LICENSE', 'LICENSE-assets', 'LICENSES/', 'LICENSES/MIT.txt',
  'sprites/', 'sprites/solo/', 'sprites/solo/done.png', 'sprites/solo/error.png',
  'sprites/solo/idle.png', 'sprites/solo/needs-approval.png', 'sprites/solo/needs-input.png',
  'sprites/solo/working.png', 'theme.yaml',
];

test('a cluttered working checkout copies exactly its pack content', async (t) => {
  const src = clutteredCheckout();
  const dest = destDir();
  t.after(() => { rmSync(src, { recursive: true }); rmSync(dest, { recursive: true }); });
  await copySource(src, dest);
  assert.deepEqual(treeOf(dest), CONTENT_TREE);
  assert.deepEqual(readFileSync(join(dest, 'theme.yaml')), readFileSync(join(src, 'theme.yaml')));
});

test('a source without theme.yaml is a named refusal', async (t) => {
  const src = writePack();
  rmSync(join(src, 'theme.yaml'));
  t.after(() => rmSync(src, { recursive: true }));
  await assert.rejects(copySource(src, destDir()), /theme add: .* has no theme\.yaml/);
});

test('an oversized descriptor is refused before it is parsed', async (t) => {
  const src = writePack({ descriptor: `${DESCRIPTOR}#${'x'.repeat(LIMITS.MAX_DESCRIPTOR_BYTES)}\n` });
  t.after(() => rmSync(src, { recursive: true }));
  await assert.rejects(copySource(src, destDir()), /theme\.yaml is \d+ bytes .*MAX_DESCRIPTOR_BYTES/);
});

test('selected entries keep every defense: descriptor, licence and ancestor symlinks', async (t) => {
  const cases = {
    'theme.yaml': (src) => {
      writeFileSync(join(src, 'real.yaml'), readFileSync(join(src, 'theme.yaml')));
      rmSync(join(src, 'theme.yaml'));
      symlinkSync('real.yaml', join(src, 'theme.yaml'));
    },
    LICENSE: (src) => symlinkSync('/etc/hostname', join(src, 'LICENSE')),
    'LICENSES/MIT.txt': (src) => {
      mkdirSync(join(src, 'LICENSES'));
      symlinkSync('/etc/hostname', join(src, 'LICENSES', 'MIT.txt'));
    },
    sprites: (src) => {
      renameSync(join(src, 'sprites'), join(src, 'real-sprites'));
      symlinkSync('real-sprites', join(src, 'sprites'));
    },
  };
  for (const [name, plant] of Object.entries(cases)) {
    const src = writePack();
    t.after(() => rmSync(src, { recursive: true }));
    plant(src);
    await assert.rejects(copySource(src, destDir()),
      new RegExp(`${name.replaceAll('.', '\\.')} is not a regular file or directory`), name);
  }
});

test('a regular file on an asset-root path is refused as not a directory', async (t) => {
  const src = writePack({ descriptor: DESCRIPTOR.replace('asset-root: sprites/solo', 'asset-root: art/sprites/solo') });
  writeFileSync(join(src, 'art'), 'not a directory');
  t.after(() => rmSync(src, { recursive: true }));
  await assert.rejects(copySource(src, destDir()),
    /theme add: .*\/art lies on a member's asset-root but is not a directory/);
});
```

- [ ] **Step 4: Run the tests and verify they fail**

Run: `just test-fast`
Expected: FAIL. The cluttered-checkout test fails on `.worktrees … is not a regular file or directory` (the original bug). The missing-descriptor and oversize tests fail on their messages. The art-file test fails with `unsupportedEntry` wording. The relocated tests from Step 2 still pass.

- [ ] **Step 5: Write the implementation**

In `src/theme/acquire.js`:

1. Imports: `import { lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';` and `import { LIMITS, packEntryRole, parseThemePack } from 'familiar-theme';`.
2. Add, above `copySource`:

```js
function notADirectory(path) {
  return new Error(`theme add: ${path} lies on a member's asset-root but is not a directory`);
}

function descriptorTooLarge(path, size) {
  return new Error(
    `theme add: ${path} is ${size} bytes — descriptors are bounded at ${LIMITS.MAX_DESCRIPTOR_BYTES} (MAX_DESCRIPTOR_BYTES)`
  );
}

// The selection comes from the STAGED descriptor (spec §3): the bytes that
// choose what is copied are the bytes the gate validates. The walk never
// touches the root theme.yaml again, so this copy is the only one.
async function stageDescriptor(traversal, task, signal) {
  const src = join(traversal, 'theme.yaml');
  const display = join(task.displayPath, 'theme.yaml');
  const out = join(task.to, 'theme.yaml');
  let st;
  try {
    st = await lstat(src);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`theme add: ${task.displayPath} has no theme.yaml`);
    throw error;
  }
  if (!st.isFile()) throw unsupportedEntry(display);
  if (st.size > LIMITS.MAX_DESCRIPTOR_BYTES) throw descriptorTooLarge(display, st.size);
  await copyRegularFile(src, display, out, signal, { dev: st.dev, ino: st.ino });
  const bytes = await readFile(out);
  if (bytes.length > LIMITS.MAX_DESCRIPTOR_BYTES) throw descriptorTooLarge(display, bytes.length);
  return parseThemePack(bytes.toString('utf8'), task.to, { descriptorLabel: 'theme.yaml' });
}
```

3. In `copySource`: give the root task `rel: ''` (`pending = [{ openPath, displayPath, to, rel: '', dev, ino }]`) and declare `let pack;` before the loop. After `if (platform === 'darwin') await verifyPathIdentity(task);` and before `readdir`, add:

```js
      if (task.rel === '') pack = await stageDescriptor(traversal, task, signal);
```

Replace the entry loop's body from `if (entry.name === '.git') continue;` through the end of the type dispatch with:

```js
        if (entry.name === '.git') continue;
        if (task.rel === '' && entry.name === 'theme.yaml') continue;
        const rel = task.rel === '' ? entry.name : `${task.rel}/${entry.name}`;
        const role = packEntryRole(pack, rel);
        if (role === 'outside') continue;
        const src = join(traversal, entry.name);
        const openPath = join(task.openPath, entry.name);
        const display = join(task.displayPath, entry.name);
        const out = join(task.to, entry.name);
        const st = await lstat(src);
        signal?.throwIfAborted();
        if (st.isDirectory()) {
          await mkdir(out);
          pending.push({
            openPath, displayPath: display, to: out, rel, dev: st.dev, ino: st.ino,
          });
        } else if (role === 'ancestor' && st.isFile()) {
          throw notADirectory(display);
        } else if (st.isFile()) {
          await copyRegularFile(src, display, out, signal, { dev: st.dev, ino: st.ino });
        } else {
          throw unsupportedEntry(display);
        }
```

4. Update the comment above `copySource`. Its last sentences become: "Only pack content is copied (spec 2026-10-14 §3): `theme.yaml` is staged first and parsed from the staged bytes, then each entry's `packEntryRole` decides. `outside` entries are skipped by name and never `lstat`ed. `.git` at any depth is excluded, and git is never invoked on the source."

- [ ] **Step 6: Run the tests and verify they pass**

Run: `just test-fast`
Expected: PASS, the whole fast suite included.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/theme/acquire.js test/theme-acquire.test.js
git commit -m "fix(theme): copy pack content only, selected from the staged descriptor"
```

---

### Task 5: both transports promote `<run>/pack` (engine)

**Files:**
- Modify: `src/theme/acquire.js` (`acquireSource`; new exports `PACK_DIR_NAME`, `CLONE_DIR_NAME`)
- Modify: `src/theme/add.js` (use `packDir`, drop the `.git` removal, always remove the run directory)
- Modify: `test/theme-acquire.test.js`, `test/theme-add.test.js`, `test/theme-add-https.test.js`

**Interfaces:**
- Consumes: `copySource` (Task 4); `cloneSource(url, dest, { caFile, signal }) -> { commit }`.
- Produces: `acquireSource(source, dest, opts) -> { provenance, packDir }`, where `packDir = join(dest, PACK_DIR_NAME)` and `PACK_DIR_NAME = 'pack'`. A clone lives at `join(dest, CLONE_DIR_NAME)` (`'clone'`). `addTheme` validates and promotes `packDir`, and removes the run directory on every path.

- [ ] **Step 1: Write the failing tests**

In `test/theme-acquire.test.js`, change `'a completed local acquisition returns local provenance'` to:

```js
test('a completed local acquisition returns local provenance and its pack directory', async () => {
  const src = writePack();
  const dest = destDir();
  const { provenance, packDir } = await acquireSource({ kind: 'local', path: src }, dest);
  assert.deepEqual(provenance, { kind: 'local', path: realpathSync(src) });
  assert.equal(packDir, join(dest, 'pack'));
  assert.equal(existsSync(join(packDir, 'theme.yaml')), true);
});
```

In the deep-pack test's loop, compute the leaf through the mode: `const base = mode === 'acquire' ? join(dest, 'pack') : dest;`, then `readFileSync(join(base, relative(src, leaf)), 'utf8')`. In the wall-clock test, the member path becomes `join(dest, 'pack', 'sprites', 'solo')`.

In `test/theme-add.test.js`:

1. Change `'a validation failure cleans its staging run'` to corrupt a PNG instead of deleting the descriptor:

```js
test('a validation failure cleans its staging run', async () => {
  const p = scratch();
  const src = writePack();
  writeFileSync(join(src, 'sprites', 'solo', 'idle.png'), 'junk');
  await assert.rejects(addTheme({ paths: p, source: src }), /idle\.png/);
  assert.deepEqual(stagingEntries(p), []);
  assert.equal(existsSync(join(p.userThemesDir, 'gate-fixture')), false);
});
```

2. Append:

```js
test('a cluttered working checkout installs exactly its pack content', async (t) => {
  const p = scratch();
  const src = writePack();
  symlinkSync('../../elsewhere/.worktrees', join(src, '.worktrees'));
  mkdirSync(join(src, '.superpowers'));
  symlinkSync('/etc/hostname', join(src, '.superpowers', 'link'));
  writeFileSync(join(src, 'README.md'), 'readme');
  writeFileSync(join(src, 'LICENSE'), 'MIT');
  for (let i = 0; i < 600; i++) mkdirSync(join(src, 'node_modules', `m${i}`), { recursive: true });
  t.after(() => rmSync(src, { recursive: true, force: true }));
  const { dir } = await addTheme({ paths: p, source: src });
  assert.deepEqual(readdirSync(dir).sort(), ['LICENSE', 'sprites', 'theme.yaml']);
  assert.deepEqual(stagingEntries(p), []);
});

test('a source reached through a symlink installs from its real path', async (t) => {
  const p = scratch();
  const src = writePack();
  const link = join(mkdtempSync(join(tmpdir(), 'link-')), 'checkout');
  symlinkSync(src, link);
  t.after(() => rmSync(src, { recursive: true, force: true }));
  const { dir, provenance } = await addTheme({ paths: p, source: link });
  assert.equal(existsSync(join(dir, 'theme.yaml')), true);
  assert.equal(provenance.path, realpathSync(src));
});

test('a source without theme.yaml is refused by name and leaves no staging', async () => {
  const p = scratch();
  const src = writePack();
  rmSync(join(src, 'theme.yaml'));
  await assert.rejects(addTheme({ paths: p, source: src }), /has no theme\.yaml/);
  assert.deepEqual(stagingEntries(p), []);
});
```

Add `realpathSync` to that file's `node:fs` import.

In `test/theme-add-https.test.js`, append, reusing the file's existing `scratch`, `bareRepoFrom`, `serveBare`, `git`, `CERT` and `stagingEntries`:

```js
test('an HTTPS install carries pack content only, never the repository around it', async (t) => {
  const p = scratch();
  const work = writePack();
  writeFileSync(join(work, 'README.md'), 'readme');
  mkdirSync(join(work, 'docs'));
  symlinkSync('../theme.yaml', join(work, 'docs', 'alias.yaml'));
  writeFileSync(join(work, 'LICENSE'), 'MIT');
  const bare = bareRepoFrom(work);
  const head = git(['rev-parse', 'HEAD'], bare).trim();
  const { url, close } = await serveBare(bare);
  t.after(close);
  const result = await addTheme({ paths: p, source: url, caFile: CERT });
  assert.deepEqual(readdirSync(result.dir).sort(), ['LICENSE', 'sprites', 'theme.yaml']);
  assert.deepEqual(readReceipt(p, 'gate-fixture').receipt.source, { kind: 'https', url, commit: head });
  assert.deepEqual(stagingEntries(p), []);
});
```

Add whichever of `mkdirSync`, `readdirSync`, `symlinkSync` and `writeFileSync` are missing to that file's `node:fs` import. `bareRepoFrom` commits with `git add -A`, so `docs/alias.yaml` is committed as a symlink (mode `120000`), and the clone recreates it in `<run>/clone`.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `just test-fast`
Expected: FAIL.
- The acquisition test fails because `acquireSource` returns the provenance object itself.
- The HTTPS test finds `README.md` and `docs` in the installed directory: until this task, the whole clone (minus `.git`) is promoted, and the v0.3.0 gate no longer rejects `docs/alias.yaml`. That is exactly the unvalidated install this task closes.
- The local cluttered test passes already, because Task 4 copies content only. It stays as the add-level regression for this task's bug.

- [ ] **Step 3: Write the implementation**

In `src/theme/acquire.js`, add exports below `DEFAULT_GROWTH_LIMIT_BYTES`:

```js
// A run directory holds the acquired pack at <run>/pack. A clone first lands
// at <run>/clone and is copied from there, so both transports promote exactly
// the pack content the gate validated (spec 2026-10-14 §3).
export const PACK_DIR_NAME = 'pack';
export const CLONE_DIR_NAME = 'clone';
```

In `acquireSource`, replace the transport branch and the success return with:

```js
    const packDir = join(dest, PACK_DIR_NAME);
    let provenance;
    if (source.kind === 'https') {
      const cloneDir = join(dest, CLONE_DIR_NAME);
      const { commit } = await cloneSource(
        source.url, cloneDir, { caFile, signal: controller.signal }
      );
      await mkdir(packDir);
      await copySource(cloneDir, packDir, { signal: controller.signal, platform });
      provenance = { kind: 'https', url: source.url, commit };
    } else {
      const path = await realpath(source.path);
      await mkdir(packDir);
      await copySource(path, packDir, { signal: controller.signal, platform });
      provenance = { kind: 'local', path };
    }
    await checkGrowth();
    if (performance.now() >= deadline) controller.abort(timeoutReason);
    controller.signal.throwIfAborted();
    return { provenance, packDir };
```

In `src/theme/add.js`:

```js
      const runDir = mkdtempSync(join(stagingRoot, 'run-'));
      try {
        const { provenance, packDir } = await acquireSource(classified, runDir, {
          caFile,
          timeoutMs,
          growthLimitBytes,
        });
        const pack = await validate(packDir);
        const target = join(paths.userThemesDir, pack.id);
```

Keep the two refusal checks unchanged. Then:

```js
        renameSync(packDir, target);
        const receipt = {
          id: pack.id,
          source: provenance,
          installedAt: now().toISOString(),
        };
        await writeReceiptFn(paths, receipt);
        return { id: pack.id, dir: target, members: pack.members.size, provenance };
      } finally {
        // After promotion the run holds only the discarded clone, if any; before
        // it, everything. Either way nothing in it outlives this add.
        rmSync(runDir, { recursive: true, force: true });
      }
```

Delete the `rmSync(join(runDir, '.git'), …)` line and the `promoted` variable.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `just test-fast`
Expected: PASS. This includes `'theme add clones over HTTPS end-to-end'`: `.git` is absent because the clone directory is never promoted.

- [ ] **Step 5: Commit**

```bash
git add src/theme/acquire.js src/theme/add.js test/theme-acquire.test.js test/theme-add.test.js test/theme-add-https.test.js
git commit -m "fix(theme): promote <run>/pack for both transports"
```

---

### Task 6: `theme validate` on a checkout, docs, and the live check (engine)

**Files:**
- Modify: `test/theme-validate-cli.test.js`
- Modify: `docs/install.md`
- Modify: `docs/specs/2026-08-18-theme-add-design.md` (status line)
- Modify: `docs/specs/2026-10-14-pack-content-design.md` (status line)

**Interfaces:**
- Consumes: `familiar theme validate <dir>` (gate v0.3.0) and `familiar theme add` (Tasks 4–5).

- [ ] **Step 1: Write the test**

Append to `test/theme-validate-cli.test.js`, and add `mkdirSync` and `symlinkSync` to its `node:fs` import:

```js
test('theme validate accepts a working checkout with clutter beside the pack', (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync('../../elsewhere/.worktrees', join(dir, '.worktrees'));
  mkdirSync(join(dir, '.superpowers'));
  symlinkSync('/etc/hostname', join(dir, '.superpowers', 'link'));
  const r = run('theme', 'validate', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gate-fixture/);
});
```

- [ ] **Step 2: Run it**

Run: `just test-fast`
Expected: PASS. It passes since Task 4's dependency bump. It is committed as the CLI-level regression for `theme validate`.

- [ ] **Step 3: Update the docs**

In `docs/install.md`, replace the paragraph beginning "`familiar theme add` accepts a public HTTPS repository or a clean local theme checkout." with:

```markdown
`familiar theme add` accepts a public HTTPS repository or a local theme
directory, such as your working checkout. It installs only the pack itself
(`theme.yaml`, licence files, and each member's sprite directory), validates
exactly those files, and atomically installs them into
`~/.config/familiar/themes/<id>`. Anything else in the checkout (tool
workspaces, docs, build output) is left behind.
```

In `docs/specs/2026-08-18-theme-add-design.md`, change line 3 to:

```markdown
**Status:** implemented; cutover complete, HTTPS smoke passed 2026-08-19. §2 step 4 and §3 "Local copy" are amended by [`2026-10-14-pack-content-design.md`](2026-10-14-pack-content-design.md): only pack content is copied, for both transports.
```

In `docs/specs/2026-10-14-pack-content-design.md`, change the status line to `**Status:** implemented 2026-10-14 (familiar-theme v0.3.0)`. Use the actual date if it differs.

- [ ] **Step 4: The live check, by hand, against scratch config**

From the engine worktree, with a scratch config directory so the live config is untouched:

```bash
scratch=$(mktemp -d)
FAMILIAR_CONFIG_DIR="$scratch" ./bin/familiar theme validate ../../../familiar-cats
FAMILIAR_CONFIG_DIR="$scratch" ./bin/familiar theme add ../../../familiar-cats
ls -A "$scratch/themes/cats"
rm -rf "$scratch"
```

Adjust `../../../familiar-cats` to wherever the cats checkout sits relative to the worktree (it is a sibling of the engine's main checkout). Expected: both commands exit 0. `ls -A` shows exactly `LICENSE`, `LICENSE-assets`, `sprites` and `theme.yaml`. Record the output in a `tasks note`.

- [ ] **Step 5: Run the gate and commit**

Run: `just check`, then `just test-fast`.
Expected: both pass.

```bash
git add test/theme-validate-cli.test.js docs/install.md docs/specs/2026-08-18-theme-add-design.md docs/specs/2026-10-14-pack-content-design.md
git commit -m "docs(theme): theme add installs pack content from a working checkout"
```

- [ ] **Step 6: File the forge follow-up**

Forge pins `familiar-theme#v0.2.0`, and whether it adopts the rule is its own decision:

```bash
tasks add "Decide whether forge adopts familiar-theme v0.3.0's pack-content rule" --project forge -p 3 --size s --complexity mid --process direct -b "familiar-theme v0.3.0 validates pack content only (packEntryRole). Forge pins v0.2.0. Decide whether forge's publish or validate paths should bump, and whether any of them relied on the gate rejecting non-content entries. Spec: familiar docs/specs/2026-10-14-pack-content-design.md."
```
