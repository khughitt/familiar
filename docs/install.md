# Install

Familiar needs a scheme before its first hook. The terminal and agent integrations
are independent; add the ones you use. Examples below use `/path/to/familiar`;
substitute the absolute path of your clone.

## 0. Write a scheme

```bash
familiar scheme set dark          # or: light, --sat 0.8
```

This writes `~/.config/familiar/scheme.json`. Every full-colour render derives its
tone from this input, so Familiar fails loudly if it is missing.

## 1. Install a theme

Familiar ships no art; a theme pack supplies it. Install one from a public
HTTPS repository:

```bash
familiar theme add https://github.com/khughitt/familiar-cats
```

The pack is cloned into staging, validated whole, and promoted atomically
into `~/.config/familiar/themes/<id>`; an install receipt records the source
URL and commit. `familiar theme list` shows every installed theme and its
receipt status. For a private repository, obtain a clean local checkout by
the method appropriate for it, then install that checkout:

```bash
familiar theme add ./path/to/theme
```

## 2. Claude Code hooks and status line

Add Familiar's hooks to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "/path/to/familiar/bin/familiar hook SessionStart" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/path/to/familiar/bin/familiar hook UserPromptSubmit" }] }],
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/path/to/familiar/bin/familiar hook PreToolUse" }] }],
    "Notification": [
      { "matcher": "idle_prompt",       "hooks": [{ "type": "command", "command": "/path/to/familiar/bin/familiar hook Notification:idle_prompt" }] },
      { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "/path/to/familiar/bin/familiar hook Notification:permission_prompt" }] }
    ],
    "Stop":        [{ "hooks": [{ "type": "command", "command": "/path/to/familiar/bin/familiar hook Stop" }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "/path/to/familiar/bin/familiar hook StopFailure" }] }],
    "SessionEnd":  [{ "hooks": [{ "type": "command", "command": "/path/to/familiar/bin/familiar hook SessionEnd" }] }]
  }
}
```

Keep the two `Notification` matchers separate: they are the source of the
`needs-input` / `needs-approval` distinction.

Give Claude Code a status line it owns:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/familiar/bin/familiar statusline",
    "refreshInterval": 2
  }
}
```

The status line prints a stable cell box; hooks swap the full-colour pose beneath
it between refreshes. Familiar deliberately does not render graphics inside tmux,
because it cannot verify that the user's passthrough configuration is safe.

## 3. Codex pets

Install the current theme's pets:

```bash
familiar install pets
```

Choose a member in `~/.codex/config.toml`:

```toml
[tui]
pet = "custom:familiar-ginger"
```

Copy or merge `integrations/codex/hooks.json` into `$CODEX_HOME/hooks.json` so
Codex lifecycle events reach Familiar:

```bash
cp /path/to/familiar/integrations/codex/hooks.json ~/.codex/hooks.json
```

Codex asks for a one-time trust confirmation before it runs hooks. Its native pets
select the pose; Familiar supplies the generated pet art.

## 4. OpenCode graphics

Install the OpenCode integration:

```bash
familiar install opencode
```

It registers the server and TUI plugins, preserving existing plugin entries. Restart
OpenCode after installation. The server plugin forwards lifecycle events to Familiar;
the TUI plugin renders the full-colour graphic. If the integration fails, inspect
`~/.local/state/familiar/opencode-plugin.log`.

## 5. Niri workspace awareness and desktop moments

Start the workspace watcher from `~/.config/niri/config.kdl`:

```kdl
spawn-sh-at-startup "/path/to/familiar/bin/familiar-niri watch"
```

It is the sole writer of `niri-windows.json`. It resynchronizes after both agent and
Niri events, so moving a terminal between workspaces keeps the feed current.

Optionally start focused-output completion and error moments:

```kdl
spawn-sh-at-startup "qs -d -p /path/to/familiar/integrations/niri-desktop"
```

The desktop process reads `intent.json` directly and plays a short, click-through
full-colour animation on the output focused when the state arrived. It needs `qs`
on `PATH`. Set `motion: full`, `reduced`, or `off` in
`~/.config/familiar/config.yaml` to control moments.

## 6. Keep the scheme aligned with Noctalia

Set Noctalia's dark-mode hook to exactly:

```sh
/path/to/familiar/bin/familiar-noctalia scheme-sync
```

The adapter reads Noctalia's dark/light setting and writes Familiar's scheme file.

## 7. Reap abandoned sessions

An agent that exits without `SessionEnd` can leave state behind. Run
`familiar reap` periodically, for example with a user systemd timer:

```ini
# ~/.config/systemd/user/familiar-reap.service
[Service]
Type=oneshot
ExecStart=/path/to/familiar/bin/familiar reap
```

```ini
# ~/.config/systemd/user/familiar-reap.timer
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
```

Enable it with:

```bash
systemctl --user daemon-reload
systemctl --user enable --now familiar-reap.timer
```

## Verify

Start a fresh supported agent session in a graphics-capable terminal. Its character
should change pose through a turn. On Niri, move the terminal between workspaces and
confirm `niri-windows.json` changes; if desktop moments are enabled, finish or fail a
turn to see the focused-output animation. Toggle Noctalia's dark mode to confirm the
scheme file follows it.
