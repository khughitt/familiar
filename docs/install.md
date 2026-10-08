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

`familiar theme add` accepts a public HTTPS repository or a clean local theme
checkout. It validates the complete pack before atomically installing it into
`~/.config/familiar/themes/<id>`.

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

### Claude Code

Generate the Claude Code settings fragment:

```sh
familiar setup claude-code
```

Review stdout and merge it into `~/.claude/settings.json`. The command only
prints JSON; it does not edit your settings file.

### Codex lifecycle hooks

Generate the Codex hooks fragment:

```sh
familiar setup codex
```

Review stdout and merge it into `~/.codex/hooks.json`. The command only prints
JSON; it does not edit that file. Codex asks for a one-time trust confirmation
before it runs hooks.

This configures lifecycle hooks only. Codex draws its own pet, so it has no
status line entry — see Codex pets below for the art.

Earlier versions shipped a review-only hooks fixture carrying a literal path
placeholder. It is gone: the generated document embeds the real path of the
`bin/familiar` you linked, shell-quoted for the `/bin/zsh -c` boundary Codex runs
hook commands through.

## Project identity and Git worktrees

Every project gets a familiar from a hash of its identity; `~/.config/familiar/identities.yaml`
pins one deliberately by `remote:`, `path:` or `project:` (basename). A Git
worktree follows its repository: a pin on the main checkout applies to every
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
- **After upgrading.** Sessions already on the bus were recorded without a
  repository anchor. The next hook evicts them once, naming the missing field,
  and each session's own next hook re-admits it; a status line may show no
  identity until then. Pins are untouched.

### Measuring hook latency

Every agent tool call runs a hook, so identity discovery is measured, not
assumed. `just bench-hook MODE BASELINE CANDIDATE FIXTURE [SAMPLES WARMUPS PAIRS]`
(defaults 30, 5 and 4) times complete `familiar hook PreToolUse` processes for
two checkouts in one sitting, on a fixture main checkout and a linked worktree
with real Git. Pairs run the two checkouts' batches back to back and alternate
which goes first, so host drift lands on both sides of a pair. FIXTURE must be a
fresh empty directory; it holds the repositories, separate bus state per
checkout and context, `batches.jsonl` (appended as each batch completes) and
`report.json`. A sample counts only when the hook exited cleanly with no output
and left a fresh working agent record and intent. `pilot` mode accepts the same
checkout twice and proves the tool; `compare` needs two distinct revisions and
enforces the Git spawn counts (two on a main checkout; three on a linked one,
two before worktree identity). Timing is never judged automatically: the report
gives medians, p95, each pair's difference and the probe's own cost for review.
Each batch is recorded by `tools/tt` as `bench-hook-<context>-<version>`. It
needs Linux; the measurement covers the hook process, not a live agent.

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
name, and says whether a pin or the project's hash chose each slot), then set
`pet = "custom:familiar-<member>"` in that trusted project's `.codex/config.toml`.
Restart an existing Codex session after syncing.

### OpenCode

Install the OpenCode integration:

```sh
familiar install opencode
```

It preserves existing plugin entries. Restart OpenCode after installation; if
the integration fails, inspect `~/.local/state/familiar/opencode-plugin.log`.

It writes `tui.json` and `opencode.json` only. If you keep a `tui.jsonc` or
`opencode.jsonc` instead, that file is left for you: the command prints the plugin
path to add by hand, rather than rewriting a commented file as plain JSON or
creating a `.json` sibling that shadows it.

The two configs are handled independently — `tui.json` registers the sprite
renderer, `opencode.json` registers the server plugin — so a `.jsonc` on one still
lets the other be written. The command exits nonzero whenever anything is left for
you, because the install is incomplete until you add that entry. A config it cannot
parse is the different case: nothing is written at all.

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

An agent that exits without `SessionEnd` can leave state behind. First run
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

Run `familiar reap` periodically with a user systemd timer. Replace only the
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
