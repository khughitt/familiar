# Install

Familiar requires Node.js 22 or newer and Git 2.31 or newer. Themes install
separately; this engine ships no art.

## Shared setup (macOS and Linux)

Install a checkout and choose a scheme and theme:

```sh
git clone https://github.com/khughitt/familiar.git
cd familiar
npm install
npm link
familiar scheme set dark
familiar theme add <theme-url-or-directory>
```

`familiar theme add` accepts a public HTTPS repository or a local theme
directory, such as your working checkout. It installs only the pack itself
(`theme.yaml`, licence files, and each member's sprite directory), validates
exactly those files, and atomically installs them into
`~/.config/familiar/themes/<id>`. Anything else in the checkout (tool
workspaces, docs, build output) is left behind. A theme that is already installed
refuses a second `theme add`; see [Replacing and removing
themes](#replacing-and-removing-themes).

macOS agent lifecycle is supported. The portable core is CI-backed, and the
Darwin agent resolver was activated on live-hook evidence captured on a physical
Mac on 2026-08-23 (`docs/ref/2026-08-23-macos-agent-process-spike.md`), covering
Claude Code, Codex, and OpenCode in both Kitty and Ghostty.

Familiar's own terminal rendering — graphics, tint, and bell — is confirmed for
**Claude Code and Codex** in Kitty 0.46.2 and Ghostty 1.3.1 on macOS 26.6.2, under
Node 22 and Node 25, by a byte-level physical-Mac gate run 2026-08-24 to 2026-08-28
(`docs/ref/2026-08-24-macos-terminal-smoke.md`). That claim covers exactly those
terminal and agent versions. **The OpenCode sprite renderer remains provisional**:
the same gate exercised it and found the sprite never changes pose. tmux is supported
inside Kitty and Ghostty with the limits in `docs/surfaces.md` (full-width panes on tmux
≤ 3.7c; status-line colour depth; multiple attached clients with different outer
terminals are not addressed). Intel Macs, macOS 13, and other terminals stay unclaimed.

### Replacing and removing themes

```sh
familiar theme add --replace <theme-url-or-directory>   # install a new copy over an installed theme
familiar theme remove <id>                              # remove an installed theme and its receipt
```

`theme remove` deletes the pack under `~/.config/familiar/themes/<id>` and its install
receipt under `~/.config/familiar/theme-receipts/<id>.json`, whichever exist. It
refuses a pack directory that is a symlink, and a shipped theme, which is not
removable. Removing a user theme that shadows a shipped one brings the shipped one
back. A theme that config still names faults wherever it is drawn until config names
another or it is installed again.

`theme add --replace` validates the new copy first, then moves the installed pack
and receipt into a backup directory,
`~/.config/familiar/themes/.replace-backup/<id>-<instant>/`, as `pack/` and
`receipt.json`. It installs the new pack, writes its receipt, and only then deletes
the backup. If the install fails after the old theme was moved aside, the new copy
is removed and the old pack and receipt are moved back; the error names the cause.
`theme add` and `theme remove` share one lock, so neither runs while another is
under way.

#### Rolling back from a surviving backup

If moving the old theme back fails too, the backup stays where it is and nothing
deletes it: not a later `theme add`, whose staging sweep never reaches it, nor
`theme remove`. `theme list` names it as `replacement backup of '<id>' at <path> —
restore or remove it`. The error names it too, together with the moves still to make:

```text
theme add: replacing '<id>' failed (<cause>) and restoring it failed (<error>) — the
previous theme is kept at <path>: move its pack to <themes>/<id> and its receipt.json
to <theme-receipts>/<id>.json, or remove it
```

It names only the entries still in the backup. If the old pack already went back and
only its receipt did not, it names only `receipt.json`, and `themes/<id>` then holds
the old pack: leave that directory alone. Make exactly the moves it names. The
commands below make the same moves, each only when the backup still holds that entry:

```sh
B=~/.config/familiar/themes/.replace-backup/<id>-<instant>   # the path theme list names
ls -A "$B"                                                   # pack, receipt.json, or both
if [ -e "$B/pack" ]; then
  # The old pack is still in the backup, so anything at themes/<id> is what is left of
  # the new copy (usually nothing: a failed replace removes it first). Remove that
  # leftover, then move the old pack back.
  rm -rf ~/.config/familiar/themes/<id>
  mv "$B/pack" ~/.config/familiar/themes/<id>
fi
if [ -e "$B/receipt.json" ]; then
  mv "$B/receipt.json" ~/.config/familiar/theme-receipts/<id>.json
fi
rmdir "$B"
familiar theme list                                          # the theme is back, the notice gone
```

To keep neither, delete the backup (`rm -r "$B"`) and install the theme you want.

Two other errors leave a backup directory that is not a rollback:

- `theme add: <cause> — theme '<id>' is restored as it was, but its backup directory
  <path> could not be removed (<error>); remove it`. The old theme is back in place,
  and the backup no longer holds any of it: `rm -r "$B"`.
- `theme '<id>' installed; could not remove the replacement backup at <path>: <error>`.
  The replacement worked, and the backup holds the theme it replaced. Delete it
  (`rm -r "$B"`) unless you want that theme back. To go back, `theme add --replace`
  its source rather than following the steps above: those steps would leave the new
  receipt in place when the old theme had none.

With `FAMILIAR_CONFIG_DIR` set, every `~/.config/familiar` above is that directory.

### Relay observers and lifecycle hooks (operator cutover)

Familiar consumes relay's registry as an observer. Relay owns lifecycle hooks,
process admission, and the agent registry; Familiar owns presentation state.
The steps below change harness configuration and are the **operator cutover**,
tracked separately as `hq-539508`. Updating this checkout does not perform them.

Before upgrading in place or editing configuration, retain a complete, working
pre-migration Familiar checkout at a stable absolute path, including its installed
dependencies. Install the new revision in a different checkout. Keep the old
`bin/familiar` (which still accepts `hook`), `integrations/opencode/plugin.js`,
its imported modules, and sprite renderer available until cutover is accepted.
An old hook command pointing at the new CLI, or a restored plugin entry pointing
at a deleted file, is **not** a working rollback.

While harnesses are stopped, ensure all old Familiar hook commands, Claude
`statusLine`, OpenCode server/TUI plugin entries and Familiar service/launcher
references resolve into that retained checkout. If the original checkout was
already upgraded, first recover the previous revision and its dependencies into
a separate checkout and change those references to its absolute paths. Inspect
commands and imported plugin files there before recording the rollback baseline.
Do not delete old Familiar state during this cutover.

Create a fresh private backup directory (replace the example path):

```sh
FAMILIAR_NEW=/absolute/path/to/new/familiar/bin/familiar
CUTOVER_BACKUP=/absolute/path/to/retained-cutover-backup
mkdir -m 700 "$CUTOVER_BACKUP"
```

The cutover commands below invoke the new checkout explicitly, so they do not
depend on which version a shared launcher selects. Keep the backup directory,
old checkout, and relay's artifacts for the whole rollback window. Before each configuration edit, save its exact bytes, permissions, and
whether it existed; save the result after each edit too. This includes relay's
subscribers file and any launcher/service changes. Restoring an absent file means
removing only the file created by that operation. Stop on unexpected drift rather
than overwrite later edits. The examples below assume existing plain JSON harness
files; JSONC/manual edits need the same before/after snapshots of the actual files.

Install relay and follow its [hook installation and rollback guide](https://github.com/khughitt/relay/blob/main/docs/runbooks/hook-install-rollback.md),
including the platform evidence gates. Make the relay CLI available on `PATH`
from that installation. Generate Familiar's observer document:

```sh
"$FAMILIAR_NEW" setup relay
```

Review stdout and merge its `subscribers` entries into relay's
`~/.config/relay/subscribers.json`, retaining other subscribers and one top-level
`schema: 1`. For a fresh file, save the complete document. The command only prints
JSON. Keep the parent directory privately owned with mode 0700 and the file mode
0600. Every installer invocation below names that file explicitly; use its
absolute path if you keep it elsewhere. OpenCode's server plugin reads relay's
default subscribers file at runtime: if `XDG_CONFIG_HOME` is set, use
`$XDG_CONFIG_HOME/relay/subscribers.json` consistently and keep the same environment
when starting OpenCode.

Relay's installer plans by default. Inspect the JSON plan, then repeat the same
arguments with `--apply --artifact <file>` to write the configuration and save a
rollback artifact. Keep that artifact; `relay rollback --artifact <file>` restores
the recorded preimages only while each target still matches its saved before or
after bytes. Later edits to the same file must be reversed first. Relay's artifact
covers only relay's changes, not Familiar's installer, status line, subscribers,
launchers, or services. Follow the coordinated rollback below. The apply command
recomputes the plan from the current configuration, so inspect a fresh plan if anything changed after review. For
hook commands, relay records the Node executable used by its installer; use its
`--node /absolute/stable/node` option when that executable would otherwise live
under a version manager. Existing guard subscribers may require `--evidence`;
follow relay's guide rather than removing them to make installation pass.

### Claude Code

Familiar's Claude Code settings fragment now carries only its status line:

```sh
"$FAMILIAR_NEW" setup claude-code
```

Save the baseline before merging stdout into `~/.claude/settings.json`; save
that merged result before relay's edit. Then plan and apply relay's hooks,
retiring Familiar's old hook entries:

```sh
cp -p "$HOME/.claude/settings.json" "$CUTOVER_BACKUP/claude.before-familiar"
# Merge the reviewed statusLine fragment now, then:
cp -p "$HOME/.claude/settings.json" "$CUTOVER_BACKUP/claude.after-familiar"
relay install --harness claude-code --subscribers "$HOME/.config/relay/subscribers.json" \
  --target "$HOME/.claude/settings.json" --retire familiar --json
# After reviewing the plan:
relay install --harness claude-code --subscribers "$HOME/.config/relay/subscribers.json" \
  --target "$HOME/.claude/settings.json" --retire familiar \
  --apply --artifact "$CUTOVER_BACKUP/claude-code-install.json"
```

### Codex lifecycle hooks

Plan and apply relay's Codex hooks instead of generating Familiar hooks:

```sh
relay install --harness codex --subscribers "$HOME/.config/relay/subscribers.json" \
  --target "$HOME/.codex/hooks.json" --retire familiar --json
# After reviewing the plan:
relay install --harness codex --subscribers "$HOME/.config/relay/subscribers.json" \
  --target "$HOME/.codex/hooks.json" --retire familiar \
  --apply --artifact "$CUTOVER_BACKUP/codex-install.json"
```

The hook targets must already contain valid configuration; for a fresh target,
create its parent directory and an empty JSON object before planning. Codex asks
for a one-time trust confirmation before it runs hooks. Codex draws its own pet,
so it has no status line entry — see Codex pets below for the art.

When hooks run under Codex's shared app-server daemon (observed with Codex
0.160.1), launch the TUI with `codex --no-daemon`. The daemon has no owning
session terminal in its ancestor chain, so Familiar's observer cannot attribute
terminal presentation or converge the project's pet selection. Disabling daemon
auto-start alone does not detach a TUI from an already-running daemon.

This launch requirement applies to Familiar's presentation and automatic project
selection. Codex's native pet renderer works independently, using the installed
art and `[tui] pet` setting described [below](#codex-pets).

### Moving a host to spec-version 2 themes

A theme pack at spec-version 1 (members declare `slot` or `slots`, no `roles`) is
refused by a build that reads spec-version 2, and every session on the host faults on
it until the pack is replaced. A spec-version 2 pack declares `roles:` on its members
with exactly one `default` holder. Run these per host, in order; each host's owner runs
them, and the window between steps 1 and 2 is the time it takes to type them.

1. Install the new familiar build (`npm install` and `npm link` in the checkout).
2. Note each installed v1 theme's `source.url` and `source.commit` from
   `~/.config/familiar/theme-receipts/<id>.json` (a rollback needs them; a local-path
   source records `source.path` instead), then replace it from its spec-version 2 source:

   ```sh
   familiar theme add --replace <theme-url-or-directory>
   ```

3. Check the result. The member of the default role shows with source `default`:

   ```sh
   familiar whoami
   ```

4. If any pet is compiled for Codex, recompile and re-select:
   `familiar install pets --sync-projects`. It refuses each repository whose managed
   `.codex/config.toml` still names a single-theme pet id, naming the file; remove those
   as [Single-theme pet ids](#codex-pets) describes, then run the command again.
5. Records written by the previous build lack `family` and `role`. They fault once and
   each session's next hook rewrites its record. Pins and `identities.yaml` are untouched.

**Rolling back.** The new build refuses spec-version 1 packs, so the theme goes back only
after familiar does. Install the previous build, which has no `theme remove`, then
delete both paths by hand and add the old pack at the commit noted in step 2. The first
path is the installed spec-version 2 pack of the theme being rolled back:

```sh
rm -rf ~/.config/familiar/themes/<id> ~/.config/familiar/theme-receipts/<id>.json
familiar theme add <the v1 source, at the commit noted in step 2>
```

If a `theme add --replace` left a backup, follow [Rolling back from a surviving
backup](#rolling-back-from-a-surviving-backup) before this.

Codex: the previous build recognises a managed `.codex/config.toml` by a `pet` value of
`custom:familiar-` followed by letters, digits and hyphens, so it treats a per-theme
selection (`custom:familiar-<theme>--<member>`) as its own and rewrites it. Run the
previous build's `familiar install pets --sync-projects` to write single-theme
selections; its pets must be compiled, so run `familiar install pets` there first if
the `~/.codex/pets/familiar-<member>` directories were deleted. If it refuses a file
(`refusing unmanaged project config <path>`), that file is not one of Familiar's three
managed lines and stays yours.

Session records: the previous build's `sessions.json` validator (under the familiar state
directory) checks the keys it knows and ignores others, so records carrying `family`,
`role` and `admitted` are read as they are and need no step.

## Project identity and Git worktrees

A registered project's colour chooses its familiar as described below. Without
a project colour, a hash of the project's identity chooses its familiar;
`~/.config/familiar/identities.yaml` pins one deliberately by `remote:`, `path:`
or `project:` (basename). A Git worktree follows its repository: a pin on the main checkout applies to every
worktree of it, including one stored outside the checkout or reached through a
symlink, while an unrelated repository nested inside it never inherits. The
pin that wins is the first matching entry of the first tier that matches:

1. the effective `remote:` (normalized origin) of the checkout you are in;
2. `path:` of the current checkout;
3. `path:` of the repository's main checkout;
4. `project:` naming the current checkout's directory;
5. `project:` naming the main checkout's directory;
6. otherwise, the hash.

A matching `remote:` pin already covers every worktree and wins over any path
pin. To give one worktree its own familiar, pin that worktree by path; a
`project:` pin never beats a path. The winning pin is the whole choice: its slot
and its `members:` map.

- **Labels and keys.** A worktree keeps its own directory name as its label, so
  several working contexts stay distinguishable. Without a remote, the hash key
  is the main checkout's path, so a repository and its worktrees share one
  automatic familiar; moving or renaming a worktree does not change it.
- **Bare repositories.** A worktree of a bare repository takes the bare
  directory as its repository. Its name is kept verbatim (`familiar.git`
  matches `project: familiar.git`, not `project: familiar`), and a bare
  directory named just `.git` contributes no repository name.
- **Separated Git metadata.** A main checkout whose metadata lives elsewhere
  (`git init --separate-git-dir`) works as is. Its worktrees need the real main
  checkout declared with `git config core.worktree <main checkout>`; until then
  every hook that discovers identity reports an error naming `core.worktree`
  (session-end hooks skip discovery). Metadata stored in a directory named
  `.git` elsewhere, as in `store/.git`, looks to Git like a repository at
  `store` and is not always detectable: declare `core.worktree` there too.
- **After upgrading.** Records from before the identity upgrades may lack a
  repository anchor, `projectColor`, `family` or `role`. They leave the bus until each session's
  next hook re-admits it; a status line may show no identity until then. Pins
  are untouched.

### Family, role and world

A family is a named set of projects. A project declares its family in a family file at
its registered root (the `root` that `tasks resolve` returns, so a worktree whose branch
predates the file still has the family): `tools/family.toml`, else `family.toml`, the
first that exists. Familiar reads one key, `name`, an id (lowercase letters and digits
joined by single hyphens). A project with no family file has no family. A file that
cannot be parsed, a `name` that is not an id, a file over 65536 bytes, or a symlink or
path that leaves the root is an error: the hook prints one line and writes nothing.
The family is read once per session and checkout, with the colour.

The family selects the theme. `config.yaml` names the default theme and maps families to
themes:

```yaml
theme: cats
families:
  guild: cats
  verifiably: plant-nooks
motion: full
```

A family named under `families:` uses the theme it names; an unnamed family, or a
project with no family, uses `theme:`. Config is not checked against the installed
themes: a named theme that is not installed faults for that family's projects only.
A pin's `members:` map is keyed by theme id, so a pin applies to whichever theme the
family resolves to, and an entry for another theme is inert.

The theme's cast then gives the member. A member declares `roles:` in the pack, and one
member holds the reserved role `default`. A session's role is the environment variable
`FAMILIAR_ROLE`, an id, set by whatever launches the agent
(`FAMILIAR_ROLE=reviewer claude`); unset or empty means no role. An invalid value, or
`default` itself, is a refused event: the observer prints one error line, exits 0 and
writes nothing, so the session keeps its previous record. The member is:

| role | the theme holds the role | pin names a member of this theme | member | source shown |
| --- | --- | --- | --- | --- |
| none | not applicable | no | the `default` holder | `default` |
| none | not applicable | yes | the pinned member | `pin` |
| set | yes | either | the role's member | `role` |
| set | no | no | the `default` holder | `unmapped` |
| set | no | yes | the pinned member | `pin` |

A pin replaces the `default` holder for its project and never overrides a role the theme
covers. A role the theme does not cover is not a fault; `familiar whoami` shows
`unmapped` so a theme author sees which roles the cast lacks. The hue is the project's,
as in [Project colour](#project-colour); roles never change it.

```text
$ FAMILIAR_ROLE=reviewer familiar whoami
<project>
  family  guild · theme cats (family)
  role    reviewer · member <label> (role)
```

`family` shows `—` when there is none and `role` shows `—` when unset. A theme may
also carry a world: a background per locale, with places where members stand. Every
session shows the `home` locale. `familiar theme validate <dir>` prints a theme's roles
and the default member, and its world's locales with their place counts (or
`world none`). The identity in `intent.json` carries the family, theme, role, member
source and, when the theme has a world, the locale image and its places.

### Project colour

A registered project's colour comes from `tasks resolve`, so every Git worktree
shows the registered colour. The project label uses that exact colour, the
chrome uses its hue, and the pet uses the nearest hue slot (greys use the grey
familiar). A matching pin on a registered project with a colour must name that
slot; a conflict is an error naming both the pinned slot and the colour's slot.

Unregistered checkouts, projects without a colour, and hosts without `tasks`
(or with `tasks` off the hook's `PATH`) keep pins and the hash. When tasks
returns no colour, its warnings appear as `familiar: tasks:` lines. Familiar
reads the colour once per session and checkout: an edit in tasks reaches a
running session at its next checkout change or next session.
Use `familiar --color auto projects` for coloured swatches in a TTY; the CLI
defaults to plain output.

## macOS integration

### Codex pets

Install the pets of every configured theme (`theme:` and each `families:` entry)
and select one for the repository you are in, along with every `path:` entry in
`~/.config/familiar/identities.yaml`:

```sh
familiar install pets --sync-projects
```

Run it from inside the project you want a pet in. Codex draws nothing until a
`[tui] pet` setting exists, so on a machine with no `identities.yaml` — which is
what a fresh `familiar theme add` leaves — the current repository is the only
thing to select, and this is what selects it.

Compiling the pets is a prerequisite, not a convenience. After the first
`install pets`, the [relay lifecycle setup](#codex-lifecycle-hooks) lets Familiar's
observer maintain a Codex session's project selection from its first turn onward.
It refuses to select a member whose pet has not been compiled for the active
theme, and says so. Re-run `familiar install pets` after switching themes or
adding a family. A configured theme that is not installed, or whose pack does not
load, fails the command by name before any pet is written.

Each pet is named for its theme and member, `familiar-<theme>--<member>`, so two
themes holding a member of the same id each keep their own pet. A project's
selection is the repository's face: the member its family's theme gives it with no
role. A Codex session started with `FAMILIAR_ROLE` set leaves the selection as it is
and says so in one line, so a per-launch role is never written into the repository.

**Single-theme pet ids.** Familiar recognises a managed `.codex/config.toml` only
when it names a per-theme id. A managed file that names a single-theme id
`custom:familiar-<member>` is therefore not Familiar's: `install pets --sync-projects`
refuses it by path, and convergence reports it, with the same
`refusing unmanaged project config <path>` message it gives a config you wrote
yourself. So check each refused file before removing it. Remove it only when it holds
exactly these three lines, with a `pet` value that has no `--` after `familiar-`:

```toml
# Managed by Familiar. Run `familiar install pets --sync-projects` to update.
[tui]
pet = "custom:familiar-<member>"
```

Any other refused file is yours: leave it, and set its `pet` yourself if you want a
Familiar pet there. After removing the managed ones, run
`familiar install pets --sync-projects` again to write the per-theme selection.
Pet directories under `~/.codex/pets/` named `familiar-<member>`, with no `--` in
the name, are never selected and can be deleted. Keep every
`familiar-<theme>--<member>` directory: those are the current pets.

Familiar creates managed project `.codex/config.toml` files and excludes them
from each repository. In a Git worktree the config is written in that worktree
only, with the member its repository's pins choose; the exclusion is one line in
the repository's shared `info/exclude`, so it covers every worktree and is never
duplicated. Pinned paths and the current directory are the only targets: other
worktrees are not discovered. It never overwrites an existing tracked config; review
its printed setting instead. It refuses an existing unmanaged untracked config,
and it leaves the user-wide `~/.codex/config.toml` alone.
To install pets without synchronizing projects, run `familiar install pets`.

Choose a user-wide default in `~/.codex/config.toml`:

```toml
[tui]
pet = "custom:familiar-cats--ginger"
```

For a project-specific pet, use `familiar whoami <project>` to find the assigned
member (`familiar projects <dir>...` draws several at once, each sprite over its
name, and says whether the project colour, a pin or the project's hash chose
each slot), then set `pet = "custom:familiar-<theme>--<member>"` in that trusted project's `.codex/config.toml`.
Restart an existing Codex session after syncing.

### OpenCode

Relay installs the server plugin; Familiar installs the sprite renderer. This is
also part of the operator cutover above. Plan the relay change, review it, and
apply it before installing the sprite. Save relay's exact postimage before
Familiar removes the old server entry; rollback needs those bytes. With plain
`opencode.json` and `tui.json` (no `.jsonc` siblings), run:

```sh
OPENCODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$OPENCODE_DIR"
if test -e "$OPENCODE_DIR/tui.json"; then
  cp -p "$OPENCODE_DIR/tui.json" "$CUTOVER_BACKUP/tui.before-familiar"
else
  touch "$CUTOVER_BACKUP/tui.before-familiar.absent"
fi
relay install --harness opencode --subscribers "$HOME/.config/relay/subscribers.json" \
  --config-dir "$OPENCODE_DIR" --json
# After reviewing the plan:
relay install --harness opencode --subscribers "$HOME/.config/relay/subscribers.json" \
  --config-dir "$OPENCODE_DIR" \
  --apply --artifact "$CUTOVER_BACKUP/opencode-install.json"
cp -p "$OPENCODE_DIR/opencode.json" "$CUTOVER_BACKUP/opencode.after-relay"
"$FAMILIAR_NEW" install opencode --config-dir "$OPENCODE_DIR"
# After a successful install (or completing its manual edits):
cp -p "$OPENCODE_DIR/opencode.json" "$CUTOVER_BACKUP/opencode.after-familiar"
cp -p "$OPENCODE_DIR/tui.json" "$CUTOVER_BACKUP/tui.after-familiar"
```

Create the OpenCode config directory first if it is absent. Relay preserves
JSONC comments and existing server plugin entries. Familiar registers only the
sprite renderer in `tui.json` and removes its old server plugin from
`opencode.json` when its ownership is verifiable; it preserves unrelated entries.

If you keep `tui.jsonc`, Familiar prints the renderer entry to add by hand and
exits nonzero until that manual work is done. An old Familiar server plugin in
`opencode.jsonc`, or one whose ownership cannot be verified, also needs manual
removal. If both `.json` and `.jsonc` versions exist, resolve the ambiguity first.
A malformed configuration prevents any Familiar writes.

Restart OpenCode after installation. For server-side errors, inspect relay's
`~/.local/state/relay/opencode-plugin.log` (or the log under `RELAY_STATE_DIR`).

#### Coordinated rollback

Stop the affected harnesses and Familiar jobs first. Reverse completed operations
in reverse order, using only artifacts and snapshots from this cutover. If an
install stopped partway, inspect its artifact and actual files first; do not run
steps for edits that never happened. Preserve any subsequent user edits separately
and reconcile them before restoring snapshots.

For the plain JSON OpenCode sequence above, the following block first verifies
that neither file changed since Familiar's install. It then undoes Familiar's
server/TUI changes, verifies relay's exact postimage, and rolls relay back:

```sh
(
  set -e
  cmp "$OPENCODE_DIR/opencode.json" "$CUTOVER_BACKUP/opencode.after-familiar"
  cmp "$OPENCODE_DIR/tui.json" "$CUTOVER_BACKUP/tui.after-familiar"
  cp -p "$CUTOVER_BACKUP/opencode.after-relay" "$OPENCODE_DIR/opencode.json"
  if test -e "$CUTOVER_BACKUP/tui.before-familiar.absent"; then
    rm "$OPENCODE_DIR/tui.json"
  else
    cp -p "$CUTOVER_BACKUP/tui.before-familiar" "$OPENCODE_DIR/tui.json"
  fi
  cmp "$OPENCODE_DIR/opencode.json" "$CUTOVER_BACKUP/opencode.after-relay"
  relay rollback --artifact "$CUTOVER_BACKUP/opencode-install.json"
)
```

Calling relay rollback directly after `familiar install opencode` can fail with
a preimage-drift refusal (the current CLI prints `relay: relay operation failed`):
Familiar removed the old plugin from relay's saved postimage. Do not edit the
artifact or bypass that check. For JSONC, restore the exact saved post-relay `.jsonc` bytes before relay rollback, and restore the TUI file's own
preimage; regenerating equivalent JSON is insufficient.

For Codex, `relay rollback --artifact "$CUTOVER_BACKUP/codex-install.json"`
restores the old hook commands. For Claude, the status line was changed **before**
relay, so reverse relay first, then the status line:

```sh
(
  set -e
  relay rollback --artifact "$CUTOVER_BACKUP/claude-code-install.json"
  cmp "$HOME/.claude/settings.json" "$CUTOVER_BACKUP/claude.after-familiar"
  cp -p "$CUTOVER_BACKUP/claude.before-familiar" "$HOME/.claude/settings.json"
)
```

If the status line was edited after relay instead, first restore the saved exact
post-relay settings bytes, then roll relay back. Finally restore the subscribers
file and any services/launchers from their separately recorded preimages. Check
that every restored hook executable and plugin import resolves into the retained
compatible Familiar checkout, then restart harnesses and jobs and smoke-test them.
Do not restore a launcher to this migration's CLI: it has no `hook` command.
Neither rollback nor updating this checkout authorizes a live host cutover.

OpenCode renderer graphics, tint, bell, and live terminal delivery remain
provisional. The 2026-08-24 physical-Mac gate exercised the renderer in Kitty and
Ghostty and recorded two failures: the sprite never changed pose, and
`needs-approval` never reached Familiar's bus, so the pet could not signal an
approval. Familiar's hook-side tint and bell for OpenCode verified clean in the same
run. Both defects have since been found and fixed — a watch callback filtered on a
filename macOS never reports, and a permission ask bound to nothing on the stable
event stream — but neither fix has been exercised against a live OpenCode, so the
label stands until those two cells are re-run. See
`docs/ref/2026-08-24-macos-terminal-smoke.md`.

### Reap abandoned sessions

An agent that exits without `SessionEnd` can leave state behind. `familiar reap`
prunes relay's dead records and reconciles Familiar's presentation files even
when nothing is pruned. Timer recovery updates files and never emits terminal
bytes; a later live observer event handles terminal delivery. Keep the reap job
when cutting over hooks to relay. First run
`command -v node` and record its absolute output. To reap abandoned sessions
every minute, replace both absolute paths below—the Node executable and this
checkout's `bin/familiar`—then save the file as
`~/Library/LaunchAgents/dev.familiar.reap.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.familiar.reap</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/path/to/familiar/bin/familiar</string>
    <string>reap</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Activate it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.familiar.reap.plist
launchctl kickstart gui/$(id -u)/dev.familiar.reap
```

### Known macOS difference: the status line branch field

Familiar gives `git symbolic-ref` a 250 ms budget when it fills the status
line's branch field, and falls back to a short commit sha if that budget is
exceeded. On macOS a cold `git` — first run after boot, or one being scanned by
security software — can exceed it on its own, so the same repository may show a
sha on macOS where it shows a branch name on Linux. It corrects itself once git
is warm. Nothing is wrong with the repository or the status line.

### Terminal checklist for unclaimed combinations

The physical-Mac gate covers Claude Code and Codex in Kitty 0.46.2 and Ghostty
1.3.1 only. On any other terminal, on Intel or macOS 13, or with the OpenCode
renderer, smoke-test before relying on rendering: check launch/idle,
working, approval when exposed, done/error, session exit, and `familiar reap`
after abnormal termination. Record the agent and terminal versions and any
failure; passing a checklist is not a live-terminal support claim.

Inside tmux: `tmux set -g allow-passthrough all`, use a full-width pane, check the status
line renders 24-bit colour, and expect the cat at the first state change after attaching a
client. `FORCE_COLOR=3` in the tmux environment is an untested workaround for the status-line
colour downgrade. When multiple clients with different outer terminals are attached, tmux
may select one for the probe and the transmission ledger tracks that client; this case is
not addressed.

## Linux-only integrations

The following integrations are Linux-only and do not apply to macOS.

### Niri workspace awareness, desktop attention and moments

Start the desktop coordinator once per Niri session:

```kdl
spawn-sh-at-startup "familiar-niri watch"
```

It holds `attention-coordinator.lock`, so a second copy refuses to start. It writes the
session map (`niri-windows.json`), the workspace feed (`niri-workspaces.json`) and the
heartbeat (`attention-health.json`), attributes agent attention to the workspace that
hosts each agent, and sends one generic desktop toast per new request through
`noctalia msg notification-show`. On niri-material it also sets each terminal's
`familiar` window signal, which a glass ring whose color source is `familiar` draws in
that session's hue. Run it as a supervised user service with restart-on-failure when
native agent toasts are turned off, so a dead coordinator is noticed:
`docs/runbooks/desktop-attention-rollout.md`.

Optionally start the focused-output moments:

```kdl
spawn-sh-at-startup "qs -d -p /path/to/familiar/integrations/niri-desktop"
```

The popup plays one short, click-through moment per agent request, error or finished
turn that the coordinator made eligible, on the focused output. It reserves each moment
through `familiar attention popup`, so `familiar` must be on its `PATH`, as must `qs`.
Set `motion: full`, `reduced`, or `off` in `~/.config/familiar/config.yaml`.

### Noctalia workspace pills

`integrations/noctalia-plugin` is a Noctalia 5.3 plugin (`khughitt/familiar`): link it
into `~/.local/share/noctalia/plugins/`, enable it, and use
`khughitt/familiar:workspaces` in a bar section in place of the built-in `workspaces`.
Left click focuses a workspace, right click dismisses its alerts, middle click opens the
widget's settings, and the ⚑ button opens the Alerts panel. `familiar` must be on
Noctalia's `PATH`. Behaviour: `docs/attention.md`.

### Keep the scheme aligned with Noctalia

Set Noctalia's dark-mode hook to:

```sh
familiar-noctalia scheme-sync
```

The adapter reads Noctalia's dark/light setting and writes Familiar's scheme file.

### Reap abandoned sessions with systemd

Run `familiar reap` periodically with a user systemd timer, including after the
relay cutover. It prunes relay's dead records and reconciles presentation files
even when nothing is pruned. Recovery updates files and never emits terminal
bytes. Replace only the
binary path in this service file:

```ini
# ~/.config/systemd/user/familiar-reap.service
[Service]
Type=oneshot
ExecStart=/absolute/path/to/familiar/bin/familiar reap
```

```ini
# ~/.config/systemd/user/familiar-reap.timer
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
```

Enable it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now familiar-reap.timer
```
