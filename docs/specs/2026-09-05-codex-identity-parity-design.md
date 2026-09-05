# Codex identity parity

**Status:** proposed; no implementation. Revised twice on 2026-09-05 after
review — see §8 for what changed and why. Field repairs applied 2026-09-05 (§7).
**Date:** 2026-09-05
**Task:** fam-c5c263

One project must resolve to one familiar on every surface. It currently does
not: Claude Code and Codex disagree about the same repository, and the
disagreement is silent, permanent, and — outside a hand-maintained list of
projects — the normal case rather than the exception.

This spec explains why the two disagree, argues that the cause is structural
rather than a missing sync, and proposes the shape of a fix. Review established
that the ceiling on that fix is lower than first drafted (§2.3, §6.1), and that
Familiar's own identity resolution is already inconsistent for worktrees of
pinned projects, independent of Codex (§6.2).

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
`pet = "familiar-ginger-tabby"` — a member id retired from the theme, and
missing the `custom:` prefix besides. Hand-maintained pet settings rot; that is
the third instance of the same failure in one investigation.

### 2.3 The ordering constraint

This is the crux, and it disqualifies the obvious fix.

Codex reads `[tui] pet` when its TUI starts. Familiar's Codex hook chain does
not begin until the **first turn** — measured against Codex 0.146 and recorded
in `src/adapters/codex.js`: a clean Codex prompt sat for over a minute with no
hook of any kind having run.

Against the installed **Codex 0.153.4**, the published hook reference lists
`SessionStart` as the earliest event and describes it as running *during the
agentic loop*, documents **no** pre-configuration hook, and documents **no**
mechanism for reloading configuration mid-session.

Therefore **nothing Familiar writes at hook time can affect the session it runs
in**, and this is a ceiling rather than a lag to be optimised away. Any design
that claims otherwise is wrong about the ordering. §6.1 states what evidence
would overturn this.

## 3. Scope

**In:** the mechanism that keeps `<repo>/.codex/config.toml` in agreement with
the resolver; the no-project fallback; the asset prerequisite that makes a
selection meaningful; the demotion of `--sync-projects` from primary mechanism
to bootstrap and repair; drift reporting.

**Out (deferred, with reason):**

- **Rewriting the pet spritesheet per project.** A single stable pet id whose
  `assets/sheet.png` is rewritten to the current project's member would race
  across concurrent Codex sessions in different repositories — they share one
  file — and it still loses to §2.3 regardless. Rejected outright, not deferred.
- **A launch wrapper** (`familiar codex`, or a shell function that syncs then
  `exec`s the real binary). It is the *only* ordering-correct fix, and it is
  rejected on contract grounds: a cosmetic layer that is correct through one
  entry point and silently degrades when the user types the real binary is a
  worse promise than one that is honestly one launch behind.
- **Overriding a user's own overrides.** Familiar writes exactly one file per
  repository, the one carrying its managed header. Nested project configs, a
  `--profile`, and `-c`/`--config` flags are the user's, and outrank it (§4.2).
  Familiar's guarantee is over the file it owns, never over the pixels.
- **Untrusted projects.** Codex honors project config in trusted projects only,
  so no write-based mechanism reaches an untrusted one. Out of Familiar's
  control; document, do not paper over.
- **Worktree pin inheritance** (§6.2). A real defect, but in Familiar's own
  resolver rather than in the Codex surface. It needs its own task.

## 4. Design

### 4.1 Converge the project config from the hook — one repository only

On the Codex `SessionStart` event, after identity resolution (which the hook
performs anyway, to put the session on the bus), compare the resolved member
against the `pet` in this repository's managed config. When they disagree, write
that one file.

**The planner must be scoped to the current repository, and this is not what
`planCodexProjectSync` does today.** It walks every `catalog.identities` path
pin before reaching `cwd`, accumulates `conflicts` across all of them, and
throws if *any* is unmanaged; `applyCodexProjectSync` then rewrites *every*
planned config. Called from a hook that is decorating one session in one
repository, that means an unmanaged `.codex/config.toml` in an unrelated project
aborts the repair here, and a successful repair here rewrites files in fifteen
repositories the user is not looking at. Both are unacceptable on the hook path.

So the hook needs a single-root planning entry point. Two constraints on it:

- **One target, one blast radius.** Plan and apply exactly one repository's
  config. A refusal in another project is that project's business; a conflict in
  *this* project aborts *this* repair only, and says so.
- **The whole catalog, still.** Scoping the *target* must not scope the
  *inputs*. `resolveIdentity` calls `matchPin(catalog, …)`, which searches every
  pin by remote, then path, then project name. A single-root planner that
  narrowed the catalog to the matching pin would silently change which pin wins.
  Pass the full catalog; narrow only the write set.

Refusals otherwise carry over unchanged from `planCodexProjectSync`: never a
tracked config, never an unmanaged one, never a symlink, never the user-wide
file.

The property this buys is **convergence**, not correctness-on-first-launch:

**The trigger is a turn, not a launch**, and the promise has to be written in
those terms or it overstates itself. A repair happens on `SessionStart`, which
per §2.3 lands *after* the pet configuration for that session has been read. So
the sequence for any identity change is: launch N reads the old selection and
repairs the file; launch N+1 is the first to benefit.

| | today | converged |
|---|---|---|
| new repository, launch 1 | wrong | wrong (repairs the file) |
| launch 2 onward, no further change | wrong forever | correct |
| pin / theme / remote changed | wrong forever | wrong for one more launch, then correct |
| launches that never take a turn | wrong forever | **wrong forever** |

The last row is not a rounding error. The trigger is the first turn, so a
repository the user opens, looks at, and quits without prompting is never
repaired, however many times they do it.

Stated precisely, the promise is: **on a launch following a successful repair,
the managed file names the resolved member** — conditional on the pet's assets
being valid (§4.4) and on this layer of the precedence chain applying at all
(§4.2). That is materially weaker than "self-healing", and it is what the
ordering actually supports.

The lag must be **documented, not hidden** — the same standard `src/adapters/codex.js`
already holds itself to when it declares `needs-input` and `error` unreachable
rather than inferring them from an unstable format.

Cost on the hook path is one read of a ~120-byte file per `SessionStart`, with
writes only on mismatch. The `git ls-files` and `git rev-parse --git-path`
spawns stay on the write path, so the bounded-hook discipline argued for at
length in `src/bus/identity.js` survives intact.

### 4.2 What convergence does and does not guarantee

Agreement between the resolver and the file Familiar owns is **not** the same as
the pet the user sees. Codex documents this precedence:

> 1. CLI flags and `--config` overrides
> 2. Project config files: `.codex/config.toml`, ordered from the project root
>    down to your current working directory (closest wins; trusted projects only)
> 3. Profile files selected with `--profile profile-name`
> 4. User config: `~/.codex/config.toml`
> 5. System config (if present): `/etc/codex/config.toml` on Unix
> 6. Built-in defaults

Three consequences the design must state rather than gloss:

- **Nested configs win.** Familiar writes at the repository root. A
  `.codex/config.toml` in a subdirectory the user launches from is *closer* and
  supersedes it. That is the user's choice and must be preserved.
- **CLI flags win over everything**, including a correctly converged file.
- **Trust gates the whole layer.** In an untrusted project, layer 2 does not
  apply at all and the repaired file has no effect.

So the guarantee is stated narrowly: *the managed file at the repository root
agrees with the resolver*. Any drift report (§4.5) must report **file
agreement**, and must not claim to report the effective selection unless it
actually resolves the full precedence chain. Reporting the second while
measuring the first is the same class of confident-wrong-answer this whole spec
exists to remove.

### 4.3 An honest fallback for "no project"

The user-wide `[tui] pet` must not name a real member. Slot 0's member is a
specific project's identity, and pointing every unresolved project at it is the
precise failure §2.2 describes — and per §4.2 this layer is what every
unenumerated, untrusted, or not-yet-converged project actually lands on, which
makes it the highest-traffic decision in this spec rather than an afterthought.

The right answer is a theme member that means *no project identity* — visibly a
familiar, visibly not any particular one. That is a `familiar-theme` spec
change, not a config edit: `parseSlots` in `src/theme/pack.js` rejects an empty
slot list outright (`slots is empty — a member holds at least one slot`), and
pack validation requires every one of `SLOT_COUNT` slots to be covered. A
slotless member is currently unrepresentable.

Until that lands, the honest state is **no user-wide `pet` setting at all**:
Codex falls back to its own built-in pet, which is obviously not a familiar and
therefore tells no lie about identity. Applied in §7.

### 4.4 A selection is meaningless without its assets

Selecting `custom:familiar-<member>` presumes `CODEX_HOME/pets/familiar-<member>/`
exists and holds the *current* theme's art. Only `install pets` compiles that,
over `ctx.pack.members`, and **it never prunes**.

The evidence is on the machine now: `~/.codex/pets` holds 25 pet directories for
a 12-member theme. `familiar-cheshire`, `familiar-ginger-tabby`,
`familiar-space-cat` and friends are orphans of a retired roster, still holding
that roster's artwork. So the hook faces two distinct hazards:

- **Absent** — after a theme change, the resolver names a member whose pet
  directory was never compiled. The selection points at nothing.
- **Stale** — a member id reused across themes keeps the *old* theme's art until
  `install pets` runs again. The selection points at the wrong picture, which is
  worse, because it looks like it worked.

Compiling on the hook path is not the answer: it decodes every pose PNG and
builds a 1536×1872 sheet per member, which is exactly the unbounded work
`src/bus/identity.js` argues must never enter a hook.

So **asset installation is a prerequisite, not a step**.

#### 4.4.1 The stamp identifies compiler inputs, not provenance

An earlier draft proposed recording the theme receipt alongside the compiled
pets. **That cannot work**, and the reasons are in `src/theme/receipt.js`:

- A `local` receipt validates as `{ kind: 'local', path }` — **there is no
  commit field at all**. `invalidReason` requires a 40-hex `source.commit` only
  on the `https` branch.
- `readReceipt` returns `{ verdict: 'absent' }` when no receipt file exists, so a
  theme installed by any other route has no provenance to copy.
- Even a valid `https` receipt is **unchanged when the installed artwork is
  edited in place** under `~/.config/familiar/themes/<id>/`. It records where the
  theme came from, not what it currently contains.

Provenance answers "where did this theme come from". The question here is "was
this pet compiled from the bytes that are on disk now", and only content can
answer it. So the stamp is written by `install pets` beside each compiled pet
and records what actually determined the output:

- theme id and member id;
- a content hash over the exact compiler inputs — the member's pose PNGs and the
  animation frames sampled — via `fnv1a32Bytes` (`src/protocol/hash.js`), which
  exists precisely to hash raw PNG bytes without a lossy text round-trip;
- the compiler contract that shaped the sheet: `FRAME` geometry, `motionPolicy`,
  and the member's `anchor`, since a change to any of these invalidates the
  output as surely as new art does;
- a stamp format version, so a future change to any of the above is detectable
  rather than silently mis-compared.

This reintroduces a per-member content hash, which `src/bus/lock.js` records as
deliberately deleted along with the sprite baker. The distinction is where it
runs: that hash was on the **hot path**, inside the transaction lock, on every
tool call. This one runs in an **offline, user-invoked compiler**, and the hook
never computes it.

#### 4.4.2 What the hook checks, and what it does not

The hook must not hash anything. Splitting the question keeps it honest:

- **"Is this pet from the active theme's roster?"** — the hook's job. Read the
  stamp, compare theme id and member id, confirm the sheet exists. Cheap, and it
  catches the *absent* hazard and the theme-swap half of *stale*.
- **"Is this pet's art current with the theme's files?"** — content hashing, so
  it belongs to `install pets` and to any diagnostic verb, never to a hook.

When the hook's check fails it **refuses to rewrite the selection and emits one
diagnostic naming the remedy** (`familiar install pets`). It must not select a
member it cannot draw: a selection pointing at absent or foreign art is worse
than the stale selection it replaced.

#### 4.4.3 Pruning, bounded by proven ownership

`CODEX_HOME/pets` is a **shared directory** — Codex custom pets from any source
live there — and `--out DIR` may name anything at all. So "prune what is not a
member of the active theme" is far too broad: it would delete a user's unrelated
custom pets, and under `--out` it could delete unrelated directories outright.

Deletion is therefore restricted to **proven Familiar-owned output**:

- A directory qualifies only if it carries a valid Familiar stamp (§4.4.1). The
  `familiar-` name prefix is a convention, not proof of ownership, and `pet.json`
  is a file Codex expects any pet to have.
- **Unstamped historical orphans do not qualify** — the 13 currently in
  `~/.codex/pets` predate the stamp and cannot be distinguished from a
  hand-written pet that happens to share the prefix. They are **reported, not
  removed**, with an explicit opt-in flag to clear them once the user has looked
  at the list. Guessing here trades a cosmetic wart for deleting someone's work.
- **Prune only after every member has compiled successfully**, into that same
  output directory. Deleting first and failing halfway leaves the user with
  neither the old pets nor the new ones.

### 4.5 Demote `--sync-projects`

With §4.1 in place, `install pets --sync-projects` stops being the mechanism and
becomes bootstrap (seed a machine) and repair (force agreement now, without
waiting for a launch). Its machine-wide behaviour is correct *there* — an
explicit, user-invoked, foreground command is the right place to touch fifteen
repositories and to abort loudly on an unmanaged file.

It should additionally **report drift**: for every known project config, whether
the baked member still equals the resolved one, subject to the narrowness of
§4.2.

**"Known" is the load-bearing word, and the current enumeration cannot supply
it.** `planCodexProjectSync` walks current path pins plus `cwd`. The moment
`beliefs` lost its pin it left that set, so a drift report run from anywhere else
could not have found its stale config — the report would have been clean while
the bug was live. The claim that this alone would have surfaced the original
incident is **withdrawn**; a project drops out of discovery by exactly the event
that makes it drift.

Discovery needs a source that does not depend on the project still being pinned.
A filesystem scan is not it: the sweep that found these files during the
investigation ran for over two minutes across the whole disk.

So Familiar records the configs it writes — a ledger under
`~/.local/state/familiar/`, beside `agents.json` — and the report covers the
union of the ledger, the current pins, and `cwd`.

The ledger is itself an eager artifact, which is the failure class this entire
spec is about, so it is scoped as a **discovery hint and never a source of
truth**: every entry is verified by reading the file at report time, entries
whose file is gone or is no longer Familiar-managed are dropped, and nothing is
ever reported from the ledger alone. It answers "where should I look", not "what
is there".

## 5. Alternative: stop carrying identity in Codex's pet

Worth recording because it is the philosophically consistent option, not a straw
man — and §2.3's confirmation that convergence-with-lag is a *ceiling* rather
than a temporary limitation strengthens it.

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
of the two primary harnesses, and that is the feature.

**It is also not as cheap as the previous draft claimed.** Setting a neutral pet
user-wide writes to precedence layer 4; every managed `<repo>/.codex/config.toml`
already on disk sits at layer 2 and **outranks it**. On this machine that is 17
project selections that would keep drawing per-project cats — including the stale
ones — while the user-wide setting sat inert underneath. "Never shows the wrong
cat" would be false on exactly the repositories the user works in most.

So this alternative is a migration, not a setting, and it carries two of the same
requirements as the recommendation:

1. **Remove the Familiar-managed project selections first**, using the ledger of
   §4.5 to find them and the managed-header check to prove each is Familiar's to
   remove. Unmanaged and tracked configs stay untouched, as everywhere else.
2. **Install the neutral pet's assets.** A `custom:` pet is still a compiled pet
   directory, so §4.4's prerequisite applies unchanged — and a neutral pet
   selected user-wide is the *most* load-bearing asset on the machine, since
   every unresolved project lands on it.

What the alternative genuinely escapes is the **ordering** problem of §2.3: no
launch lag, because nothing needs to change per project. That is its real
advantage, and it is enough to keep it live if §6.1 resolves negatively — but it
should be argued on that basis rather than on being free.

## 6. Open questions

### 6.1 Can a hook affect the pet in its own session? (Verification, not a hope)

The whole design rests on this, and the answer currently looks like **no**:
Codex 0.153.4's hook reference documents no pre-configuration event, describes
`SessionStart` as running during the agentic loop, and documents no
configuration reload.

The verification must therefore be **behavioural, not existential**. Observing
that some hook fires at launch proves nothing: the hook must either complete
*before* the pet configuration is read, or trigger a supported reload. So the
test is:

1. Start Codex in a repository whose managed config names member A.
2. Have a `SessionStart` hook rewrite that config to member B.
3. Observe **the pet actually displayed in that same session.**

A shows convergence-with-lag is the ceiling (§2.3 stands, §5 gains weight). B
shows hook-time repair is *complete*, first launch included, and the design
simplifies considerably. Anything short of step 3 does not answer the question.

### 6.2 Worktrees do not inherit a parent's pin — and this is not a Codex bug

The first draft asserted that a worktree shares its parent's `projectKey` "and
therefore the member". **That is wrong**, and the counter-example is live on this
machine right now:

```
niri-material                      pin ~/d/niri-material slot 7  -> chartreux
  .worktrees/glass-noise-saturation  no pin match    autoSlot 11 -> odd-eyed-white
  .worktrees/ring-light-design       no pin match    autoSlot 11 -> odd-eyed-white
```

`matchPin` (`src/bus/pins.js`) compares a `path:` pin to `repoRoot` by exact
canonical equality, with no ancestry. A worktree's `repoRoot` is the worktree
directory, so the parent's path pin cannot match it; `project` is the worktree's
basename, so the project-name pin cannot match either; and with no `remote:` pin
the worktree falls through to `autoSlot`. Two further exceptions follow from the
same code: a **project-name pin** matches `basename(repoRoot)`, which differs per
worktree, and a **repository with no remote** has `projectKey = repoRoot`, so
parent and worktree do not even share a key.

Consequences to decide, in order:

1. **Is inheritance wanted at all?** A worktree is a distinct working context and
   a distinct familiar is defensible. What is *not* defensible is the current
   silent inconsistency: a pinned project's root obeys the pin while its
   worktrees obey a hash, so "one project, one familiar" is already false on
   Familiar's own surfaces, with no Codex involved.
2. **If yes**, `matchPin` would resolve `path:` pins by ancestry rather than
   equality — a change to the identity core, affecting every surface, and needing
   its own design and its own task. It is out of scope here (§3).
3. **Either way**, §4.1 must state which files it converges. Per-worktree configs
   multiply the write targets, and today they would converge worktrees to a
   *different* member than their parent — correctly, per the resolver, but
   surprisingly.

## 7. Field repairs applied 2026-09-05

Independent of the design; done to stop the bleeding.

- `beliefs` re-synced: `spectral-cat` -> `tortoiseshell`, matching Claude Code.
- Three pinned projects (`familiar-forge`, `science`, `prism`) that had **no**
  project config — and were therefore falling through to the user-wide default —
  received correct ones. Every other project config was already correct and was
  rewritten identically.
- The user-wide `[tui] pet = "custom:familiar-ginger"` was removed per §4.3.
  Restore by re-adding that line under `[tui]` if the interim proves worse than
  the lie.

Left alone, deliberately: `~/.codex-work`'s stale `familiar-ginger-tabby` (a
separate `CODEX_HOME`, not this investigation's to change), and the 13 orphaned
pet directories in `~/.codex/pets`. Those orphans predate any stamp, so under
§4.4.3 they are exactly the set Familiar may **report but not remove** — it
cannot prove it wrote them. Clearing them stays a deliberate, user-confirmed act;
`familiar-ginger-tabby` is the reason why, since `~/.codex-work` still selects it
and deleting it would break a pet that is in use.

## 8. Revision history

**2026-09-05, after review.** Five defects found, all confirmed against the code
and the machine; two were worse than reported.

| | finding | change |
|---|---|---|
| 1 | §4.1 delegated to a machine-wide planner: an unrelated project's unmanaged config aborts the repair, and a successful repair rewrites every planned config | §4.1 rewritten around a single-root planner that keeps the full catalog for resolution |
| 2 | selecting a member does not install its art; `install pets` never prunes | new §4.4; confirmed by 25 pet directories for a 12-member theme |
| 3 | "does a hook fire at launch" was the wrong question | §6.1 rewritten as a behavioural test; §2.3 now records that Codex 0.153.4 documents no pre-config hook and no reload, making the lag a ceiling |
| 4 | root-file agreement is not the effective selection | new §4.2 with the documented precedence; the guarantee is now stated narrowly |
| 5 | worktrees do not inherit a parent's pin — the first draft claimed they did | §6.2 rewritten around the live `niri-material` counter-example; scoped out as an identity-core defect needing its own task |

**2026-09-05, second review.** Five gaps, all confirmed. Two of the fixes from
the first round were themselves unsound.

| | finding | change |
|---|---|---|
| 1 | "prune what is not a member" would delete unrelated custom pets from the shared `CODEX_HOME/pets`, and arbitrary directories under `--out` | §4.4.3: deletion restricted to directories carrying a valid stamp; unstamped orphans reported with opt-in removal; prune only after a fully successful compile |
| 2 | the theme receipt cannot establish asset freshness — `local` receipts carry no commit, absent receipts are normal, and an `https` receipt is unchanged by in-place art edits | §4.4.1: the stamp hashes compiler *inputs* via `fnv1a32Bytes`, not provenance; §4.4.2 splits the roster check (hook) from the content check (`install pets`) |
| 3 | drift reporting enumerates current pins plus `cwd`, so a project drops out of discovery by exactly the event that makes it drift | §4.5: claim that it would have caught `beliefs` **withdrawn**; a verified-on-read ledger added as a discovery hint, explicitly not a source of truth |
| 4 | the convergence table promised repair a launch earlier than the trigger permits, and ignored launches that never take a turn | §4.1: table restated around turns; promise narrowed to "on a launch following a successful repair", conditional on §4.4 and §4.2 |
| 5 | a neutral user-wide pet is outranked by the 17 managed project configs already on disk, and needs its own assets | §5: rewritten as a migration with two prerequisites; its genuine advantage narrowed to escaping the §2.3 ordering problem |
