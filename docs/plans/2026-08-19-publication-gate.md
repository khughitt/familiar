# Publication Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Task 1 contains a HUMAN STOP GATE** (legal conclusion) and Tasks 5 and 10
> flip repository visibility — outward-facing, hard to walk back. Do not
> reorder across the sequencing constraints in Global Constraints.

**Goal:** Take `familiar-cats`, `familiar-theme`, and `familiar` (engine) to
public with evidenced asset rights, license files, a machine-path sweep, tooled
secret/audit scans, and minimal CI.

**Architecture:** One sweep across three repos in the spec's interleaved order:
cats non-CI items → theme full gate + licensed release `v0.1.1` + flip → cats
CI (needs public theme) → engine (dependency flip, CI, flip). Engine work lands
on the `publication-gate` branch and merges to `main` at the end; cats and
theme work lands directly on their `main` branches (small doc/config commits).

**Tech Stack:** git, gh CLI, gitleaks, npm, GitHub Actions, Node 22/26.

**Spec:** `docs/specs/2026-08-19-publication-gate-design.md`

## Global Constraints

- Order is load-bearing: Task 6 (cats CI) and Task 8 (engine dep flip)
  **require** Task 5 (theme public + `v0.1.1`) to be complete first. A
  workflow's `GITHUB_TOKEN` cannot read a sibling private repo.
- Task 1's conclusion is presented to the human and approved **before**
  Task 2 writes `LICENSE-assets`. On a failed review: if redistribution is
  barred, `gh repo edit khughitt/familiar-cats --visibility private
  --accept-visibility-change-consequences` immediately; stop the plan.
- Licenses: code → MIT © 2026 Keith Hughitt; docs and READMEs → CC BY 4.0 by
  canonical URL, no CC text vendored; cats art → CC BY 4.0 conditional on
  Task 1. Path-to-license maps are default-plus-exceptions.
- Conventional commits. No AI-attribution trailers or footers anywhere.
- No machine-specific paths (`/home/…`, `/mnt/…`, `~/d/…`) may remain in any
  public repo's docs or comments.
- The published `v0.1.0` theme tag is never retagged or deleted.
- Node support: floor 22, current 26. If a suite fails on 22, raise the floor
  and record it in the execution notes; do not patch around it.
- Working directories: engine steps run **inside the worktree**
  `.worktrees/publication-gate` (branch `publication-gate`); the engine's
  primary clone is `~/d/familiar` (already on `main`, with `node_modules`
  installed). Theme and cats steps address their clones as
  `~/d/familiar-theme` and `~/d/familiar-cats`, via `git -C` or a subshell —
  never a bare `cd` that leaks into later steps. Adjust the `~/d/` prefix if
  the local layout differs.
- Execution notes live at `docs/ref/2026-08-19-publication-gate-notes.md` in
  the engine worktree (created in Task 3). Every gitleaks/audit result is
  dispositioned there, even when clean.

---

### Task 1: Asset-rights review (cats) — HUMAN STOP GATE

**Files:**
- Create: `~/d/familiar-cats/docs/asset-rights.md`

**Interfaces:**
- Consumes: `~/d/familiar-cats/sprites/*/provenance.json` (fields: `request.endpoint`, `request.body.model`, `usage.is_byok`, `generatedAt`).
- Produces: `docs/asset-rights.md` in cats with a `Conclusion:` line that Task 2's `LICENSE-assets` cites. Tasks 2–10 are gated on its approval.

- [ ] **Step 1: Confirm the evidence base from the manifests**

Run:

```bash
python3 - <<'EOF'
import json, glob
models, endpoints, dates, byok = set(), set(), set(), set()
for p in glob.glob('~/d/familiar-cats/sprites/*/provenance.json'):
    d = json.load(open(p))
    models.add(d['request']['body']['model'])
    endpoints.add(d['request']['endpoint'])
    dates.add(d['generatedAt'][:10])
    byok.add(d['usage']['is_byok'])
print('models:', sorted(models))
print('endpoints:', sorted(endpoints))
print('dates:', sorted(dates))
print('byok:', sorted(byok))
EOF
```

Expected: exactly one model `openai/gpt-5.4-image-2`, one endpoint
`https://openrouter.ai/api/v1/images`, dates within 2026-07-31..2026-08-02,
`byok: [False]`. If anything else appears, record it — the review must cover
every model/provider actually used.

- [ ] **Step 2: Fetch and read the controlling documents**

Fetch (WebFetch or browser), recording for each the URL, its stated
version/effective date, and today's date as the date checked:

1. OpenRouter Terms of Service — https://openrouter.ai/terms — find the
   clause delegating output ownership to Model Terms, and any OpenRouter-level
   condition on outputs.
2. The Model Terms OpenRouter records for `openai/gpt-5.4-image-2` — start at
   https://openrouter.ai/openai/gpt-5.4-image-2 and follow its terms link.
   Needed: the terms **effective on the generation dates** (2026-07-31 →
   2026-08-02); if the current text postdates them, look for a changelog or
   archived version, and if none is available, record that the current text is
   the best available evidence and note its effective date.
3. OpenAI's terms governing API/image outputs (ownership/assignment of
   outputs, publication and commercial-use rights, attribution or
   AI-disclosure obligations), both as-of-generation and current.

- [ ] **Step 3: Write the review document**

Create `~/d/familiar-cats/docs/asset-rights.md` with exactly this structure,
filling every bracketed field from Step 2 (no field may remain bracketed):

```markdown
# Asset rights review

Date checked: [YYYY-MM-DD]. Reviewer: Keith Hughitt (conclusion approved) with
agent-assisted research.

## Scope

Every image under `sprites/` was generated between 2026-07-31 and 2026-08-02
via the OpenRouter images endpoint, model `openai/gpt-5.4-image-2`,
provider-pinned to OpenAI, no BYOK key. Per-image evidence:
`sprites/<member>/provenance.json` (full request, prompt, image digest, cost).

## Documents reviewed

| Document | Version / effective date | URL | Date checked |
| --- | --- | --- | --- |
| OpenRouter Terms of Service | [version] | https://openrouter.ai/terms | [date] |
| Model Terms for openai/gpt-5.4-image-2 | [version] | [url] | [date] |
| OpenAI output-ownership terms | [version] | [url] | [date] |

## Findings

1. **Ownership/assignment:** [what the terms say about who owns the outputs,
   quoting or closely paraphrasing the operative clause, and whether that
   permits relicensing under CC BY 4.0]
2. **Obligations:** [any attribution, AI-disclosure, or usage condition that
   must be carried into LICENSE-assets; "none found" is a valid finding]
3. **Attribution party:** [whether anything requires naming the provider
   instead of or alongside Keith Hughitt]

## Conclusion

[One of:]
Conclusion: PASS — the outputs may be distributed and licensed under
CC BY 4.0 with attribution to Keith Hughitt[, subject to: <conditions>].
[or]
Conclusion: FAIL — [redistribution barred / relicensing barred], because
[reason].
```

- [ ] **Step 4: HUMAN STOP GATE — present and get approval**

Present the completed review to the human verbatim and stop. Do not proceed to
Step 5 or any later task without an explicit approval of the conclusion.

- If the human approves a **PASS**: continue.
- If the conclusion is **FAIL — redistribution barred**: run
  `gh repo edit khughitt/familiar-cats --visibility private --accept-visibility-change-consequences`,
  commit the review document anyway (evidence), and stop the plan.
- If **FAIL — relicensing barred** only: stop the plan; the art-license
  decision reopens with the human (spec §2). The repo may stay public.

- [ ] **Step 5: Commit (do not push yet)**

```bash
git -C ~/d/familiar-cats add docs/asset-rights.md
git -C ~/d/familiar-cats commit -m "docs: record the asset rights review"
```

(Pushed in Task 2 together with the license files, so the public repo never
shows a review without its licenses.)

---

### Task 2: Cats licenses and README

**Files:**
- Create: `~/d/familiar-cats/LICENSE`
- Create: `~/d/familiar-cats/LICENSE-assets`
- Create: `~/d/familiar-cats/README.md`

**Interfaces:**
- Consumes: Task 1's approved `docs/asset-rights.md` (its `Conclusion:` line, including any `subject to:` conditions, which must be carried into `LICENSE-assets`).
- Produces: the three files above, live on the public cats `main`. Task 3 scans this state; Task 6 adds CI on top of it.

- [ ] **Step 1: Write `LICENSE` (MIT)**

Create `~/d/familiar-cats/LICENSE`:

```text
MIT License

Copyright (c) 2026 Keith Hughitt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Write `LICENSE-assets`**

Create `~/d/familiar-cats/LICENSE-assets`. If Task 1's conclusion carried
`subject to:` conditions, add each as its own sentence after the disclosure
paragraph:

```text
The images under sprites/ are licensed under the Creative Commons
Attribution 4.0 International license (CC BY 4.0):
https://creativecommons.org/licenses/by/4.0/

Attribution: Keith Hughitt.

These images were generated with the openai/gpt-5.4-image-2 model via
OpenRouter. Per-image generation evidence (full request, prompt, digest,
cost) is recorded in sprites/<member>/provenance.json. The rights basis for
this grant is documented in docs/asset-rights.md.
```

- [ ] **Step 3: Write `README.md`**

Create `~/d/familiar-cats/README.md`:

```markdown
# familiar-cats

A twelve-cat theme pack for [familiar](https://github.com/khughitt/familiar).
Pixel-art cats, one per identity slot, each with six states.

## Install

```
familiar theme add https://github.com/khughitt/familiar-cats
```

The pack is validated whole and promoted atomically; an install receipt
records this repository's URL and the installed commit.

## Licensing

Everything in this repository is MIT licensed (see `LICENSE`) — including
`theme.yaml` and the per-image provenance manifests — with these exceptions:

- `sprites/**` images: CC BY 4.0, see `LICENSE-assets`.
- `README.md` and `docs/asset-rights.md`: CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/).
```

- [ ] **Step 4: Prove the pack still validates with the new files**

The validator must see the pack as `theme add` promotes it (no `.git`), so
validate a `git archive` of the commit, not the work tree. Commit first:

```bash
git -C ~/d/familiar-cats add LICENSE LICENSE-assets README.md
git -C ~/d/familiar-cats commit -m "docs: license the pack and its art"
tmp=$(mktemp -d)
git -C ~/d/familiar-cats archive HEAD | tar -x -C "$tmp"
~/d/familiar/bin/familiar theme validate "$tmp"
rm -rf "$tmp"
```

(The primary clone's `familiar` is used because the worktree has no
`node_modules` until Task 7/8.)

Expected: the validate line reports the pack conforms (12 members). If it
fails, fix before pushing — a broken public pack breaks `theme add` for
everyone.

- [ ] **Step 5: Push**

```bash
git -C ~/d/familiar-cats push origin main
```

---

### Task 3: Cats sweep + scans; start the execution notes

**Files:**
- Create: `docs/ref/2026-08-19-publication-gate-notes.md` (engine worktree)

**Interfaces:**
- Consumes: cats `main` as pushed by Task 2.
- Produces: the execution-notes file; Tasks 4 and 10 append to it. Format: one `## <repo>` section per repo with `### gitleaks` / `### npm audit` subsections, each ending in a `Disposition:` line.

- [ ] **Step 1: Machine-path sweep (expect clean)**

```bash
grep -rn "/home/\|/mnt/\|~/d/" ~/d/familiar-cats --exclude-dir=.git
```

Expected: no output. If there are hits, replace each with a neutral
equivalent, commit as `docs: sweep machine-specific paths`, and push.

- [ ] **Step 2: Secret scan**

```bash
gitleaks detect --source ~/d/familiar-cats --no-banner
```

Expected: `no leaks found`. A real secret stops everything for this repo:
tell the human; the repo goes private until rotated.

- [ ] **Step 3: Start the execution notes**

Create `docs/ref/2026-08-19-publication-gate-notes.md` in the engine worktree:

```markdown
# Publication gate — execution notes

Scan and audit dispositions for the three public repos, per the gate spec
(`docs/specs/2026-08-19-publication-gate-design.md` §5).

## familiar-cats

### gitleaks

[paste the gitleaks summary line]

Disposition: [clean — no action / finding-by-finding disposition]

### npm audit

Not applicable — no package.json, no dependencies.
```

- [ ] **Step 4: Commit (engine worktree)**

```bash
git add docs/ref/2026-08-19-publication-gate-notes.md
git commit -m "docs(publication): record cats scan dispositions"
```

---

### Task 4: Theme licenses, sweep, scans, CI

**Files:**
- Create: `~/d/familiar-theme/LICENSE`
- Create: `~/d/familiar-theme/LICENSING.md`
- Create: `~/d/familiar-theme/.github/workflows/test.yml`
- Modify: `~/d/familiar-theme/README.md`
- Modify: `docs/ref/2026-08-19-publication-gate-notes.md` (engine worktree)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: theme `main` carrying licenses + green CI, ready for Task 5's release. The workflow file name `test.yml` and its `npm ci` + `npm test` shape are reused verbatim for the engine in Task 9.

- [ ] **Step 1: Write `LICENSE`**

Create `~/d/familiar-theme/LICENSE` with exactly the same MIT text as Task 2
Step 1 (identical file, © 2026 Keith Hughitt).

- [ ] **Step 2: Write `LICENSING.md`**

Create `~/d/familiar-theme/LICENSING.md`:

```markdown
# Licensing

Everything in this repository is MIT licensed (see `LICENSE`), with these
exceptions:

- `README.md`: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
```

- [ ] **Step 3: Mark the private archive link in the README**

In `~/d/familiar-theme/README.md`, the line
`- Pre-split history: https://github.com/khughitt/familiar-archive` links to a
private repo from a soon-public README. Change it to:

```markdown
- Pre-split history: https://github.com/khughitt/familiar-archive (private archive)
```

- [ ] **Step 4: Machine-path sweep (expect clean)**

```bash
grep -rn "/home/\|/mnt/\|~/d/" ~/d/familiar-theme --exclude-dir=.git --exclude-dir=node_modules
```

Expected: no output. Fix any hits as in Task 3 Step 1.

- [ ] **Step 5: Write the CI workflow**

Create `~/d/familiar-theme/.github/workflows/test.yml`:

```yaml
name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['22', '26']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm test
```

- [ ] **Step 6: Prove the suite passes locally on the floor semantics**

```bash
(cd ~/d/familiar-theme && npm ci && npm test)
```

Expected: all tests pass. (CI proves Node 22 and 26; locally any current Node
is fine — the matrix is the floor evidence.)

- [ ] **Step 7: Scans + notes**

```bash
gitleaks detect --source ~/d/familiar-theme --no-banner
(cd ~/d/familiar-theme && npm audit --omit=dev)
```

Expected: no leaks; no audit findings (design-time observation: none).
Append to `docs/ref/2026-08-19-publication-gate-notes.md` in the engine
worktree:

```markdown
## familiar-theme

### gitleaks

[paste summary]

Disposition: [clean — no action / dispositions]

### npm audit (--omit=dev)

[paste summary]

Disposition: [clean — no action / dispositions]
```

- [ ] **Step 8: Commit both repos and push theme**

```bash
git -C ~/d/familiar-theme add LICENSE LICENSING.md README.md .github
git -C ~/d/familiar-theme commit -m "docs: license the contract package and add CI"
git -C ~/d/familiar-theme push origin main
git add docs/ref/2026-08-19-publication-gate-notes.md
git commit -m "docs(publication): record theme scan dispositions"
```

Note: the theme push runs CI while the repo is still private — that is fine
(its own `GITHUB_TOKEN` reads its own repo). Verify after the push:

```bash
gh run watch --repo khughitt/familiar-theme --exit-status $(gh run list --repo khughitt/familiar-theme --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: exit 0 (all matrix jobs green). A red run stops Task 5.

---

### Task 5: Theme release v0.1.1 and public flip

**Files:**
- Modify: `~/d/familiar-theme/package.json` (version)
- Modify: `~/d/familiar-theme/package-lock.json` (version)

**Interfaces:**
- Consumes: Task 4's licensed, CI-green theme `main`.
- Produces: public repo `khughitt/familiar-theme` with tag `v0.1.1` whose tree carries `LICENSE`/`LICENSING.md` and identifies as `0.1.1`. Task 6 pins `git+https://github.com/khughitt/familiar-theme.git#v0.1.1`; Task 8 uses the same ref.

- [ ] **Step 1: Bump the version in both files**

```bash
(cd ~/d/familiar-theme && npm version 0.1.1 --no-git-tag-version)
git -C ~/d/familiar-theme diff --stat
```

Expected: exactly `package.json` and `package-lock.json` changed, both now
`0.1.1`.

- [ ] **Step 2: Commit and tag**

```bash
git -C ~/d/familiar-theme add package.json package-lock.json
git -C ~/d/familiar-theme commit -m "chore(release): v0.1.1 — first licensed release"
git -C ~/d/familiar-theme tag v0.1.1
```

- [ ] **Step 3: Verify the tag before it leaves the machine**

```bash
git -C ~/d/familiar-theme ls-tree --name-only v0.1.1 | grep -E "^LICENSE$|^LICENSING.md$"
git -C ~/d/familiar-theme show v0.1.1:package.json | grep '"version"'
git -C ~/d/familiar-theme rev-parse v0.1.0   # must be unchanged: abb16a0b86e57a03cec4059f69dd0b915939aae5
```

Expected: both license files listed; version line reads `"version": "0.1.1"`;
`v0.1.0` still resolves to `abb16a0b86e57a03cec4059f69dd0b915939aae5`.

- [ ] **Step 4: Push, then flip public**

```bash
git -C ~/d/familiar-theme push origin main --follow-tags
gh repo edit khughitt/familiar-theme --visibility public --accept-visibility-change-consequences
```

- [ ] **Step 5: Verify anonymous access to the exact ref**

```bash
git ls-remote https://github.com/khughitt/familiar-theme.git refs/tags/v0.1.1
```

Run this with no credential helper interference if possible; the point is the
URL form Task 6/8 will use resolves. Expected: one line with the tag SHA.

---

### Task 6: Cats CI (validate against the public theme)

**Files:**
- Create: `~/d/familiar-cats/.github/workflows/validate.yml`

**Interfaces:**
- Consumes: public `familiar-theme` tag `v0.1.1` (Task 5); `validateThemePack(dir)` from the `familiar-theme` package (resolves a pack directory; throws with a named reason on any violation).
- Produces: green `validate` workflow on cats `main`, closing cats' checklist item left open since Task 3.

- [ ] **Step 1: Write the workflow**

Create `~/d/familiar-cats/.github/workflows/validate.yml`. The pack is checked
out into a subdirectory and its `.git` removed before validation, because the
validator walks every entry and must see the pack as `theme add` promotes it:

```yaml
name: validate
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          path: pack
      - uses: actions/setup-node@v4
        with:
          node-version: '26'
      - run: rm -rf pack/.git
      - run: npm install git+https://github.com/khughitt/familiar-theme.git#v0.1.1
      - run: node -e "import('familiar-theme').then(m => m.validateThemePack('pack')).then(p => console.log('pack ok:', p.members.length, 'members'))"
```

- [ ] **Step 2: Commit, push, verify green**

```bash
git -C ~/d/familiar-cats add .github/workflows/validate.yml
git -C ~/d/familiar-cats commit -m "ci: validate the pack against familiar-theme v0.1.1"
git -C ~/d/familiar-cats push origin main
gh run watch --repo khughitt/familiar-cats --exit-status $(gh run list --repo khughitt/familiar-cats --limit 1 --json databaseId -q '.[0].databaseId')
```

Expected: exit 0 and the log line `pack ok: 12 members`.

---

### Task 7: Engine licenses and sweep

**Files:**
- Create: `LICENSE` (engine worktree)
- Create: `LICENSING.md`
- Modify: `README.md`
- Modify: `src/bus/pins.js:9-11`
- Modify: `test/pins.test.js:70-72`
- Modify: `docs/install.md`
- Delete: `docs/ref/kitty-graphics-protocol.md`
- Delete: `.superpowers/sdd/` (tracked task reports)

**Interfaces:**
- Consumes: nothing from earlier tasks (safe to prepare in parallel with 4–6, but it commits on the `publication-gate` branch).
- Produces: a sweep-clean engine tree; Task 10's final grep must come back empty.

- [ ] **Step 1: Write `LICENSE`**

Create `LICENSE` in the engine worktree with exactly the same MIT text as
Task 2 Step 1 (identical file, © 2026 Keith Hughitt).

- [ ] **Step 2: Write `LICENSING.md`**

Create `LICENSING.md`:

```markdown
# Licensing

Everything in this repository is MIT licensed (see `LICENSE`), with these
exceptions:

- `docs/` and `README.md`: CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/).
- `vendor/rowcolumn-diacritics.txt`: derived from the Unicode Character
  Database (`UnicodeData.txt`), © Unicode, Inc., used under the Unicode
  License v3 (https://www.unicode.org/license.txt).
```

- [ ] **Step 3: Mark the private archive link in the README**

In `README.md`, change:

```markdown
- Pre-split history: https://github.com/khughitt/familiar-archive
```

to:

```markdown
- Pre-split history: https://github.com/khughitt/familiar-archive (private archive)
```

- [ ] **Step 4: Delete the copied spec text and the process reports**

```bash
git rm docs/ref/kitty-graphics-protocol.md
git rm -r .superpowers
```

(No file references `kitty-graphics-protocol.md`, verified at plan time — no
citation edits needed. The kitty graphics protocol is documented upstream at
https://sw.kovidgoyal.net/kitty/graphics-protocol/; nothing in the tree needs
to say so after the deletion.)

- [ ] **Step 5: Reword the pins comments**

In `src/bus/pins.js`, replace:

```javascript
// A pin path and a git repo root can name the same directory through different
// routes: `git rev-parse --show-toplevel` reports the PHYSICAL path, while a
// human writes the symlink they actually `cd` through (`~/d/familiar`, which on
// this machine is /mnt/ssd/Dropbox/familiar). Compare them lexically and the pin
// matches nothing — silently, which is the one outcome this whole system exists
// to prevent. So canonicalize BOTH sides.
```

with:

```javascript
// A pin path and a git repo root can name the same directory through different
// routes: `git rev-parse --show-toplevel` reports the PHYSICAL path, while a
// human writes the symlink they actually `cd` through (a `~/projects/x` link
// to wherever the clone physically lives). Compare them lexically and the pin
// matches nothing — silently, which is the one outcome this whole system exists
// to prevent. So canonicalize BOTH sides.
```

In `test/pins.test.js`, replace:

```javascript
  // git reports the PHYSICAL repo root. `~/d/familiar` on this machine is
  // /mnt/ssd/Dropbox/familiar. If matchPin compared strings, the pin the user
  // wrote would match nothing and they would never be told why.
```

with:

```javascript
  // git reports the PHYSICAL repo root; the user pins the symlink they cd
  // through. If matchPin compared strings, the pin the user wrote would match
  // nothing and they would never be told why.
```

- [ ] **Step 6: Sweep `docs/install.md`**

```bash
sed -i 's|~/d/familiar|/path/to/familiar|g' docs/install.md
```

Then add this sentence to the end of the file's opening paragraph (after
"...add the ones you use."):

```markdown
Examples below use `/path/to/familiar`; substitute the absolute path of your
clone.
```

- [ ] **Step 7: Verify the sweep and the suite**

```bash
grep -rn "/home/\|/mnt/\|~/d/" --include="*.js" --include="*.md" --include="*.yaml" --include="*.json" . | grep -v node_modules | grep -v "^\./\.git" | grep -v "docs/plans/2026-08-19-publication-gate.md"
[ -d node_modules ] || npm ci
npm test
```

(This plan document itself names the `~/d/` clones and is excluded from the
sweep; it is an internal execution record, like the spec's decision history.
`npm ci` is needed because the worktree starts without `node_modules`; at this
task the dependency is still the SSH `v0.1.0` ref, which resolves locally.)

Expected: grep output contains no machine-specific paths (matches inside
`docs/ref/2026-08-19-publication-gate-notes.md` quoting scanner output are
acceptable only if they name no real local path); `npm test` passes
(771+ tests, the pins tests among them — the comment edits touch no code).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs(publication): license the engine and sweep machine paths"
```

---

### Task 8: Engine dependency flip to the licensed public tag

**Files:**
- Modify: `package.json` (engine worktree)
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: public `familiar-theme` `v0.1.1` (Task 5).
- Produces: manifest + lockfile resolving `familiar-theme` as `git+https://github.com/khughitt/familiar-theme.git#v0.1.1`; Task 9's `npm ci` depends on the lockfile being regenerated here.

- [ ] **Step 1: Flip the manifest**

In `package.json`, change:

```json
    "familiar-theme": "git+ssh://git@github.com/khughitt/familiar-theme.git#v0.1.0",
```

to:

```json
    "familiar-theme": "git+https://github.com/khughitt/familiar-theme.git#v0.1.1",
```

- [ ] **Step 2: Regenerate the lockfile against the new ref**

```bash
npm install
grep -c "git+ssh" package-lock.json
grep -n "familiar-theme.git#" package.json package-lock.json | head
```

Expected: `grep -c git+ssh` prints `0`; the lockfile's `resolved` field for
familiar-theme is a `git+https` URL pinned to the `v0.1.1` commit SHA.

- [ ] **Step 3: Prove the frozen install and the suite**

```bash
rm -rf node_modules
npm ci
npm test
```

Expected: `npm ci` succeeds from the lockfile alone; all tests pass. Also
confirm the installed contract is the licensed release:

```bash
grep '"version"' node_modules/familiar-theme/package.json
test -f node_modules/familiar-theme/LICENSE && echo licensed
```

Expected: `"version": "0.1.1"` and `licensed`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: consume familiar-theme v0.1.1 over public HTTPS"
```

---

### Task 9: Engine CI

**Files:**
- Create: `.github/workflows/test.yml` (engine worktree)

**Interfaces:**
- Consumes: Task 8's lockfile (CI's `npm ci` fails on any manifest/lock mismatch); public theme repo for anonymous git-dep resolution.
- Produces: `test` matrix (Node 22/26) + `smoke` clean-install job, green on the `publication-gate` branch push in Task 10.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/test.yml`:

```yaml
name: test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['22', '26']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: npm ci
      - run: npm test
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '26'
      - name: clean-clone install smoke
        run: |
          cp -r . "$RUNNER_TEMP/smoke"
          cd "$RUNNER_TEMP/smoke"
          rm -rf node_modules package-lock.json .git
          npm install
          ./bin/familiar --help
```

The smoke job deliberately deletes the lockfile: it proves the user-facing
`npm install` path resolves the public `familiar-theme` over HTTPS from the
manifest alone, then that the CLI entry point runs. `familiar --help` exits 0
(verified at plan time).

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: test on the Node floor and current, smoke the clean install"
```

---

### Task 10: Engine scans, spec status, merge, flip, end-to-end verification

**Files:**
- Modify: `docs/ref/2026-08-19-publication-gate-notes.md`
- Modify: `docs/specs/2026-08-19-publication-gate-design.md:3` (status header)

**Interfaces:**
- Consumes: everything above; green CI is a precondition for the flip.
- Produces: public `khughitt/familiar`; the gate is closed.

- [ ] **Step 1: Scans + notes**

```bash
gitleaks detect --source . --no-banner
npm audit --omit=dev
```

Append to `docs/ref/2026-08-19-publication-gate-notes.md`:

```markdown
## familiar (engine)

### gitleaks

[paste summary]

Disposition: [clean — no action / dispositions]

### npm audit (--omit=dev)

[paste summary — design-time observation was two low findings]

Disposition: [for each finding: accepted (low, no exposed surface) or fixed
via <action>]
```

- [ ] **Step 2: Correct the spec status in the landing change**

In `docs/specs/2026-08-19-publication-gate-design.md`, change:

```markdown
**Status:** approved design, unimplemented
```

to:

```markdown
**Status:** implemented; all three repos public, executed per §1's order
```

- [ ] **Step 3: Commit, merge to main, push**

```bash
git add docs/ref/2026-08-19-publication-gate-notes.md docs/specs/2026-08-19-publication-gate-design.md
git commit -m "docs(publication): record engine dispositions and close the gate"
git -C ~/d/familiar merge --no-ff publication-gate -m "merge: publication gate — licenses, sweep, scans, CI"
git -C ~/d/familiar push origin main
```

(The merge runs in the primary clone, which is already on `main`; the
worktree keeps the `publication-gate` branch checked out.)

- [ ] **Step 4: Verify CI green on main, then flip**

```bash
gh run watch --repo khughitt/familiar --exit-status $(gh run list --repo khughitt/familiar --limit 1 --json databaseId -q '.[0].databaseId')
gh repo edit khughitt/familiar --visibility public --accept-visibility-change-consequences
```

A red run stops the flip: fix on `main` first.

- [ ] **Step 5: End-to-end anonymous verification**

```bash
tmp=$(mktemp -d)
git -C "$tmp" clone https://github.com/khughitt/familiar.git
(
  cd "$tmp/familiar"
  npm install
  ./bin/familiar --help
  FAMILIAR_CONFIG_DIR="$tmp/config" FAMILIAR_STATE_DIR="$tmp/state" ./bin/familiar theme add https://github.com/khughitt/familiar-cats
  FAMILIAR_CONFIG_DIR="$tmp/config" FAMILIAR_STATE_DIR="$tmp/state" ./bin/familiar theme list
)
rm -rf "$tmp"
```

Expected: anonymous clone succeeds; `npm install` resolves the public theme;
`theme add` installs `cats` (12 members) into the scratch config; `theme list`
shows the receipt line with the public URL. The installed pack now carries
`LICENSE`, `LICENSE-assets`, `README.md`, and `docs/asset-rights.md` — the
license travels with every install.

- [ ] **Step 6: Final acceptance sweep**

Confirm every checklist item per repo: rights (cats) ∙ licenses ∙ sweep ∙
scan + audit disposition ∙ CI green ∙ visibility. Report the completed table
to the human:

| Repo | rights | licenses | sweep | scans | CI | public |
| --- | --- | --- | --- | --- | --- | --- |
| familiar-cats | Task 1 | Task 2 | Task 3 | Task 3 | Task 6 | already |
| familiar-theme | n/a | Task 4 | Task 4 | Task 4 | Task 4 | Task 5 |
| familiar | n/a | Task 7 | Task 7 | Task 10 | Task 10 | Task 10 |
