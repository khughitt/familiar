# Host install recovery brief

Date: 2026-10-17. Goal: fam-ebff9c. Members: fam-752fd3 (scoped), fam-fb393c (briefed).

## Problem

A host whose familiar install has drifted from what is synced to it should recover with one
command, and every hook in the meantime should say what is wrong and what to run. On europa
on 2026-10-16 neither held: a stale `familiar-theme` install and a synced theme receipt with
no theme behind it each broke every invocation, and each surfaced as a raw Node error.

## Current behaviour and evidence

- **Stale dependency.** europa had familiar-theme v0.2.0 installed (Sep 8) after the pin
  moved to v0.3.0 (fe8ec93, a270ac4, 2026-10-14); `src/theme/acquire.js` imports exports
  v0.2.0 lacks, so module load threw a SyntaxError. The launcher preflight from fb4b929
  (`src/deps.js` `requireDependencies`) checks only that `node_modules/<name>` exists. On
  the authoring host today the installed familiar-theme reports 0.3.0 like the pin, but
  `node_modules/.package-lock.json` resolves it to commit `f1ec639` while `package-lock.json`
  pins tag v0.3.0 at `4e876bc` (confirmed with `git ls-remote`). Comparing both
  lockfiles' `version` and `resolved` for the direct dependencies takes about 0.4 ms.
- **Missing theme with a synced receipt.** Receipts (`~/.config/familiar/theme-receipts/`)
  sync through dotfiles; packs (`themes/`) deliberately do not. With only `config.yaml`
  (`theme: cats`), `scheme.json` and `theme-receipts/cats.json` in a temp
  `FAMILIAR_CONFIG_DIR`, `familiar whoami` and `familiar hook SessionStart` print
  `familiar: ENOENT: no such file or directory, realpath '<repo>/themes/cats'`.
  `themeDirFor` (`src/config.js`) falls back to the shipped-themes dir, which this repo
  has not had since the split. `familiar theme show` says `unknown theme "cats"`.
- **Recovery today.** `theme add <url>` refuses with "orphan receipt … remove it first"
  (`src/theme/add.js`). After the receipt is deleted by hand, the re-add clones the
  source's current head (`cloneSource` in `src/theme/acquire.js`:
  `clone --depth 1 --single-branch --no-tags`), not the commit the receipt recorded
  (`08942fa` for cats).

## Constraints

- Launchers import only `src/deps.js`, which keeps to `node:` builtins (AGENTS.md).
- Hook stderr is all a user sees, once per hook: errors stay one line.
- Receipts are validated by `readReceipt` (`src/theme/receipt.js`): `https` receipts carry
  a 40-hex `commit`; `local` receipts carry an absolute `path` that may not exist on another host.
- `theme add` holds `.theme-add.lock` and stages under `.staging/` before promoting; anything
  that installs should reuse that path.
- fam-2b8fff (todo, planned) wants an update that stages a new pack and swaps the theme dir and
  receipt atomically. Restore is the same operation when no theme dir exists, with the
  source pinned to the receipt's commit.
- ops-9c7dab lists familiar among the projects without `just setup`. fam-752fd3 now adds the
  recipe.

## Alternatives

1. **`familiar theme restore [ID]`.** A new verb that reads each validated receipt with no
   theme dir and reinstalls it at the receipt's commit. With no ID it restores all, so a new
   host's setup is that one command.
2. **`theme add` adopts an orphan receipt.** Given the receipt's source, `add` installs at
   the recorded commit instead of refusing. This needs no new verb, but `add` then gets two
   meanings, and with no source argument there is nothing to tell it which receipt to use.
3. **Fold restore into fam-2b8fff's update.** One staged-swap path with a pinned-commit
   acquire, exposed as both `update` and `restore` (or `update --to-receipt`).

Lean: 3, with 1 as its user-facing verb. The pinned acquire and the atomic swap are the
shared work, and fam-2b8fff's planned run will design that machinery anyway. fam-fb393c
therefore waits on fam-2b8fff, and its spec should cover restore as the case where nothing is
installed.

## Unanswered questions

- Pinned fetch: GitHub serves `git fetch --depth 1 origin <sha>` for reachable commits.
  When the recorded commit has been force-pushed away, should restore fail and name the
  commit, or offer to install the current head? Fail is the default under fail-early. Who
  answers: fam-2b8fff's design.
- Local receipts: when `source.path` is absent on this host, restore should refuse and name
  the path; confirm in the design.
- Should restore rewrite `installedAt`, or keep the receipt byte-identical so dotfiles shows
  no diff? Who answers: the design (lean: keep it unchanged, since only the theme dir is
  restored).
- Order: restore is what a new host needs, and update is not. If restore should ship before
  update, swap the dependency so that fam-2b8fff waits on fam-fb393c. Who answers: the user.

## Proposed decomposition

- fam-752fd3: stale-dependency preflight in `src/deps.js` plus `just setup` (scoped,
  direct).
- fam-7e9440: name the missing theme and its receipt instead of the realpath ENOENT (scoped,
  direct). It is independent of restore and names today's manual recovery until restore exists.
- fam-2b8fff (existing, planned): its spec covers restore as the not-installed case.
  fam-fb393c depends on it and wakes when it closes.
