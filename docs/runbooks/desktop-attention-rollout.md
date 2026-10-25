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
the popup, started once with `familiar` missing from its `PATH`, makes at most one
`familiar attention popup` attempt every 2 s and recovers once `familiar` is back (its
backoff and never-started-request release are only checked statically in the suite);
right click dismisses (or, if it is intercepted, the Alerts panel does); middle click
opens settings; the popup takes no keyboard focus and is click-through; pills render in
both bar orientations. This proves layout and gestures only in the nested session.

## 4. Supervised coordinator (approval: "start the attention coordinator")

Stop the unsupervised watcher started by Niri, then start one transient user service:

```sh
pkill -f '[f]amiliar-niri watch'
systemd-run --user --unit=familiar-attention --service-type=exec \
  --property=Restart=on-failure --property=RestartSec=2 \
  --property=StartLimitIntervalSec=60 --property=StartLimitBurst=5 \
  --working-directory="$HOME" -E HOME="$HOME" -E NIRI_SOCKET="$NIRI_SOCKET" -E PATH="$PATH" \
  "$(command -v familiar-niri)" watch
```

Readiness, within 10 s, read from what the unit itself published (a DND check from this
shell would not prove the unit's environment can reach Noctalia):

```sh
familiar attention status | jq -r '.health.status, .desktop.status, .desktop.dnd'
# healthy / known / on|off   (status stays "unknown" until the coordinator's first pass;
#                            "unknown" DND drops every popup and toast, never replayed)
```

The start limit ends only fast crash loops: each start writes a fresh heartbeat, so a
coordinator that crashes right after starting would otherwise look healthy forever, and
with the limit such a loop ends in a failed unit, its heartbeat goes stale, and the bar
reports it. A coordinator that lives 15 s or more between crashes never reaches the
limit and restarts indefinitely. The heartbeat's crash history covers that case: two
crashes within ten minutes, which any loop with a period under about five minutes
produces, show the bar's "Agent alerts unstable" node and one notice. Rarer crashes are
not reported; read `journalctl --user -u familiar-attention` for them.

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
- Kill the coordinator, then freeze it (`kill -STOP`). Kill only the main process with
  SIGKILL: `systemctl --user kill --kill-whom=main --signal=SIGKILL familiar-attention`.
  A plain `systemctl --user kill` sends SIGTERM to the whole control group, which is a
  clean stop: the coordinator exits 0, `Restart=on-failure` does not restart it, and
  it is not counted as a crash. Within 10 s the bar shows "Agent alerts disconnected —
  toasts unavailable" and one notice (DND off); navigation keeps working; restart and
  `kill -CONT` recover without a backlog. The SIGKILL is also a counted crash: two
  within ten minutes show "Agent alerts unstable".
- Two outputs: the visible workspace on the other monitor stays unseen; output B's
  pill focuses output B's workspace while output A is focused.
- Latency: over 100 workspace switches, event to pill update p95 <= 100 ms and
  maximum <= 200 ms before the familiar widget replaces the built-in one for good;
  click-to-focus is measured separately.

Record each result on fam-9c8dd1 and ops-e40874. A duplicate native and familiar toast,
a missed request marker, or an undetected dead coordinator fails acceptance.

## Upgrade: the crash history (approval: "restart the attention coordinator, the Noctalia shell and the popup")

Merging the crash history changes the heartbeat to schema 2. Old readers reject it and
new readers reject schema 1, so the merge is an activation step: run the following
right after it, under that one approval. The CLI switches as soon as main changes; the
running coordinator, plugin and popup keep their loaded code until restarted.

Niri starts the watcher, Noctalia and the popup itself (`spawn-at-startup` and
`spawn-sh-at-startup` in its config). Relaunch each through Niri, so it lands in the
same scope with the same environment as at startup rather than in this terminal's
scope, and wait for the old process to exit first. The shell helper below stops a pid
and waits up to 10 s for it to be gone; define it once in the shell you run these in:

```sh
stop_and_wait() {  # stop_and_wait <pid>
  kill "$1"
  for _ in $(seq 100); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done
  echo "pid $1 still running after 10 s" >&2; return 1
}
```

1. Restart the coordinator. Where the `familiar-attention` unit exists:

   ```sh
   systemctl --user restart familiar-attention
   ```

   Where only the Niri-started watcher runs (a SIGTERM is now a clean stop that nothing
   restarts), stop it and relaunch it through Niri:

   ```sh
   stop_and_wait "$(pgrep -f '[f]amiliar-niri watch')"
   niri msg action spawn-sh -- '~/d/familiar/bin/familiar-niri watch'
   ```

2. Reload the plugin. Noctalia 5.3 has no plugin reload command: `noctalia msg` offers
   `plugin` (dispatches an event to an entry) and `plugins` (list, enable, disable,
   update, source), and no reload. Restart Noctalia instead. This restarts the whole
   shell, not only the plugin: the bar, the notification daemon and the panels are
   absent for a moment, and notifications pending at that moment may be lost. Stop it
   and relaunch it through Niri:

   ```sh
   stop_and_wait "$(pgrep -xo noctalia)"
   niri msg action spawn -- noctalia
   ```

3. Restart the popup, as in step 6, the same way:

   ```sh
   stop_and_wait "$(pgrep -f '[q]s -d -p .*/integrations/niri-desktop')"
   niri msg action spawn-sh -- 'qs -d -p ~/d/familiar/integrations/niri-desktop'
   ```

Two windows are transient. From the merge until the coordinator restarts, the old
coordinator writes schema 1: the old plugin reads healthy, but the new CLI's popup gate
is closed, so popups are lost with the bar reading healthy, and popup opportunities
queued meanwhile are suppressed at the next recovery, not replayed. From the
coordinator restart until the plugin and popup restart, each old consumer reads schema
2 as invalid: the plugin shows disconnected and sends its one notice, the old popup
shows nothing, and popup-eligible episodes from that window are suppressed when the
restarted popup starts, not replayed. Doing the three restarts together keeps both
windows to seconds. Confirm:

```sh
familiar attention status | jq -r '.health.status, .health.crashes'
# healthy / 0
```

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
