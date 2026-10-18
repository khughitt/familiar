# Project colour from tasks

Implemented 2026-10-18; the user accepted both measured latency and the
corrected coloured display on 2026-10-18.

Accepted by the user, 2026-10-17 (round 3). Task: `fam-053b0d`; source:
`docs/notes/2026-10-07-project-identity-brief.md` (scope rerun, 2026-10-17).
Engine baseline: `8019302`. Related: `ops-30b965` (every tool that names a project
shows its one colour), `ops-40f2a6` (assigned the colours).

## Intent

Every registered project now has one authored colour, the top-level `color` key in
its committed `tasks/.config.toml`, and the tasks CLI exposes it in JSON. `tasks`
and `hq` already paint project names in it. Familiar paints everything from its own
twelve-slot table instead, so the same project shows one colour in `tasks` output
and another beside its pet.

The user's direction (2026-10-17): one project colour, used everywhere; the label
and the pet must agree; familiar must not be tightly coupled to whoever assigns the
colours. Chosen approach: familiar optionally reads the colour from its owner,
tasks, through its public JSON. Rejected: ops or tasks generating familiar's pins
(slots carry only twelve hues, the generator would bake familiar's slot table into
ops, and a generated file would collide with the authored catalog); reading
`tasks/.config.toml` directly (couples familiar to a private file format).

The command is `tasks resolve <dir>`, the one tasks documents for tools mapping a
path to its project ("read it there, never from config files"). It reports the
registered project's colour, which is the colour tasks paints its own output in.
`tasks where`, named when the task was scoped, was rejected at design: it reads the
`tasks/.config.toml` checked out in the directory, so a worktree whose branch
predates its project's colour commit reports no colour (builder check, below).

## Goals

- For a registered project with a colour, the HUD's project label is that exact
  colour, the pet is the slot whose hue is nearest to it, and the rest of the
  chrome (rule, branch, context bar, state, terminal backdrop and cursor, niri
  accent) takes the project's hue.
- One rule decides, everywhere the identity is shown: hooks, status line, reap,
  `whoami`, `projects`, and the Codex pet selection.
- Unregistered directories, projects without a colour, and hosts without `tasks`
  behave exactly as today.
- No additional steady-state `tasks` spawn; measured hook overhead accepted
  by the user on 2026-10-18 (§7).

## Non-goals

- Tinting sprites. A pet is per-member art; with 33 projects over 12 slots, the
  pet matches its project's colour by family, not exactly.
- Discovering projects from tasks. `projects` with no arguments still lists path
  pins only (`fam-60d716` was dropped: familiar needs the colour, not a registry).
- Changing the colours, the slot table, the hash, or the pin catalog's location.
- A switch to turn the feature off. Removing `tasks` from the hook's `PATH`, or
  removing the project's `color`, already does.

## Anti-goals

- A label in the project colour beside a pet of a different family.
- A tasks failure silently replaced by the slot colour.
- Familiar knowing how tasks stores colours, or ops knowing familiar's slots.

## Evidence

Measured on this host, 2026-10-17, `tasks` 0.4.0:

- `tasks resolve <dir>` takes about 8 ms and prints
  `{"results":[{"status":…,"prefix":…,"color":"#rrggbb",…}],"warnings":[…]}`,
  exit 0. A registered root, any of its Git worktrees, and a linked project's code
  checkout (`via: checkout`) are `resolved` with the registered colour; an
  unregistered or missing directory is `unregistered`. `color` is omitted when the
  project sets none (the retired `mind3`) or when tasks could not read that
  project's config, which tasks reports as a warning naming the prefix.
- `tasks where <dir>` does not: on this host, 38 of the 49 linked worktrees of
  registered projects resolve to their project with no colour, because their
  branches predate the colour commit
  (`crew/.worktrees/core-design`, `dotfiles/.worktrees/dots-0e0cc5`, seven
  `niri-material` worktrees); `tasks resolve` gives each its project's colour.
- `tasks resolve` reads every registered project's config to build its index; a
  project whose config fails adds a warning and does not fail the command, so
  one broken project cannot break another's colour.
- A linked project whose config fails (an invalid `color`, say) is left out of
  the index entirely, so its code checkout resolves `unregistered`, not
  `resolved`; the only sign is the warning `<prefix>: its checkout is not matched
  and its color is not reported (…)` (reproduced at spec review, round 2). A
  colourless answer can therefore hide a configuration failure whatever its
  status.
- Of the 13 slot pins whose path resolves to a registered project, all 13 already
  name the slot the mapping below derives from that project's colour. The other 7
  pins name unregistered directories and are unaffected. `ops-40f2a6` kept pinned
  projects' colours within 18° of their slot, which is why they agree.
- Unpinned registered projects get a new pet: 19 of the 33 change slot (table at
  the end). That is the intended outcome, not a regression.

## Design

### 1. Reading the colour

A new module (my call: `src/bus/project-color.js`) exports one function that takes
a directory and returns `{ prefix, color, warnings }`: `prefix` is the project's or
`null`, `color` is `'#rrggbb'` or `null`, and `warnings` is the list to pass on.

- Spawn `tasks resolve <dir>` with `execFile`, bounded like Git discovery: a 2 s
  timeout and `SIGKILL` (its own named constant; the Git one stays Git's).
- Spawn fails with `ENOENT`: tasks is not installed. Prefix and colour `null`, no
  warnings.
- Exit 0 with exactly one row whose `status` is `unregistered`: prefix and colour
  `null`.
- Exit 0 with exactly one `resolved` row: its `prefix` and its `color`, which must
  match `^#[0-9a-f]{6}$` when present; absent means `null`.
- Anything else is an error that names the directory and what came back: a
  non-zero exit, a timeout, output that is not JSON, a row count other than one,
  any other `status` (`ambiguous`, `invalid`), or a `color` in another form.
- **Warnings: forwarded whenever no colour is returned**, for an `unregistered` row
  as much as a colourless `resolved` one, because either can be a project whose
  config tasks could not read (Evidence, last bullet). The caller writes each to
  stderr as one `familiar: tasks: <warning>` line. When a colour is returned, the
  warnings are dropped: they can be about any registered project, and this one's
  answer is complete. Familiar never parses their text.

A colourless answer is still cached on the record (§2), so its warnings are
written on the event that spawned `tasks`, not on every event after it.

Which directory: the checkout root (`repoRoot`). Outside a Git repository there is
no project colour and no spawn (my call: every registered project is a Git
checkout, and a first event outside any repository then costs nothing extra).
`tasks resolve` itself maps a worktree, wherever it is stored, and a linked
project's code checkout to the registered project.

### 2. Carrying it on the bus record

The hook transaction (`src/bus/transaction.js`) adds `projectColor` (`'#rrggbb'`
or `null`) to the agent record, beside `repoRoot`. It is resolved outside the bus
lock, after `gitContext`, as Git is:

- Read `agents.json` without the lock (writes are atomic renames, so the read is a
  consistent snapshot). If this session's record has the same `repoRoot` and its
  own `projectColor` property, reuse that value, `null` included. Otherwise spawn.
- A session therefore pays the spawn on its first event and when its checkout
  changes, never in steady state. A colour edited in tasks reaches a running
  session at its next checkout change or its next session (documented, accepted).
- A race with a concurrent hook of the same session can only cause a redundant
  spawn, never a wrong colour.
- A `SessionEnd` (level `null`) spawns nothing, as Git discovery is skipped today.
- A tasks error is thrown like a Git timeout: the boundary prints one stderr line,
  exits 0, and writes nothing.

The status line and reap read records and never spawn `tasks`.

A record written before this change lacks `projectColor`. Following the
`repositoryRoot` precedent, `resolveIdentities` faults it ("session record lacks
projectColor; wait for its next hook"): it is evicted and its next hook rewrites
it. The value is never guessed.

### 3. Colour to slot

A pure function beside the slot table (`src/protocol/slot-hues.js`, engine
policy), my call on its exact name, `slotForColor(hex)`:

1. Grey first: if the colour's OKLCH chroma is below 0.05, the slot is 11.
2. Otherwise the slot among 0–10 whose `hue` (the table's own HSL hue) is nearest
   the colour's HSL hue on the circle; a tie goes to the lower slot.

Why these spaces: the slots are defined by HSL hue, so nearest-hue is measured
where they live, and that reproduces every current pin (OKLCH hue would move
`tasks` to slot 1, beside `ops`). HSL saturation misjudges dark and light colours,
so greyness uses OKLCH chroma: the three projects pinned grey measure 0.031–0.040,
and the most muted chromatic colour 0.070. Both thresholds are frozen with the
table; changing either reassigns pets.

### 4. Slot rule and pins

`resolveIdentity` (`src/bus/resolve.js`) takes `projectColor` as a required input
(`undefined` throws, so no caller can forget it) and decides:

| Project colour | Matching pin | Slot | Source |
| --- | --- | --- | --- |
| present | none | `slotForColor(colour)` | `colour` |
| present | slot agrees | that slot | `colour` |
| present | slot differs | fault | — |
| `null` | present | the pin's slot | `pin` |
| `null` | none | `autoSlot(projectKey)` | `auto` |

The fault message names both: "pin declares slot 4, but project colour #317d01
(from tasks) maps to slot 3: remove the pin or change the project's colour". It
behaves like today's member/slot conflict: the incoming record aborts its hook,
and a pre-existing one is evicted.

A pin's `members` still chooses the character within the decided slot, and the
existing member/slot check still applies. Pins keep their whole meaning for
unregistered directories and tasks-less hosts. The pin parser does not change:
`slot` stays required.

Why strict: the colour is the single source. Ignoring a disagreeing pin would be a
silent override of an authored choice; letting the pin win would put a label of
one family beside a pet of another, the anti-goal. Today the strict rule costs
nothing, since every pin on a registered project agrees.

The identity gains `projectColor`; `source` is reported by the CLI (§6), my call
whether it rides the identity or is derived where printed.

### 5. Colours

`identityColors` (`src/theme/ramp.js`) takes the identity rather than the bare
slot, and returns the existing five stops plus a sixth, `project`, the colour of
the project name:

- With a project colour: `ramp(hue of the colour, sat of the decided slot, tone)`,
  and `project` is the colour itself, exact and tone-independent (`ops-40f2a6`
  chose every colour to read at 3:1 on dark and light backgrounds).
- Without: `ramp(slot hue, slot sat, tone)` as today, and `project` is the `light`
  stop, which is what the label uses today.

Why the slot's saturation and not the colour's: several project colours are dark
and saturated (`ns #317d01`, HSL saturation 98), and a ramp at the colour's own
saturation turns them neon at familiar's lightness anchors (`#7cfd2a`). Hue from
the project and saturation and lightness from familiar and the scheme is the
ramp's existing rule ("an identity owns a hue; the scheme owns tone"); the label
carries the exact colour. Shown with the slot ramp beside it, dark tone:

| Project | Label | Chrome base, colour's own saturation | Chrome base, slot saturation | Slot ramp base today |
| --- | --- | --- | --- | --- |
| ns | `#317d01` | `#7cfd2a` | `#8bbd6b` | `#8dbd6b` |
| ops | `#8d6803` | `#fbc42d` | `#d2b156` | `#d2a956` |
| lit | `#786cfe` | `#3c2afe` | `#6c64c4` | `#7164c4` |
| fam | `#bc8369` | `#bd856b` | `#d67b51` | `#d68251` |

The HUD (`src/render/term/hud.js`) paints the project name with `color.project`
instead of `color.light`. Every other consumer (`emit.js` backdrop and cursor,
niri accent, opencode) reads the stops it reads today. `theme show` and
`theme sheet` keep painting slot colours: they show slots, not projects.

### 6. Entry points

- **Hooks**: §2. The Codex convergence on `SessionStart` takes the member from the
  intent it just resolved, so it follows without change.
- **Status line and reap**: read `projectColor` from the record.
- **`whoami`**: resolves the colour for the checkout it inspects (one spawn). Text
  output adds a line, `colour  #bc8369 · fam` when there is one; JSON adds `color`
  (hex or `null`) and `source` (`colour`, `pin` or `auto`). `slot` and `hue` keep
  meaning the slot's.
- **`projects`**: one spawn per directory. A row with a project colour shows that
  colour as its swatch; a row without keeps today's `base` swatch. The caption's
  `pin`/`auto` becomes the source above; JSON `projects[]` adds `color`, and
  `source` gains `colour`.
- **`install pets --sync-projects`**: `planCodexProjectForPath` resolves the colour
  for each target root, so the Codex pet it selects is the one hooks would.

Every entry point that spawns `tasks` (the hook, `whoami`, `projects`, the Codex
sync) writes the forwarded warnings to stderr as §1 says; JSON output on stdout
stays unchanged by them.

### 7. Latency

The hook adds no `tasks` spawn once this session carries the colour for its
current checkout. The benchmark's instrumented `execFile` requires exactly one
candidate lookup on the first event per context in the sitting and none on any
later event, including later batches; the baseline spawns no `tasks`. Both
versions make two Git spawns on a main checkout and three on a linked one.

The two full paired comparisons against `8019302` passed these structural
checks. Main-checkout paired median increases were **+1.664 ms** and
**+2.264 ms** (about **1–2%**); linked results and p95 tails varied between
sittings. Both reports, the disturbed same-code control and bounded component
profile remain attached to `fam-1b0712` or recorded in its implementation report.
On **2026-10-18 the user accepted this measured overhead**, revising the original
no-measurable-slowdown goal. This acceptance preserves the observed timing
result; the no-additional-steady-state-lookup requirement remains in force.
Twenty real `tasks resolve` runs measured a first-lookup median of **6.155 ms**
(p95 **7.801 ms**), separately from the benchmark's fixture spawn cost.

## Tests

Registered (colour → slot, ramp, exact label), unregistered, colour-less project,
and the warning rule: warnings forwarded for an `unregistered` row and a colourless
`resolved` row, dropped when a colour is returned, and the linked checkout whose
project config fails (an `unregistered` row with that project's warning: colour
`null`, warning on stderr, hook still written); tasks absent (`ENOENT`), and tasks failure
(non-zero exit, timeout, malformed JSON, row count, `ambiguous` and `invalid`
status, malformed colour) paths; the command spawned is `tasks resolve` with the
checkout root; the slot table rules (grey cut, tie, wrap at 0°/360°,
and the current 33 colours against the table at the end); pin agree, pin disagree,
and member-within-slot; carry-forward (no spawn on a same-checkout event, a spawn
after a checkout change, `null` carried); the old-record fault; `whoami` and
`projects` text and JSON; Codex sync choosing the colour's pet.

The suite must not depend on the host's tasks install or registry: unit tests
inject the spawn, and CLI tests run with a stub `tasks` on a controlled `PATH`
(or none). CI has no `tasks`.

## Documentation

`docs/install.md`'s identity section: where a project's colour comes from, the
slot rule, what a pin means for a registered project, the fault, and that a colour
change reaches running sessions at their next checkout change. `README.md` if it
describes how a colour is chosen. On completion, note `ops-30b965`.

## Builder check

A fresh reader planned from the first draft and raised one question: the draft
read the colour with `tasks where`, which reports a worktree's checked-out config
rather than the registered one. Reproduced on this host and settled from the
project's own contract by switching to `tasks resolve` (§1); it does not reopen
the coupling choice, since both are tasks' public JSON. Its smaller points are
folded in: the reader returns the prefix `whoami` prints, colourless `projects`
rows keep the `base` swatch, and the benchmark's spawn expectations need updating.
It reproduced both tables and the 13 agreeing pins independently.

User review, round 2, one must-fix: the draft dropped warnings on `unregistered`
rows, but a linked checkout whose project config fails resolves `unregistered`
with only a warning, so a configuration failure would silently turn into slot
colours. Warnings are now forwarded whenever no colour is returned (§1), and the
tests cover that linked case.

## Left to the builder

Module and function names marked as my call; how `source` travels; the bench
report's shape for the first-event cost; plan order.

## Appendix: today's pet and the colour's pet

Today's slot is `familiar whoami` at each project's tasks root (a linked project's
root is its overlay directory, so `nexc` shows its hash there and slot 6 in its
pinned code checkout). Δ is the HSL hue distance to the derived slot.

| Project | Colour | Today | From colour | Δ |
| --- | --- | --- | --- | --- |
| atoms | `#7995cd` | 6 seal-point | 6 seal-point | 8 |
| autonomy | `#d2647a` | 6 seal-point | 10 persian | 2 |
| beliefs | `#0ba880` | 5 spectral-cat | 5 spectral-cat | 7 |
| crew | `#70882e` | 9 tuxedo | 3 impostor | 19 |
| dots | `#776558` | 11 odd-eyed-white | 11 odd-eyed-white | grey |
| fam | `#bc8369` | 0 ginger | 0 ginger | 3 |
| flows | `#db49af` | 4 meerkat | 9 tuxedo | 13 |
| forge | `#cf6305` | 0 ginger | 0 ginger | 6 |
| glean | `#993ec8` | 0 ginger | 8 arcane-cat | 8 |
| hq | `#2f9fb1` | 5 spectral-cat | 5 spectral-cat | 16 |
| lit | `#786cfe` | 0 ginger | 7 chartreux | 3 |
| lore | `#a95479` | 0 ginger | 10 persian | 16 |
| material | `#d063e5` | 9 tuxedo | 9 tuxedo | 15 |
| mind6 | `#947782` | 11 odd-eyed-white | 11 odd-eyed-white | grey |
| mm | `#d72633` | 7 chartreux | 10 persian | 6 |
| nexc | `#058dfa` | 1 maine-coon | 6 seal-point | 5 |
| nexp | `#c72583` | 1 maine-coon | 9 tuxedo | 20 |
| nodes | `#859982` | 11 odd-eyed-white | 11 odd-eyed-white | grey |
| nrp | `#72638f` | 9 tuxedo | 8 arcane-cat | 12 |
| ns | `#317d01` | 2 tortoiseshell | 3 impostor | 2 |
| obs | `#9e83eb` | 7 chartreux | 7 chartreux | 8 |
| ops | `#8d6803` | 1 maine-coon | 1 maine-coon | 4 |
| prism | `#6671c6` | 7 chartreux | 7 chartreux | 15 |
| quarry | `#0b6eae` | 7 chartreux | 6 seal-point | 8 |
| rad | `#2cab36` | 3 impostor | 4 meerkat | 10 |
| relay | `#9c65bc` | 4 meerkat | 8 arcane-cat | 6 |
| sci | `#25786d` | 5 spectral-cat | 5 spectral-cat | 0 |
| sun | `#ff5e4a` | 2 tortoiseshell | 0 ginger | 15 |
| tasks | `#aa8c0e` | 2 tortoiseshell | 2 tortoiseshell | 7 |
| trans | `#a8523a` | 10 persian | 0 ginger | 9 |
| tui | `#2f63e1` | 8 arcane-cat | 6 seal-point | 10 |
| vdocs | `#fd538f` | 11 odd-eyed-white | 10 persian | 11 |
| wali | `#b780ad` | 4 meerkat | 9 tuxedo | 6 |
