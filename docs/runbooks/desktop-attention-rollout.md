# Desktop attention: gated rollout and rollback

How the desktop attention code (`docs/attention.md`) goes live on one host, and how to
undo it. Code readiness is not desktop acceptance: every live step below needs the
user's approval at the moment it is taken, and the native pilot decides acceptance.
Coordination task: ops-e40874; code: fam-9c8dd1.

## Why integration is activation

On this host the live desktop runs familiar from the main checkout, not from a release:

- Niri starts `~/d/familiar/bin/familiar-niri watch` and
  `qs -d -p ~/d/familiar/integrations/niri-desktop` (dotfiles `niri/config.kdl`);
- `familiar` on `PATH` is an npm link into the main checkout;
- relay's observer entries (`familiar setup relay`) call that same `bin/familiar`.

Merging the branch into main therefore changes what the next hook, the next watcher
start and the next popup start run. Treat the merge as the first activation step, with
its own approval, not as ordinary local integration.

## Prerequisites (all before asking for the live desktop)

| Prerequisite | Owner | Status to check |
| --- | --- | --- |
| Native concurrency evidence (Claude parallel permission waits; whether a Codex root ends turns with workers active) and a disposition of the deferred "legitimate workers withhold completion" minor | hq-4c954d | Task closed with evidence; if ordinary overlap was observed, the policy is revisited first |
| Native agent toasts suppressed or filtered for covered events, relay `Notification`/permission/session hooks still firing, unrelated notifications intact; setting preimages and restore commands | hq-d6e13a | Reviewed diffs and captured-output checks |
| Bar, plugin link and startup diffs: plugin linked and enabled, `workspaces` replaced, supervised watcher, popup startup kept | dots-dfecf1 | Reviewable diffs with preimages |
| A bounded headless check of the plugin and popup in a nested compositor (gestures, layout, no keyboard focus) | this runbook, step 3 | Recorded result; no live desktop used |
| Branch reviewed, suites green (`just test`), `tasks check` clean | fam-9c8dd1 | Final report |

## 1. Capture preimages (read-only)

```sh
pre="$WORK_ROOT/familiar/fam-9c8dd1/rollout-preimage-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$pre"
cp -L ~/.config/noctalia/config.toml "$pre/noctalia-config.toml"
cp -L ~/.config/niri/config.kdl "$pre/niri-config.kdl"
ls -la ~/.local/share/noctalia/plugins > "$pre/noctalia-plugins.txt"
git -C ~/d/familiar rev-parse HEAD > "$pre/familiar-main.txt"
pgrep -af 'familiar-niri watch|niri-desktop' > "$pre/processes.txt"
systemctl --user list-units 'familiar*' --all > "$pre/units.txt"
sha256sum "$pre"/* > "$pre/SHA256SUMS"
```

Harness notification settings are captured by hq-d6e13a's own preimage step.

Check what Noctalia and Niri will actually run, before routing anything through them:

```sh
tr '\0' '\n' < /proc/"$(pgrep -xo noctalia)"/environ | grep '^PATH='
PATH="<that PATH>" command -v familiar      # must resolve; the plugin runs `familiar …`
command -v familiar-niri qs niri noctalia
```

If `familiar` does not resolve under Noctalia's `PATH`, the dotfiles change must make it
resolve (for example a stable link on that `PATH`) before the plugin is enabled. Never
point a shared launcher at a worktree.

## 2. Integrate (approval: "merge desktop attention")

```sh
git -C ~/d/familiar merge --no-ff feat/desktop-attention
```

From the next hook on, the observer also writes `attention.json`. The running
coordinator and popup keep their old code until restarted (steps 4 and 6).

## 3. Headless check (no live desktop)

In a nested Niri session (or another nested compositor) with a throwaway
`FAMILIAR_STATE_DIR`, `HOME` and `NIRI_SOCKET`: link the plugin into that session's
Noctalia plugin directory, place `khughitt/familiar:workspaces`, start
`familiar-niri watch` and the popup, then drive one fake event per kind with
`familiar observe` envelopes. Record: left click focuses the clicked output's workspace;
right click dismisses (or, if it is intercepted, the Alerts panel does); middle click
opens settings; the popup takes no keyboard focus and is click-through; pills render in
both bar orientations. This proves layout and gestures only in the nested session.

## 4. Supervised coordinator (approval: "start the attention coordinator")

Stop the unsupervised watcher started by Niri, then start one transient user service:

```sh
pkill -f '[f]amiliar-niri watch'
systemd-run --user --unit=familiar-attention --service-type=exec \
  --property=Restart=on-failure --property=RestartSec=2 \
  --working-directory="$HOME" -E HOME="$HOME" -E NIRI_SOCKET="$NIRI_SOCKET" -E PATH="$PATH" \
  "$(command -v familiar-niri)" watch
```

Readiness, within 10 s, read from what the unit itself published (a DND check from this
shell would not prove the unit's environment can reach Noctalia):

```sh
familiar attention status | jq -r '.health.status, .desktop.status, .desktop.dnd'
# healthy / known / on|off   ("unknown" DND holds back every popup and toast)
```

Status, logs and stop:

```sh
systemctl --user status familiar-attention
journalctl --user -u familiar-attention
systemctl --user stop familiar-attention
```

From here until step 7 both the coordinator and the harnesses' native notifications
can announce the same event: expect duplicates in that window, and keep it short by
having hq-d6e13a's change ready to apply right after readiness passes.

A transient unit does not survive a reboot or a new Niri session. Making it start with
the desktop (and removing the old `spawn-sh-at-startup` line) is the dotfiles change.

## 5. Plugin and bar (approval: "enable the familiar bar plugin")

```sh
ln -s ~/d/familiar/integrations/noctalia-plugin ~/.local/share/noctalia/plugins/familiar
```

Enable `khughitt/familiar` the way `khughitt/prism` and `khughitt/wali-panel` are
enabled on this host, and in dotfiles `noctalia/config.toml` replace `"workspaces"` in
`[bar.default] start` with `"khughitt/familiar:workspaces"`. Validate before reloading:

```sh
noctalia config validate ~/.config/noctalia/config.toml
noctalia plugins lint ~/.local/share/noctalia/plugins/familiar
```

Middle click keeps opening the widget's settings; do not free it in the manifest.

## 6. Popup

Restart the popup so it runs the shared-attention consumer:

```sh
pkill -f '[q]s -d -p .*/integrations/niri-desktop'
qs -d -p ~/d/familiar/integrations/niri-desktop
```

## 7. Native toasts (approval: hq-d6e13a's change)

Apply hq-d6e13a's suppression. From then on the coordinator is the only producer of
agent-event toasts, so a dead coordinator must be visible: confirm step 8's
kill/freeze checks before leaving it in place.

## 8. Pilot (one host, one profile; approval to use the desktop for its duration)

One event per supported mapping, each checked for one marker, one popup opportunity and
one toast:

- Claude: input (idle prompt), approval, error, completion — focused and unfocused.
- Codex: root approval, worker approval (root marker survives worker activity), root
  completion, and a missing worker stop (withheld-completion diagnostic, no toast).
- OpenCode: approval (closed by the reply), error, completion through `done → idle`.
- Seen: visiting stops motion; requests stay static; errors and completions clear.
- Dismissal: right click and the Alerts panel; a request arriving meanwhile survives.
- DND on and unknown: nothing pops or toasts; markers stay; turning DND off replays
  nothing.
- Kill the coordinator (`systemctl --user kill familiar-attention`), then freeze it
  (`kill -STOP`): within 10 s the bar shows "Agent alerts disconnected — toasts
  unavailable" and one notice (DND off); navigation keeps working; restart and
  `kill -CONT` recover without a backlog.
- Two outputs: the visible workspace on the other monitor stays unseen; output B's
  pill focuses output B's workspace while output A is focused.
- Latency: over 100 workspace switches, event to pill update p95 <= 100 ms and
  maximum <= 200 ms before the familiar widget replaces the built-in one for good;
  click-to-focus is measured separately.

Record each result on fam-9c8dd1 and ops-e40874. A duplicate native and familiar toast,
a missed request marker, or an undetected dead coordinator fails acceptance.

## Rollback

```sh
systemctl --user stop familiar-attention
rm ~/.local/share/noctalia/plugins/familiar
cp "$pre/noctalia-config.toml" "$(readlink -f ~/.config/noctalia/config.toml)"
cp "$pre/niri-config.kdl" "$(readlink -f ~/.config/niri/config.kdl)"
git -C ~/d/familiar revert -m 1 <merge commit>     # or check out "$pre/familiar-main.txt"
~/d/familiar/bin/familiar-niri watch </dev/null >/dev/null 2>&1 &   # as Niri started it before
pkill -f '[q]s -d -p .*/integrations/niri-desktop'; qs -d -p ~/d/familiar/integrations/niri-desktop
```

Restore native notification settings with hq-d6e13a's restore commands. The attention
files in the state directory can stay; nothing reads them once the coordinator, plugin
and popup are gone.
