# Install

Type: guide; document types 1.

Requires Node.js 22+ and Git 2.31+. Art installs separately. See
[configuration](configuration.md), [surface support](surfaces.md) and the
[desktop operations guide](runbooks/desktop-attention.md).

## Fresh installation

```sh
git clone https://github.com/khughitt/familiar.git
cd familiar
npm install
npm link
familiar scheme set dark
familiar theme add <theme-url-or-directory>
familiar theme list
```

`theme add` installs art; it does not select it. Set `theme: <installed-id>` in
`~/.config/familiar/config.yaml`, preserving any other settings, then run
`familiar whoami`. The id comes from the pack's `theme.yaml` and `theme list`.
See [theme selection](configuration.md) for family overrides. A fresh clone
has no art and the default theme name alone cannot make a pet.

Use stable explicit executables throughout harness setup:

```sh
FAMILIAR_BIN="$PWD/bin/familiar"
RELAY_BIN="$PWD/node_modules/.bin/relay"
```

`npm install` installs the pinned relay dependency too; the second path is its
CLI. Keep this checkout and its dependencies available to installed commands.
A shared npm link is optional when invoking these paths directly.

`theme add` accepts a public HTTPS repository or a local directory. It copies only
`theme.yaml`, licence files and each member's sprite directory, validates that copy
and atomically installs it under `~/.config/familiar/themes/<id>`. Checkout docs,
workspaces and build output are excluded. A second add refuses unless replacing.

## Themes

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

When a configured theme is missing from both the user and shipped theme directories,
the error names the theme and its recovery. If an install receipt remains, it names
the recorded local path or HTTPS URL and commit. Remove that receipt, then run
`familiar theme add SOURCE` with the recorded source. This installs the source's
current contents; it does not restore the recorded commit. An invalid receipt is
reported explicitly. With no receipt, choose a source for `familiar theme add SOURCE`;
`familiar theme list` shows the themes that are installed.

`theme add --replace` validates the new copy first, then moves the installed pack
and receipt into a backup directory,
`~/.config/familiar/themes/.replace-backup/<id>-<instant>/`, as `pack/` and
`receipt.json`. It installs the new pack, writes its receipt, and only then deletes
the backup and, when no other backup remains, the `.replace-backup` directory itself. If the install fails after the old theme was moved aside, the new copy
is removed and the old pack and receipt are moved back; the error names the cause.
`theme add` and `theme remove` share one lock, so neither runs while another is
under way.

## Theme recovery

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
# The root too, once no backup is left in it; only its ENOTEMPTY is silenced.
rmdir ~/.config/familiar/themes/.replace-backup 2>/dev/null || true
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

## Relay and harness setup

Relay owns lifecycle hooks, process admission and the agent registry; Familiar
observes events and owns presentation state. Stop the affected harness before
editing its configuration. Choose a new durable private backup directory:

```sh
INSTALL_BACKUP=/absolute/path/to/private-install-backup
mkdir -m 700 "$INSTALL_BACKUP"
SUBSCRIBERS="${XDG_CONFIG_HOME:-$HOME/.config}/relay/subscribers.json"
```

Before every edit, retain exact bytes, permissions and whether the target existed;
retain its postimage too. An absent preimage is restored by removing only the
created file. Stop on drift rather than overwrite subsequent changes. Include
subscribers and any launcher/service changes. Keep artifacts for the rollback window.
The examples below use plain JSON; JSONC manual edits need the same exact snapshots.

Use the relay CLI installed above and follow its [hook installation and rollback guide](https://github.com/khughitt/relay/blob/main/docs/runbooks/hook-install-rollback.md),
including the platform evidence gates. Generate Familiar's observer document:

```sh
"$FAMILIAR_BIN" setup relay
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
rollback artifact. Keep that artifact; `"$RELAY_BIN" rollback --artifact <file>` restores
the recorded preimages only while each target still matches its saved before or
after bytes. Later edits to the same file must be reversed first. Relay's artifact
covers only relay's changes, not Familiar's installer, status line, subscribers,
launchers, or services. Follow the coordinated rollback below. The apply command
recomputes the plan from the current configuration, so inspect a fresh plan if anything changed after review. For
hook commands, relay records the Node executable used by its installer; use its
`--node /absolute/stable/node` option when that executable would otherwise live
under a version manager. Existing guard subscribers may require `--evidence`;
follow relay's guide rather than removing them to make installation pass.

## Claude Code

Familiar's Claude Code settings fragment now carries only its status line:

```sh
"$FAMILIAR_BIN" setup claude-code
```

Create the parent and an empty JSON object if the target is absent; never replace
an existing file with an empty one. Record that absence for rollback.
Save the baseline before merging stdout into `~/.claude/settings.json`; save
that merged result before relay's edit. Then plan and apply relay's hooks,
using the current lifecycle adapter:

```sh
cp -p "$HOME/.claude/settings.json" "$INSTALL_BACKUP/claude.before-familiar"
# Merge the reviewed statusLine fragment now, then:
cp -p "$HOME/.claude/settings.json" "$INSTALL_BACKUP/claude.after-familiar"
"$RELAY_BIN" install --harness claude-code --subscribers "$SUBSCRIBERS" \
  --target "$HOME/.claude/settings.json" --json
# After reviewing the plan:
"$RELAY_BIN" install --harness claude-code --subscribers "$SUBSCRIBERS" \
  --target "$HOME/.claude/settings.json" \
  --apply --artifact "$INSTALL_BACKUP/claude-code-install.json"
```

## Codex

Plan and apply relay's Codex hooks instead of generating Familiar hooks:

```sh
"$RELAY_BIN" install --harness codex --subscribers "$SUBSCRIBERS" \
  --target "$HOME/.codex/hooks.json" --json
# After reviewing the plan:
"$RELAY_BIN" install --harness codex --subscribers "$SUBSCRIBERS" \
  --target "$HOME/.codex/hooks.json" \
  --apply --artifact "$INSTALL_BACKUP/codex-install.json"
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

## Codex pets

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
`install pets`, the [relay lifecycle setup](#codex) lets Familiar's
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

## OpenCode

Relay installs the server plugin; Familiar installs the sprite renderer. Plan the relay change, review it, and
apply it before installing the sprite. Save relay's exact postimage before
Familiar removes the old server entry; rollback needs those bytes. With plain
`opencode.json` and `tui.json` (no `.jsonc` siblings), run:

```sh
OPENCODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$OPENCODE_DIR"
if test -e "$OPENCODE_DIR/tui.json"; then
  cp -p "$OPENCODE_DIR/tui.json" "$INSTALL_BACKUP/tui.before-familiar"
else
  touch "$INSTALL_BACKUP/tui.before-familiar.absent"
fi
"$RELAY_BIN" install --harness opencode --subscribers "$SUBSCRIBERS" \
  --config-dir "$OPENCODE_DIR" --json
# After reviewing the plan:
"$RELAY_BIN" install --harness opencode --subscribers "$SUBSCRIBERS" \
  --config-dir "$OPENCODE_DIR" \
  --apply --artifact "$INSTALL_BACKUP/opencode-install.json"
cp -p "$OPENCODE_DIR/opencode.json" "$INSTALL_BACKUP/opencode.after-relay"
"$FAMILIAR_BIN" install opencode --config-dir "$OPENCODE_DIR"
# After a successful install (or completing its manual edits):
cp -p "$OPENCODE_DIR/opencode.json" "$INSTALL_BACKUP/opencode.after-familiar"
cp -p "$OPENCODE_DIR/tui.json" "$INSTALL_BACKUP/tui.after-familiar"
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

## Rollback

These commands apply only to the sequence recorded above.

Stop the affected harnesses and Familiar jobs first. Reverse completed operations
in reverse order, using only artifacts and snapshots from this installation. If an
install stopped partway, inspect its artifact and actual files first; do not run
steps for edits that never happened. Preserve any subsequent user edits separately
and reconcile them before restoring snapshots.

For the plain JSON OpenCode sequence above, the following block first verifies
that neither file changed since Familiar's install. It then undoes Familiar's
server/TUI changes, verifies relay's exact postimage, and rolls relay back:

```sh
(
  set -e
  cmp "$OPENCODE_DIR/opencode.json" "$INSTALL_BACKUP/opencode.after-familiar"
  cmp "$OPENCODE_DIR/tui.json" "$INSTALL_BACKUP/tui.after-familiar"
  cp -p "$INSTALL_BACKUP/opencode.after-relay" "$OPENCODE_DIR/opencode.json"
  if test -e "$INSTALL_BACKUP/tui.before-familiar.absent"; then
    rm "$OPENCODE_DIR/tui.json"
  else
    cp -p "$INSTALL_BACKUP/tui.before-familiar" "$OPENCODE_DIR/tui.json"
  fi
  cmp "$OPENCODE_DIR/opencode.json" "$INSTALL_BACKUP/opencode.after-relay"
  "$RELAY_BIN" rollback --artifact "$INSTALL_BACKUP/opencode-install.json"
)
```

Calling relay rollback directly after `familiar install opencode` can fail with
a preimage-drift refusal (the current CLI prints `relay: relay operation failed`):
Familiar removed the old plugin from relay's saved postimage. Do not edit the
artifact or bypass that check. For JSONC, restore the exact saved post-relay `.jsonc` bytes before relay rollback, and restore the TUI file's own
preimage; regenerating equivalent JSON is insufficient.

For Codex, `"$RELAY_BIN" rollback --artifact "$INSTALL_BACKUP/codex-install.json"`
restores the old hook commands. For Claude, the status line was changed **before**
relay, so reverse relay first, then the status line:

```sh
(
  set -e
  "$RELAY_BIN" rollback --artifact "$INSTALL_BACKUP/claude-code-install.json"
  cmp "$HOME/.claude/settings.json" "$INSTALL_BACKUP/claude.after-familiar"
  cp -p "$INSTALL_BACKUP/claude.before-familiar" "$HOME/.claude/settings.json"
)
```

If the status line was edited after relay instead, restore the exact post-relay
settings bytes first, then roll relay back. See Upgrade for compatible old-checkout
restoration when undoing an upgrade.

For an originally absent Claude target, remove only the file you created after
verifying its saved postimage, instead of copying a nonexistent preimage. Finally
restore subscribers and launcher/service changes from their own preimages. Inspect
restored executables and plugin imports before restarting and smoke-testing harnesses.
Relay's artifact covers relay edits only; it does not cover Familiar, subscribers,
status lines or services. Never bypass its drift refusal.

## Upgrade

Only existing installs using pre-relay hooks or spec-version 1 themes need this
section. A fresh installation follows the steps above.

Retain a working old Familiar checkout and dependencies, old plugin imports, theme
pack, receipt and exact configuration preimages before changing code. Resolve every
old hook/launcher to that retained checkout during the rollback window. An old hook
pointing at the new CLI is not a rollback: the current CLI has no old hook verb.
Use a separate new checkout; keep existing state. Apply the current relay/harness
steps, adding `--retire familiar` to relay's Claude/Codex installation only when
retiring verified old Familiar entries. Preserve the pre/postimages at each stage.

Spec-version 1 packs (`slot`/`slots`, no `roles`) are refused by a version 2 reader.
Retain the old compatible build, pack and receipt; replace the pack with a validated
version 2 pack with exactly one `default` role holder. Keep the build/pack mismatch
window short with harnesses stopped. Install dependencies before launching the new
build, update configured theme/family ids, compile and reselect Codex pets, and restart
loaded OpenCode and desktop consumers. [Desktop restart order](runbooks/desktop-attention.md#restart-and-upgrade)
covers the coordinator, shell and popup. Check each configured theme before resuming.

To roll back a v2 theme upgrade, stop harnesses/jobs and retain every replacement
before removing anything. While the new build is available, remove an **empty**
`.replace-backup` root with `rmdir`; a root still holding a pack needs Theme recovery
first. Older readers reject that root as a theme id. Have the v1 pack locally: use
the saved copy, or clone the receipt's source URL and check out its recorded commit.
Adding an HTTPS URL fetches its current default branch, not that old commit.

Restore the compatible old code and run `npm ci` there **before** restoring the v1
pack. Keep consumers stopped while that old reader sees the installed v2 pack.
Only after confirming the v1 source contains `theme.yaml`, remove the installed v2
pack and receipt and run the old build's `theme add <local-v1-directory>`. The old
build has no theme-remove command. Restart the coordinator using the linked stop/
wait procedure so its in-memory code and theme match. Restore/recompile its native
pets and run that build's `install pets --sync-projects`; per-theme managed ids are
rewritten by the old build, while unmanaged configs remain yours. Old session
validators ignore added family/role/admitted keys, so no state deletion is needed.

For a relay rollback, reverse Familiar's edits and relay's edits in the order under
Rollback, restore saved subscribers/configuration, and restore every old executable
and plugin import to the retained compatible checkout before restarting harnesses.
Keep pack receipts, code/dependencies, configuration and backups through acceptance.

## Platform setup

Harness setup above applies to Linux and macOS. Optional reap jobs reconcile dead
sessions without emitting terminal bytes; a subsequent live event handles delivery.

## macOS reap

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


Inspect with `launchctl print gui/$(id -u)/dev.familiar.reap`; stop with
`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.familiar.reap.plist`.

## Linux desktop

The following integrations are Linux-only and do not apply to macOS.

### Niri

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
`[desktop operations](runbooks/desktop-attention.md)`.

Optionally start the focused-output moments:

```kdl
spawn-sh-at-startup "qs -d -p /path/to/familiar/integrations/niri-desktop"
```

The popup plays one short, click-through moment per agent request, error or finished
turn that the coordinator made eligible, on the focused output. It reserves each moment
through `familiar attention popup`, so `familiar` must be on its `PATH`, as must `qs`.
Set `motion: full`, `reduced`, or `off` in `~/.config/familiar/config.yaml`.

### Noctalia

`integrations/noctalia-plugin` is a Noctalia 5.3 plugin (`khughitt/familiar`): link it
into `~/.local/share/noctalia/plugins/`, enable it, and use
`khughitt/familiar:workspaces` in a bar section in place of the built-in `workspaces`.
Left click focuses a workspace, right click dismisses its alerts, middle click opens the
widget's settings, and the Alerts button opens the Alerts panel. `familiar` must be on
Noctalia's `PATH`. Behaviour: [attention](attention.md).

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

Inspect with `systemctl --user status familiar-reap.timer`; stop with
`systemctl --user disable --now familiar-reap.timer` and restore/remove only your
own unit files. For desktop use, prefer the supervised coordinator in the linked
runbook over an unsupervised startup command. These host edits need the host owner's approval.
