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
workspaces, docs, build output) is left behind.

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

### Relay observers and lifecycle hooks (operator cutover)

Familiar consumes relay's registry as an observer. Relay owns lifecycle hooks,
process admission, and the agent registry; Familiar owns presentation state.
The steps below change harness configuration and are the **operator cutover**,
tracked separately as `hq-539508`. Updating this checkout does not perform them.

Install relay and follow its [hook installation and rollback guide](https://github.com/khughitt/relay/blob/main/docs/runbooks/hook-install-rollback.md),
including the platform evidence gates. Make the relay CLI available on `PATH`
from that installation. Generate Familiar's observer document:

```sh
familiar setup relay
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
the recorded preimages. The apply command recomputes the plan from the current
configuration, so inspect a fresh plan if anything changed after review. For
hook commands, relay records the Node executable used by its installer; use its
`--node /absolute/stable/node` option when that executable would otherwise live
under a version manager. Existing guard subscribers may require `--evidence`;
follow relay's guide rather than removing them to make installation pass.

### Claude Code

Familiar's Claude Code settings fragment now carries only its status line:

```sh
familiar setup claude-code
```

Review stdout and merge it into `~/.claude/settings.json`. Then plan and apply
relay's hooks, retiring Familiar's old hook entries:

```sh
relay install --harness claude-code --subscribers "$HOME/.config/relay/subscribers.json" \
  --target "$HOME/.claude/settings.json" --retire familiar --json
# After reviewing the plan:
relay install --harness claude-code --subscribers "$HOME/.config/relay/subscribers.json" \
  --target "$HOME/.claude/settings.json" --retire familiar \
  --apply --artifact "$HOME/.config/relay/claude-code-install.json"
```

### Codex lifecycle hooks

Plan and apply relay's Codex hooks instead of generating Familiar hooks:

```sh
relay install --harness codex --subscribers "$HOME/.config/relay/subscribers.json" \
  --target "$HOME/.codex/hooks.json" --retire familiar --json
# After reviewing the plan:
relay install --harness codex --subscribers "$HOME/.config/relay/subscribers.json" \
  --target "$HOME/.codex/hooks.json" --retire familiar \
  --apply --artifact "$HOME/.config/relay/codex-install.json"
```

The hook targets must already contain valid configuration; for a fresh target,
create its parent directory and an empty JSON object before planning. Codex asks
for a one-time trust confirmation before it runs hooks. Codex draws its own pet,
so it has no status line entry — see Codex pets below for the art.

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
  repository anchor or `projectColor`. They leave the bus until each session's
  next hook re-admits it; a status line may show no identity until then. Pins
  are untouched.

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

Install the current theme's pets and select one for the repository you are in,
along with every `path:` entry in `~/.config/familiar/identities.yaml`:

```sh
familiar install pets --sync-projects
```

Run it from inside the project you want a pet in. Codex draws nothing until a
`[tui] pet` setting exists, so on a machine with no `identities.yaml` — which is
what a fresh `familiar theme add` leaves — the current repository is the only
thing to select, and this is what selects it.

Compiling the pets is a prerequisite, not a convenience: after the first
`install pets`, a Codex session maintains its own project's selection from its
first turn onward, but it will refuse to select a member whose pet has not been
compiled for the active theme, and say so. Re-run `familiar install pets` after
switching themes.

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
pet = "custom:familiar-ginger"
```

For a project-specific pet, use `familiar whoami <project>` to find the assigned
member (`familiar projects <dir>...` draws several at once, each sprite over its
name, and says whether the project colour, a pin or the project's hash chose
each slot), then set `pet = "custom:familiar-<member>"` in that trusted project's `.codex/config.toml`.
Restart an existing Codex session after syncing.

### OpenCode

Relay installs the server plugin; Familiar installs the sprite renderer. This is
also part of the operator cutover above. Plan the relay change, review it, and
apply it before installing the sprite:

```sh
relay install --harness opencode --subscribers "$HOME/.config/relay/subscribers.json" \
  --config-dir "$HOME/.config/opencode" --json
# After reviewing the plan:
relay install --harness opencode --subscribers "$HOME/.config/relay/subscribers.json" \
  --config-dir "$HOME/.config/opencode" \
  --apply --artifact "$HOME/.config/relay/opencode-install.json"
familiar install opencode
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

### Niri workspace awareness and desktop moments

Start the workspace watcher from `~/.config/niri/config.kdl`:

```kdl
spawn-sh-at-startup "familiar-niri watch"
```

It is the sole writer of `niri-windows.json`. It resynchronizes after both agent
and Niri events, so moving a terminal between workspaces keeps the feed current.
On niri-material it also sets each terminal's `familiar` window signal, which a
glass ring whose color source is `familiar` draws in that session's hue.

Optionally start focused-output completion and error moments:

```kdl
spawn-sh-at-startup "qs -d -p /path/to/familiar/integrations/niri-desktop"
```

The desktop process reads `intent.json` directly and plays a short, click-through
full-colour animation on the focused output when the state arrives. It needs `qs`
on `PATH`. Set `motion: full`, `reduced`, or `off` in
`~/.config/familiar/config.yaml` to control moments.

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
