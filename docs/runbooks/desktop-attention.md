# Desktop attention operations

Type: guide; document types 1.

Reusable startup, diagnosis, native acceptance, restart, recovery and rollback for
[desktop attention](../attention.md). Code checks do not establish native desktop
acceptance. Every live step needs the host owner's approval at the time of use.

## Activation boundary

Set `familiar_main` to the verified stable installed checkout, not a worktree. Inspect
`command -v familiar familiar-niri qs niri noctalia`, relay observer entries and desktop
startup configuration. Updates to a runtime-linked checkout change the next hook;
loaded coordinator, shell/plugin and popup code changes only when each is restarted.
Treat installed code updates and restarts as activation steps under the applicable
host authorization. Never repoint a shared launcher at an evaluation worktree.

## Prerequisites

Prepare and review notification ownership/suppression with exact restoration commands,
bar/plugin/startup edits and preimages before using the desktop. Preserve relay's
Notification, permission and lifecycle hooks and unrelated notifications. Confirm
native attribution/concurrency evidence for the harness versions being accepted;
workers may withhold root completion. Record that limitation rather than infer a
completion from silence. Follow [testing](../testing.md) for focused checks and policy;
`test/attention-e2e.slow.test.js` covers fixture behavior, not native layout or gestures.
Complete the isolated check below before the approved native pilot.

## Preimages

Choose a durable private `$pre` directory before edits. Save exact bytes, modes,
symlink targets and existence for configuration, links and notification settings,
plus postimages after each edit. Record installed revision and process/unit state.
Absent targets must be restored as absent, and subsequent drift reconciled first.
The following read-only inventory assumes the named configurations already exist:

```sh
: "${pre:?set pre to a new durable private backup directory}"
mkdir -p "$pre"
cp -L ~/.config/noctalia/config.toml "$pre/noctalia-config.toml"
cp -L ~/.config/niri/config.kdl "$pre/niri-config.kdl"
ls -la ~/.local/share/noctalia/plugins > "$pre/noctalia-plugins.txt"
git -C "$familiar_main" rev-parse HEAD > "$pre/familiar-main.txt"
pgrep -af 'familiar-niri watch|niri-desktop' > "$pre/processes.txt"
systemctl --user list-units 'familiar*' --all > "$pre/units.txt"
sha256sum "$pre"/* > "$pre/SHA256SUMS"
```

Capture harness notification settings with their exact preimages and restore commands too.

Check what Noctalia and Niri will actually run, before routing anything through them:

```sh
tr '\0' '\n' < /proc/"$(pgrep -xo noctalia)"/environ | grep '^PATH='
PATH="<that PATH>" command -v familiar      # must resolve; the plugin runs `familiar …`
command -v familiar-niri qs niri noctalia
```

If `familiar` does not resolve under Noctalia's `PATH`, the dotfiles change must make it
resolve (for example a stable link on that `PATH`) before the plugin is enabled. Never
point a shared launcher at a worktree.

## Isolated check

First run the relevant focused checks through the checkout's documented test front door, following its execution policy. In particular,
`test/attention-e2e.slow.test.js` exercises real relay publication, observer capture,
coordinator attribution, popup protocol and plugin presentation without a compositor.
It does not prove native layout or gestures.

For those checks, use an isolated nested Niri session with its own `NIRI_SOCKET`,
Wayland display, D-Bus session and throwaway HOME/XDG directories. Do not use Niri's
`--session` flag: it imports the nested environment into the host's services. A nested
window on the live desktop still needs approval to use the desktop; use a headless
parent compositor for unattended work. Run the following in a terminal **inside that
nested session**, in a dedicated Bash shell, from the checkout being evaluated:

```sh
export repo="$PWD"
export qs_bin=$(command -v qs)
export demo=$(mktemp -d)
export HOME="$demo/home" XDG_CONFIG_HOME="$demo/config"
export XDG_DATA_HOME="$demo/data" XDG_STATE_HOME="$demo/state" XDG_CACHE_HOME="$demo/cache"
export FAMILIAR_CONFIG_DIR="$demo/familiar-config" FAMILIAR_STATE_DIR="$demo/familiar-state"
export FAMILIAR_THEMES_DIR="$demo/themes" RELAY_STATE_DIR="$demo/relay"
export DEMO_PID=$$                      # this nested terminal's long-lived shell
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME/noctalia/plugins" \
  "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$FAMILIAR_CONFIG_DIR" "$FAMILIAR_THEMES_DIR" "$demo/bin"
cp -R "$repo/test/fixtures/theme-pack" "$FAMILIAR_THEMES_DIR/fixture"
printf 'theme: fixture\nmotion: full\n' > "$FAMILIAR_CONFIG_DIR/config.yaml"
printf '{"mode":"dark","satScale":1}\n' > "$FAMILIAR_CONFIG_DIR/scheme.json"
ln -s "$repo/integrations/noctalia-plugin" "$XDG_DATA_HOME/noctalia/plugins/familiar"
# Only the popup uses this restricted PATH; no other familiar can mask its removal.
for tool in node niri; do ln -s "$(command -v "$tool")" "$demo/bin/$tool"; done
ln -s "$repo/bin/familiar" "$demo/bin/familiar"
```

Prepare a Noctalia config in this private `XDG_CONFIG_HOME`: enable
`khughitt/familiar` and put `khughitt/familiar:workspaces` in `[bar.default] start`,
as in Plugin setup. Validate it before starting this session's Noctalia. Keep DND off for
popup/toast checks; confirm the coordinator reports `healthy / known / off` using
Startup and readiness's status command with `"$repo/bin/familiar"`.

Publish before observing: an envelope alone does not create a relay registry row.
This function follows the end-to-end fixture, using the terminal shell as the live
stand-in agent and suppressing terminal graphics. It uses real process handles,
theme loading and observer capture; native harness ownership remains a Native acceptance check.

```sh
publish() {
  NATIVE_EVENT="$1" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { applyEvent, normalizeEvent, readSnapshot, createProcessOps } from 'relay';
import { observe } from './src/observe/run.js';
import { paths } from './src/bus/paths.js';
const pid = Number(process.env.DEMO_PID);
const processOps = createProcessOps();
assert.ok(processOps.handleOf(pid), 'nested terminal must still be alive');
const event = normalizeEvent('claude-code', process.env.NATIVE_EVENT,
  JSON.stringify({ session_id: 'nested-demo', cwd: process.env.HOME }));
const result = await applyEvent(event, { resolveSessionPid: () => pid,
  gitContext: async () => ({ remote: null, repoRoot: null }) });
const envelope = { schema: 1, type: 'event', subscriber: 'familiar', event,
  registry: { generation: result.snapshot.generation, revision: result.snapshot.revision },
  changed: result.changed, reaped: result.reaped };
const captured = await observe({ text: JSON.stringify(envelope), deps: {
  paths: paths(), relay: { readSnapshot }, relayProcess: processOps,
  adapterFor: () => ({ resolveSessionPid: () => pid, resolveTerminalPid: () => pid }),
  emitTransition: async () => ({ kind: 'unchanged' }),
} });
assert.equal(captured.exitCode, 0, captured.lines.join('\n'));
JS
}
publish SessionStart                 # establish the initial, quiet observation
```

Start `noctalia`, `"$repo/bin/familiar-niri" watch` and the popup in this private
environment. Run them under a harness that records their pids and reaps them on EXIT,
TERM and INT, including the coordinator's event-stream child; do not daemonize them.
For the popup failure check, launch a second Bash directly from the driver shell
(for example `kitty --config NONE /bin/bash --noprofile --norc`) so it inherits these
exported variables and the nested session's environment. A terminal opened from the
desktop menu will not inherit the driver's private environment. Remove only the
private link **before** the popup's first start:

```sh
rm "$demo/bin/familiar"
# Foreground in that child Bash; keep it running while the driver publishes events.
PATH="$demo/bin" "$qs_bin" --no-color --log-times -p "$repo/integrations/niri-desktop" \
  > "$demo/popup.log" 2>&1
```

Back in the driver shell, publish `Notification:permission_prompt` and wait until the
state has an eligible popup. Count only lines matching
`\[familiar-desktop\] (initialise|claim) (did not start|exited)` in `popup.log`, using
their timestamps: each failed request must be separated by at least 2 s of backoff.
A process that never starts takes a 2 s timeout **plus** that backoff (about 4 s per
failure), and must keep retrying rather than wedge. To inspect actual launch attempts,
start the popup under `strace -f -ttt -e trace=process,file -o "$demo/popup.trace"`;
include failed executable lookups, since a missing binary may never reach `execve`.
Do not count the per-PATH lookup syscalls as separate control requests.

Restore with `ln -s "$repo/bin/familiar" "$demo/bin/familiar"`, without restarting
the popup. Confirm failures stop and the queue resumes. Attachment may suppress the
episode already present; publish `UserPromptSubmit`, then a fresh
`Notification:permission_prompt` and require its popup to play once. For each remaining
kind, publish `UserPromptSubmit` before `Notification:idle_prompt` (input),
`StopFailure` (error), or `Stop` (completion). Move focus to another workspace before
publishing to check unseen markers and completion toasts.

Record: left click focuses the clicked output's workspace; right click dismisses (or,
if intercepted, the Alerts panel does); middle click opens settings; the popup takes
no keyboard focus and is click-through; pills render in both bar orientations. Keep
logs and results with the rollout task before deleting the private directories. These
checks prove layout and gestures only in the nested session.

## Startup and readiness

Stop the unsupervised watcher started by Niri, then start one transient user service:

```sh
stop_and_wait "$(pgrep -f '^([^ ]*/)?node .*/bin/familiar-niri watch$')" &&
systemd-run --user --unit=familiar-attention --service-type=exec \
  --property=Restart=on-failure --property=RestartSec=2 \
  --property=StartLimitIntervalSec=60 --property=StartLimitBurst=5 \
  --working-directory="$HOME" -E HOME="$HOME" -E NIRI_SOCKET="$NIRI_SOCKET" -E PATH="$PATH" \
  "$(command -v familiar-niri)" watch
```

Use the `stop_and_wait` helper in Restart and upgrade below. Check
`systemctl --user` availability before starting; if unavailable, stop and resolve
the host setup. A launch does not establish readiness.

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

From here until notification suppression both the coordinator and the harnesses' native notifications
can announce the same event: expect duplicates in that window, and keep it short by
having the reviewed notification-setting change ready to apply right after readiness passes.

A transient unit does not survive a reboot or a new Niri session. Making it start with
the desktop (and removing the old `spawn-sh-at-startup` line) is the dotfiles change.

## Plugin setup

```sh
ln -s "$familiar_main/integrations/noctalia-plugin" ~/.local/share/noctalia/plugins/familiar
```

Enable `khughitt/familiar` in Noctalia's plugin configuration, and in
`~/.config/noctalia/config.toml` replace `"workspaces"` in
`[bar.default] start` with `"khughitt/familiar:workspaces"`. Validate before reloading:

```sh
noctalia config validate ~/.config/noctalia/config.toml
noctalia plugins lint ~/.local/share/noctalia/plugins/familiar
```

Middle click keeps opening the widget's settings; do not free it in the manifest.

## Popup

Restart the popup so it runs the installed attention consumer:

```sh
stop_and_wait "$(pgrep -f '^([^ ]*/)?qs -d -p .*/integrations/niri-desktop$')" &&
niri msg action spawn-sh -- "qs -d -p $familiar_main/integrations/niri-desktop"
```

Use the `stop_and_wait` helper in Restart and upgrade below.

## Notification ownership

Apply only reviewed native-toast suppression with its saved preimages and restore
commands. Covered events must have one producer; unrelated notifications and relay
hooks remain intact. Expect duplicates between coordinator startup and suppression;
keep that window short. Prove the kill/freeze diagnostics below before relying on
Familiar as the sole producer of agent-event toasts.

## Native acceptance

One event per supported mapping, each checked for one marker, one popup opportunity and
one toast:

- Claude: input (idle prompt), approval, error, completion — focused and unfocused.
- Codex: root approval, worker approval (root marker survives worker activity), root
  completion, and a missing worker stop (withheld-completion diagnostic, no toast).
- OpenCode: approval (closed by the reply), error, completion through `done → idle`.
- Seen: visiting stops motion; requests stay static; errors and completions clear.
- Dismissal: right click and the Alerts panel; a request arriving meanwhile survives.
- Clicks during the 16 ms arrival and 200 ms pulse re-renders: repeat left and right
  clicks across those updates. The host drops superseded handlers; record any lost
  focus or dismissal, and verify a dismissal never targets a newer request.
- DND on and unknown: nothing pops or toasts; markers stay; turning DND off replays
  nothing.
- Kill the coordinator, then freeze it (`kill -STOP`). Kill only the main process with
  SIGKILL: `systemctl --user kill --kill-whom=main --signal=SIGKILL familiar-attention`.
  A plain `systemctl --user kill` sends SIGTERM to the whole control group, which is a
  clean stop: the coordinator exits 0, `Restart=on-failure` does not restart it, and
  it is not counted as a crash. Wait for a new healthy MainPID after SIGKILL, then
  obtain it with `systemctl --user show -p MainPID --value familiar-attention` and
  send SIGSTOP to that new pid (require it to be greater than zero). Within 10 s of
  its last heartbeat, plus the plugin's next 250 ms poll, the bar shows "Agent alerts disconnected —
  toasts unavailable" and one notice (DND off); navigation keeps working; restart and
  `kill -CONT <that new pid>` recover without a backlog. SIGKILL alone normally
  restarts within the health window, so need not show disconnected.
  The SIGKILL is also a counted crash: two
  within ten minutes show "Agent alerts unstable".
- Two outputs: the visible workspace on the other monitor stays unseen; output B's
  pill focuses output B's workspace while output A is focused.
- Latency: over 100 workspace switches, event to pill update p95 <= 100 ms and
  maximum <= 200 ms before the familiar widget replaces the built-in one for good;
  click-to-focus is measured separately, from click to the compositor's focus event.
  Record its p95 and maximum too: `familiar niri focus` cold start was measured at
  about 120 ms before socket work, so the feed-update budget does not establish
  click latency.

Obtain approval for the desktop window and record each result, harness/terminal
versions and captured evidence with the operation. No new native run is claimed here. A duplicate native and familiar toast,
a missed request marker, or an undetected dead coordinator fails acceptance.

## Restart and upgrade

When crossing the heartbeat schema-1/schema-2 boundary, old readers reject schema 2
and new readers reject schema 1. Under the applicable activation approval, restart
all three consumers immediately after installing compatible code. The CLI switches as soon as main changes; the
running coordinator, plugin and popup keep their loaded code until restarted.

Niri starts the watcher, Noctalia and the popup itself (`spawn-at-startup` and
`spawn-sh-at-startup` in its config). Relaunch each through Niri, so it lands in the
same scope with the same environment as at startup rather than in this terminal's
scope, and wait for the old process to exit first. The shell helper below stops one pid
(refusing an empty or multi-pid argument) and waits up to 10 s for it to be gone;
define it once in the shell you run these in:

```sh
stop_and_wait() {  # stop_and_wait <pid>
  case "$1" in
    ''|*[!0-9]*) echo "stop_and_wait: need exactly one positive pid, got: '$1'" >&2; return 1 ;;
  esac
  [ "$1" -gt 0 ] || { echo "stop_and_wait: pid must be positive" >&2; return 1; }
  kill "$1" || { echo "could not stop pid $1" >&2; return 1; }
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
   stop_and_wait "$(pgrep -f '^([^ ]*/)?node .*/bin/familiar-niri watch$')" &&
   niri msg action spawn-sh -- "$familiar_main/bin/familiar-niri watch"
   ```

2. Reload the plugin. Noctalia 5.3 has no plugin reload command: `noctalia msg` offers
   `plugin` (dispatches an event to an entry) and `plugins` (list, enable, disable,
   update, source), and no reload. Restart Noctalia instead. This restarts the whole
   shell, not only the plugin: the bar, the notification daemon and the panels are
   absent for a moment, and notifications pending at that moment may be lost. Stop it
   and relaunch it through Niri:

   ```sh
   stop_and_wait "$(pgrep -xo noctalia)" &&
   niri msg action spawn -- noctalia
   ```

3. Restart the popup, as in Popup, the same way:

   ```sh
   stop_and_wait "$(pgrep -f '^([^ ]*/)?qs -d -p .*/integrations/niri-desktop$')" &&
   niri msg action spawn-sh -- "qs -d -p $familiar_main/integrations/niri-desktop"
   ```

Two windows are transient. From the code update until the coordinator restarts, the old
coordinator writes schema 1: the old plugin reads healthy, but the new CLI's popup gate
is closed, so popups are lost with the bar reading healthy, and popup opportunities
queued meanwhile are suppressed at the next recovery, not replayed. From the
coordinator restart until the plugin and popup restart, each old consumer reads schema
2 as invalid: the plugin shows disconnected and sends its one notice, the old popup
shows nothing, and popup-eligible episodes from that window are suppressed when the
restarted popup starts, not replayed. Doing the three restarts together keeps both
windows to seconds. The anchored process patterns above match only the command's
argv, so they cannot match a `bash -c` script containing these instructions. They
assume Niri's documented startup arguments; if a lookup is empty or ambiguous,
inspect `ps -eo pid,args` and select the one verified process instead of widening
the pattern. Confirm readiness within 10 s after the three restarts:

```sh
familiar attention status | jq -r '.health.status, .health.crashes'
# healthy / 0
```

On the first schema-1 upgrade, expect one coordinator log line containing
`health record unusable; crash history reset`. A missing record starts empty without
that line; a restart after an unclean exit may legitimately report a nonzero crash
count. Downgrading across the heartbeat schema boundary crosses the same schema boundary in reverse
and requires the same three restarts immediately after the downgrade.

## Corrupt-state recovery

The observer and coordinator report a corrupt `attention.json` and leave its bytes
alone; the independent heartbeat may still look healthy. Preserve that file with the
operation record if needed for diagnosis, then remove only
`"${FAMILIAR_STATE_DIR:-$HOME/.local/state/familiar}/attention.json"`. Leave the other
state files and the relay registry intact. The next relay observation or reconcile
restores current requests as static markers, without popups, toasts or historical
completions. Confirm that observation succeeded and the requests appear; if none is
expected soon, trigger relay's normal reconcile with `relay reap` (requires the
familiar reconcile observer entry from `familiar setup relay` to be installed).

## Rollback

Stop the supervised coordinator (`systemctl --user stop familiar-attention`) and
wait for its processes to exit. Reverse only completed changes from this operation.
Verify exact postimages before restoring saved config bytes/modes or removing a new
plugin link. Preserve user drift separately and reconcile it; restore absent targets
by removing only what this operation created. Restore symlink destinations without
replacing unrelated links. Restore the compatible installed code/dependencies and
verified executable/plugin paths, rather than blindly reverting an unrelated merge.

Restore startup configuration and restart coordinator, whole Noctalia shell and
popup in the ordered Restart and upgrade procedure, with the appropriate old or new
schema readers together. Restore native notification settings with their saved
preimages and commands before leaving the machine without agent alerts. Confirm
readiness and no duplicate native/Familiar announcements. Attention state files may
stay: absent consumers do not read them. Keep evidence and rollback inputs through
the acceptance window.
