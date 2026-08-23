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

### Claude Code

Generate the Claude Code settings fragment:

```sh
familiar setup claude-code
```

Review stdout and merge it into `~/.claude/settings.json`. The command only
prints JSON; it does not edit your settings file.

### Codex lifecycle hooks

Codex lifecycle configuration remains the committed fixture at
`integrations/codex/hooks.json` while its generated setup path awaits the
physical-Mac gate. Review the fixture and merge it into an existing hooks file;
do not replace that file. When `CODEX_HOME` is unset, the destination is
`$HOME/.codex/hooks.json`.

Only if no hooks file exists, copy the fixture from this checkout:

```sh
if [ ! -e "${CODEX_HOME:-$HOME/.codex}/hooks.json" ]; then
  cp integrations/codex/hooks.json "${CODEX_HOME:-$HOME/.codex}/hooks.json"
fi
```

This is distinct from Claude Code's generated JSON; no Codex generation
behavior is documented until the physical-Mac gate has been completed.

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

OpenCode renderer graphics, tint, bell, and live terminal delivery remain
provisional pending the physical-Mac gate.

### Reap abandoned sessions

An agent that exits without `SessionEnd` can leave state behind. To reap those
sessions every minute, replace only the binary path below, then save it as
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

### Provisional terminal checklist

Until the physical-Mac gate is complete, smoke-test Claude Code, Codex, and
OpenCode in current Kitty and Ghostty releases. For each applicable pair,
check launch/idle, working, approval when exposed, done/error, session exit,
and `familiar reap` after abnormal termination. Record the agent and terminal
versions and any failure; passing a checklist is not a live-terminal support
claim.

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
