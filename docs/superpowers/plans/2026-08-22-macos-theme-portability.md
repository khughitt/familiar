# macOS Theme Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Linux's handle-bound theme acquisition and add the approved, explicitly weaker Darwin pathname walker.

**Architecture:** Keep one acquisition algorithm in `src/theme/acquire.js`; only the directory traversal root and identity rechecks vary by platform. Strengthen regular-file copying on both platforms by comparing the opened handle with the immediately preceding `lstat`, and reuse the same directory selection in the staging growth scan.

**Tech Stack:** Node 22 ESM, `node:fs`/`node:fs/promises`, `node:test`, existing Familiar theme acquisition helpers.

**Spec:** `docs/specs/2026-08-22-macos-support-design.md` §§1, 2, 5, 9, 10, 12.

## Global Constraints

- Linux traversal remains `/proc/self/fd/N`; do not replace it with `/dev/fd`.
- Darwin traversal is pathname-based and must state its weaker swap-away/swap-back ceiling.
- No native helper, new dependency, retry fallback, symlink following, or special-file materialization.
- Keep abort, wall-clock, growth, device/inode, and destination-containment checks.
- Darwin-only integration tests register on every platform and use a named `requires Darwin` skip on Linux.
- Use conventional commits without attribution trailers.

---

### Task 1: Verify regular-file identity at open

**Files:**
- Modify: `src/theme/copy-regular-file.js`
- Modify: `src/theme/acquire.js`
- Test: `test/theme-acquire.test.js`

**Interfaces:**
- Consumes: the `lstat` result already read for each source entry.
- Produces: `copyRegularFile(src, display, out, signal, expected)` where `expected` is `{ dev, ino }`; `changedEntry(path)` remains the named `THEME_ENTRY_CHANGED` error used for both files and directories.

- [x] **Step 1: Add a failing opened-file identity test**

Import `copyRegularFile` from `src/theme/copy-regular-file.js`, then add a focused test. Inject an `open` seam so the test can return a handle whose `stat()` identity differs from the expected identity without racing the host filesystem:

```js
test('a regular file replaced between lstat and open is rejected by identity', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'file-identity-'));
  const path = join(dir, 'source');
  const out = join(dir, 'out');
  writeFileSync(path, 'source');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const expected = lstatSync(path);
  await assert.rejects(
    copyRegularFile(path, path, out, undefined,
      { dev: expected.dev, ino: expected.ino },
      { open: async () => ({
        stat: async () => ({
          dev: expected.dev, ino: expected.ino + 1, isFile: () => true,
        }),
        close: async () => {},
      }) }),
    (error) => error.code === 'THEME_ENTRY_CHANGED'
  );
});
```

- [x] **Step 2: Run the test and confirm the identity check is absent**

Run:

```bash
node --test --test-name-pattern='regular file replaced between lstat and open' test/theme-acquire.test.js
```

Expected: FAIL because `copyRegularFile` neither accepts the expected identity/open seam nor rejects the mismatch.

- [x] **Step 3: Add the minimum identity check**

Move the shared named error to `src/theme/copy-regular-file.js` and export it:

```js
export function changedEntry(path) {
  const error = new Error(
    `theme add: ${path} changed during acquisition — retry with a stable source`
  );
  error.code = 'THEME_ENTRY_CHANGED';
  return error;
}
```

Change the copy signature and handle validation:

```js
export async function copyRegularFile(
  src, display, out, signal, expected,
  { open: openFile = open } = {},
) {
  // existing open flags and abort handling stay unchanged
  handle = await openFile(
    src,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  const actual = await handle.stat();
  if (!actual.isFile()) throw unsupportedEntry(display);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw changedEntry(display);
  }
  // existing pipeline and cleanup
}
```

Import `changedEntry` into `src/theme/acquire.js`, delete its local duplicate, and pass the entry `lstat` identity:

```js
await copyRegularFile(src, display, out, signal, { dev: st.dev, ino: st.ino });
```

- [x] **Step 4: Run the focused and full acquisition tests**

Run:

```bash
node --test test/theme-acquire.test.js
```

Expected: all theme-acquisition tests pass.

- [x] **Step 5: Commit**

```bash
git add src/theme/copy-regular-file.js src/theme/acquire.js test/theme-acquire.test.js
git commit -m "fix(theme): verify source file identity at open"
```

---

### Task 2: Add explicit Linux and Darwin traversal roots

**Files:**
- Modify: `src/theme/acquire.js`
- Test: `test/theme-acquire.test.js`

**Interfaces:**
- Consumes: `openVerifiedDirectory(task)` and the queued `{ openPath, displayPath, dev, ino }` task shape.
- Produces: `traversalRoot(task, handle, platform)` and `verifyPathIdentity(task)` used by both `copySource` and `stagedBytes`; both functions accept an injected `platform = process.platform`.

- [x] **Step 1: Add Darwin tests with visible Linux skips**

Register, rather than conditionally define, these tests:

```js
const requiresDarwin = process.platform !== 'darwin' ? 'requires Darwin' : false;

test('Darwin copies a stable local pack through its pathname walker',
  { skip: requiresDarwin }, async (t) => {
    const source = writePack();
    const dest = destDir();
    t.after(() => {
      rmSync(source, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    });
    await copySource(source, dest);
    assert.equal(readFileSync(join(dest, 'theme.yaml'), 'utf8'),
      readFileSync(join(source, 'theme.yaml'), 'utf8'));
  });

test('Darwin rejects a queued parent whose pathname identity changes',
  { skip: requiresDarwin }, async (t) => {
    const source = writePack();
    const held = `${source}-held`;
    const dest = destDir();
    t.after(() => {
      rmSync(source, { recursive: true, force: true });
      rmSync(held, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    });
    await assert.rejects(
      copySource(source, dest, {
        beforeDirectoryRecheck(task) {
          if (task.openPath !== realpathSync(source)) return;
          renameSync(source, held);
          mkdirSync(source);
        },
      }),
      (error) => error.code === 'THEME_ENTRY_CHANGED'
    );
  });
```

Add only the smallest test seam needed to deterministically trigger the parent swap; do not add a general hook registry.

- [x] **Step 2: Run the tests on Linux and confirm named skips**

Run:

```bash
node --test test/theme-acquire.test.js
```

Expected: the two new test names appear as `# SKIP requires Darwin`; existing Linux tests pass.

- [x] **Step 3: Implement explicit traversal selection and parent checks**

Add these helpers in `src/theme/acquire.js`:

```js
function traversalRoot(task, handle, platform) {
  if (platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  if (platform === 'darwin') return task.openPath;
  throw new Error(`theme add: unsupported platform ${JSON.stringify(platform)}`);
}

async function verifyPathIdentity(task) {
  let st;
  try {
    st = await lstat(task.openPath);
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code)) {
      throw changedEntry(task.displayPath);
    }
    throw error;
  }
  if (!st.isDirectory() || st.dev !== task.dev || st.ino !== task.ino) {
    throw changedEntry(task.displayPath);
  }
}
```

Change `copySource` to accept `platform = process.platform` and `beforeDirectoryRecheck = () => {}`. Add `platform = process.platform` to `acquireSource`'s options, pass it to local `copySource`, and call `stagedBytes(dest, controller.signal, { platform })`. Change `stagedBytes` to accept that options object. After opening a queued directory, select the root once, check Darwin before `readdir`, and check Darwin again after processing its entries:

```js
const root = traversalRoot(task, handle, platform);
if (platform === 'darwin') await verifyPathIdentity(task);
const entries = (await readdir(root, { withFileTypes: true }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));
// existing child loop uses join(root, entry.name)
if (platform === 'darwin') {
  beforeDirectoryRecheck(task);
  await verifyPathIdentity(task);
}
```

Use the same `root` selection and before/after checks in `stagedBytes`. Do not catch a Darwin failure and retry via another root.

- [x] **Step 4: Mark Linux `/proc` race probes explicitly**

The existing tests that inspect `/proc/self/fd` must stay registered on Darwin but skip with a reason:

```js
const requiresLinuxProc = process.platform !== 'linux' ? 'requires Linux /proc fd traversal' : false;

test('queued directory remains handle-bound during a pathname swap',
  { skip: requiresLinuxProc }, async (t) => {
    // existing body unchanged
  });
```

Do not skip ordinary copy, symlink, FIFO, socket, abort, deadline, or growth tests; those must exercise the selected walker on both operating systems.

- [x] **Step 5: Run acquisition tests and the fast suite**

Run:

```bash
node --test test/theme-acquire.test.js
npm test
```

Expected on Linux: all existing assertions pass; Darwin-only tests are named skips; no platform test group is absent.

- [x] **Step 6: Commit**

```bash
git add src/theme/acquire.js test/theme-acquire.test.js
git commit -m "feat(theme): add verified Darwin pathname traversal"
```

---

### Task 3: Prove the Darwin walker on GitHub Actions

**Files:**
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: the normal `npm test` inventory and named platform skips from Task 2.
- Produces: temporary branch evidence that the Darwin test IDs run rather than skip; the permanent macOS job belongs to the final integration plan.

- [x] **Step 1: Add a temporary branch-only macOS job**

Add this job while implementing the theme plan:

```yaml
  macos-theme:
    if: github.ref == 'refs/heads/docs/macos-support-design'
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: node --test test/theme-acquire.test.js
```

- [x] **Step 2: Push and inspect the test report**

Run:

```bash
git add .github/workflows/test.yml
git commit -m "ci(macos): verify Darwin theme traversal"
git push
gh run watch --exit-status
```

Expected: the job succeeds and neither Darwin test is reported as skipped.

- [x] **Step 3: Remove the temporary job after recording the run URL in the implementation notes**

Use `apply_patch` to remove only `macos-theme`; the final integration plan adds the permanent job after every subsystem is ready.

Run:

```bash
git add .github/workflows/test.yml
git commit -m "ci(macos): remove temporary theme probe"
```

Expected: relative to the task's starting commit, `.github/workflows/test.yml` has no net change.
