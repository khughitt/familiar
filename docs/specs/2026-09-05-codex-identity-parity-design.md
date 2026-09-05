# Codex identity parity

**Status:** proposed; no implementation. Field repairs applied 2026-09-05 (§7).
**Date:** 2026-09-05
**Task:** fam-c5c263

One project must resolve to one familiar on every surface. It currently does
not: Claude Code and Codex disagree about the same repository, and the
disagreement is silent, permanent, and — outside a hand-maintained list of
projects — the normal case rather than the exception.

This spec explains why the two disagree, argues that the cause is structural
rather than a missing sync, and proposes the shape of a fix.

## 1. The report

`~/d/beliefs` drew a teal Spectral Cat in Codex and an orange Tortoiseshell in
Claude Code, at the same commit, in the same repository, on the same machine.

Both are "correct" for their own inputs:

```
github.com/verifiably/beliefs -> autoSlot -> slot 2 -> tortoiseshell   Claude Code (live)
<repo>/.codex/config.toml     -> pet = "custom:familiar-spectral-cat"  Codex (baked, slot 5)
```

`beliefs` was pinned to slot 5 in `identities.yaml` when
`familiar install pets --sync-projects` last ran (every project config on the
machine carries one mtime, `2026-08-22 21:05:13`, written in pin-list order).
The pin was removed a week later — `identities.yaml` mtime `2026-08-29
11:10:01` — and Claude Code, which resolves identity on every hook, immediately
fell back to `autoSlot`. Codex kept reading the file nobody rewrote.

Two details make this more than a one-off:

- The Aug 22 run **predates** `d53b59f fix(codex): sync the current project's
  pet, not only pinned identities` (2026-08-29). Before that commit
  `--sync-projects` touched pinned paths only, which is the corroborating
  evidence that `beliefs` was pinned at the time.
- Every *still-pinned* project's config still matched its pin exactly.
  `beliefs` was the only orphan. The mechanism is not unreliable; it is
  **eager**, and eager artifacts go stale the moment their inputs move.

## 2. The structural cause

Familiar renders every surface it owns — the Claude Code status line, the niri
bar and desktop, the OpenCode plugin — from the bus, live, on every hook. Codex
is the one surface it does not render. Codex owns its TUI and draws its own pet
from a spritesheet, so Familiar's Codex integration is an **offline compiler**
(`src/render/codex/pets.js`), and `printsPlaceholderCells = false` in
`src/adapters/codex.js` says exactly that.

That is not a wart to refactor away; it is the integration boundary Codex
offers. What follows from it is that per-project identity on Codex can only be
expressed through the one lever Codex exposes: `[tui] pet`, resolved through its
normal config layers, of which `<repo>/.codex/config.toml` is the per-project
one.

So the lever is right. What is wrong is **who writes it, and when**.

### 2.1 Failure mode A — staleness

`planCodexProjectSync` (`src/install/codex.js`) resolves identity through the
same `resolveIdentity` every other surface uses, then freezes the answer into a
file. Nothing invalidates that file. It rots on any change to an identity input:
a pin added, removed, or re-slotted; a repository renamed or transferred (the
`projectKey` is the normalized remote); a theme swapped; `SLOT_COUNT` changed.
This is the `beliefs` case, and its lifetime is unbounded.

### 2.2 Failure mode B — coverage

This is the larger one, and the report above obscured it.

`--sync-projects` writes configs for `identities.yaml` path pins plus the
current directory. Projects are unbounded and discovered lazily; a pin list
enumerates a handful. Every repository not on that list has **no project
config** and falls through to the user-wide `[tui] pet`.

On the author's machine that setting was `custom:familiar-ginger` — slot 0,
which is the `familiar` repository's own cat. Every unenumerated project was
therefore drawing `familiar`'s identity in Codex while Claude Code drew the
correct one. Sixteen projects were enumerated. Every other repository on the
machine was wrong, and wrong in a way that reads as a confident answer rather
than a missing one.

A second Codex home on the same machine (`~/.codex-work`) carries
`pet = "familiar-ginger-tabby"` — a member id that no longer exists in the
theme, and missing the `custom:` prefix besides. Hand-maintained pet settings
rot; that is the third instance of the same failure in one investigation.

### 2.3 The ordering constraint

This is the crux, and it disqualifies the obvious fix.

Codex reads `[tui] pet` when its TUI starts. Familiar's Codex hook chain does
not begin until the **first turn** — measured against Codex 0.146 and recorded
in `src/adapters/codex.js`: a clean Codex prompt sat for over a minute with no
hook of any kind having run.

Therefore **nothing Familiar writes at hook time can affect the session it runs
in.** A self-healing hook is not a complete fix; it is always exactly one launch
late. Any design that claims otherwise is wrong about the ordering.

## 3. Scope

**In:** the mechanism that keeps `<repo>/.codex/config.toml` in agreement with
the resolver; the no-project fallback; the demotion of `--sync-projects` from
primary mechanism to bootstrap and repair; drift reporting.

**Out (deferred, with reason):**

- **Rewriting the pet spritesheet per project.** A single stable pet id whose
  `assets/sheet.png` is rewritten to the current project's member would race
  across concurrent Codex sessions in different repositories — they share one
  file — and it still loses to §2.3 regardless. Rejected outright, not deferred.
- **A launch wrapper** (`familiar codex`, or a shell function that syncs then
  `exec`s the real binary). It is the *only* ordering-correct fix, and it is
  rejected on contract grounds: a cosmetic layer that is correct through one
  entry point and silently degrades when the user types the real binary is a
  worse promise than one that is honestly one launch behind. Revisit only if
  §6.1 resolves against us.
- **Untrusted projects.** Codex honors project config only in trusted projects,
  so no write-based mechanism can reach an untrusted one. Out of Familiar's
  control; document, do not paper over.

## 4. Design

### 4.1 Converge the project config from the hook

On the Codex `SessionStart` event, after identity resolution (which the hook
performs anyway, to put the session on the bus), compare the resolved member
against the `pet` already on disk for this repository. When they disagree, write
the config through the existing `planCodexProjectSync` / `applyCodexProjectSync`
path, inheriting its refusals unchanged: never a tracked config, never an
unmanaged one, never a symlink, never the user-wide file.

The property this buys is **convergence**, not correctness-on-first-launch:

| | today | converged |
|---|---|---|
| new repository, first Codex launch | wrong forever | wrong once |
| every launch after | wrong forever | correct |
| pin / theme / remote changed | wrong forever | correct next launch |

One launch of lag, self-healing thereafter, versus permanent silent drift. The
lag must be **documented, not hidden** — the same standard `src/adapters/codex.js`
already holds itself to when it declares `needs-input` and `error` unreachable
rather than inferring them from an unstable format.

Cost on the hook path is one read of a ~120-byte file per `SessionStart`, with
writes only on mismatch. The `git ls-files` and `git rev-parse --git-path`
spawns stay on the write path, so the bounded-hook discipline argued for at
length in `src/bus/identity.js` survives intact.

### 4.2 An honest fallback for "no project"

The user-wide `[tui] pet` must not name a real member. Slot 0's member is a
specific project's identity, and pointing every unresolved project at it is the
precise failure §2.2 describes.

The right answer is a theme member that means *no project identity* — visibly a
familiar, visibly not any particular one. That is a `familiar-theme` spec
change, not a config edit: `parseSlots` in `src/theme/pack.js` rejects an empty
slot list outright (`slots is empty — a member holds at least one slot`), and
pack validation requires every one of `SLOT_COUNT` slots to be covered. A
slotless member is currently unrepresentable.

Until that lands, the honest state is **no user-wide `pet` setting at all**:
Codex falls back to its own built-in pet, which is obviously not a familiar and
therefore tells no lie about identity. Applied in §7.

### 4.3 Demote `--sync-projects`

With §4.1 in place, `install pets --sync-projects` stops being the mechanism and
becomes bootstrap (seed a machine) and repair (force agreement now, without
waiting for a launch). It should additionally **report drift** — for every known
project config, whether the baked member still equals the resolved one — so the
`beliefs` class of failure is visible without an investigation.

## 5. Alternative: stop carrying identity in Codex's pet

Worth recording because it is the philosophically consistent option, not a straw
man.

Familiar could set one neutral familiar user-wide and carry per-project identity
on the channels that are already live and correct under Codex: the OSC
background tint and the bell (which need no cells — see `src/render/term/osc.js`)
and every bus surface, none of which need Codex's cooperation. Codex would then
have one fewer identity channel than Claude Code, but would never show the
*wrong* cat.

This is the same trade `src/adapters/codex.js` already makes for its two
unreachable states — *"four states honestly than six with two of them lying."*
Applied to identity, it makes the harnesses differ in **fidelity** rather than in
**answer**, which is arguably the real requirement.

It is not the recommendation because it gives up the per-project familiar on one
of the two primary harnesses, and that is the feature. Hold it as the fallback
if §6.1 resolves badly or the launch lag proves annoying in practice.

## 6. Open questions

### 6.1 Does current Codex fire a launch-time hook?

Load-bearing for the whole design. The "no hook until the first turn" finding is
measured against **Codex 0.146**. If a newer Codex added a launch-time event,
§4.1 upgrades from *converging* to *complete* — correct on the very first
launch — and §5 loses most of its appeal. **Verify against the installed version
before implementing.**

### 6.2 Does Codex re-read config or pets mid-session?

Assumed no. If it re-reads, the lag window shrinks further and a mid-session
repair becomes visible immediately.

### 6.3 Worktrees

`repoRoot` for a worktree is the worktree path, so each worktree gets its own
`.codex/config.toml` while sharing the `projectKey` (and therefore the member)
of its parent repository. Correct, but multiplies the number of files §4.1 must
keep converged. Confirm this is wanted before implementing.

## 7. Field repairs applied 2026-09-05

Independent of the design; done to stop the bleeding.

- `beliefs` re-synced: `spectral-cat` -> `tortoiseshell`, matching Claude Code.
- Three pinned projects (`familiar-forge`, `science`, `prism`) that had **no**
  project config — and were therefore falling through to the user-wide default —
  received correct ones. Every other project config was already correct and was
  rewritten identically.
- The user-wide `[tui] pet = "custom:familiar-ginger"` was removed per §4.2.
  Restore by re-adding that line under `[tui]` if the interim proves worse than
  the lie.

`~/.codex-work`'s stale `familiar-ginger-tabby` was left alone: it is a separate
`CODEX_HOME` and not this investigation's to change.
