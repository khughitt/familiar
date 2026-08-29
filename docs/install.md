# Install

Familiar requires Node.js 22 or newer. Themes install separately; this engine
ships no art.

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
the same gate exercised it and found the sprite never changes pose. tmux, Intel
Macs, macOS 13, and other terminals stay unclaimed.

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

## macOS integration

### Codex pets

Install the current theme's pets and synchronize every `path:` entry in
`~/.config/familiar/identities.yaml` into its project:

```sh
familiar install pets --sync-projects
```

Familiar creates managed project `.codex/config.toml` files and excludes them
from each repository. It never overwrites an existing tracked config; review
its printed setting instead. It refuses an existing unmanaged untracked config.
To install pets without synchronizing projects, run `familiar install pets`.

Choose a user-wide default in `~/.codex/config.toml`:

```toml
[tui]
pet = "custom:familiar-ginger"
```

For a project-specific pet, use `familiar whoami <project>` to find the assigned
member, then set `pet = "custom:familiar-<member>"` in that trusted project's
`.codex/config.toml`. Restart an existing Codex session after syncing.

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
Ghostty and recorded two failures: the sprite transmits three images per session and
then re-places them without ever changing pose, and `needs-approval` never reaches
Familiar's bus, so the pet cannot signal an approval and OpenCode can only ring on
`error`. Familiar's hook-side tint and bell for OpenCode verified clean in the same
run. See `docs/ref/2026-08-24-macos-terminal-smoke.md`.

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
1.3.1 only. On any other terminal, on Intel or macOS 13, inside tmux, or with the
OpenCode renderer, smoke-test before relying on rendering: check launch/idle,
working, approval when exposed, done/error, session exit, and `familiar reap`
after abnormal termination. Record the agent and terminal versions and any
failure; passing a checklist is not a live-terminal support claim.

## Linux-only integrations

The following integrations are Linux-only and do not apply to macOS.

### Niri workspace awareness and desktop moments

Start the workspace watcher from `~/.config/niri/config.kdl`:

```kdl
spawn-sh-at-startup "familiar-niri watch"
```

It is the sole writer of `niri-windows.json`. It resynchronizes after both agent
and Niri events, so moving a terminal between workspaces keeps the feed current.

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
