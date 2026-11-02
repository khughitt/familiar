# Surfaces: current full-colour graphics

Familiar separates state from rendering. Agent events update the shared intent;
each surface renders the full-colour state image in the form it owns. That keeps the
core independent of frontend and desktop integrations.

## Shipped surfaces

The lifecycle claims below now describe Linux and macOS. macOS has a CI-backed
portable core, and its live-hook ancestry gate closed on 2026-08-23
(`docs/ref/2026-08-23-macos-agent-process-spike.md`), on which evidence the
Darwin adapters were activated. Familiar-rendered terminal output on macOS is
confirmed for Claude Code and Codex in Kitty and Ghostty by the physical terminal
gate of 2026-08-24 (`docs/ref/2026-08-24-macos-terminal-smoke.md`); the OpenCode
sprite renderer remains provisional, having failed that gate on two defects that
have since been fixed but not yet re-tested on hardware.

| surface | state source | current contract |
| --- | --- | --- |
| terminal | Relay lifecycle events through `familiar observe` | Kitty-graphics-capable terminals receive the current full-colour image. |
| Claude Code | Relay lifecycle hooks and `familiar statusline` | The status line owns the cells; Familiar's observer replaces the image beneath them on state changes. |
| agy | Relay lifecycle hooks and `familiar statusline` | As for Claude Code: agy's custom status line passes the cells through intact (it rewrites `ESC[39m` as `ESC[m`, which does not touch them). agy's settings are hq's, so pointing its `statusLine` at `familiar statusline` is wired there, not by Familiar's installer. |
| Codex | Codex native pet state | `familiar install pets` writes every configured theme as Codex pets; Codex selects its native animation track. |
| OpenCode | Relay server plugin and Familiar TUI plugin | Relay supplies lifecycle events; Familiar's observer publishes presentation state and its TUI plugin draws the full-colour graphic. |
| Niri desktop moments | `attention.json` | `integrations/niri-desktop` plays one click-through moment per reserved input, approval, error or finished-turn episode on the focused output. |
| Noctalia workspace pills | `attention.json`, `niri-workspaces.json` | `integrations/noctalia-plugin` marks each workspace with its agents' attention and dismisses it on request (`docs/attention.md`). |
| Niri window signals | `intent.json` | `familiar-niri watch` lights each terminal's niri-material glass in its session's identity hue. |

The sprite contract is six full-colour state images plus `rows` for each member of a
theme, which also declares each member's roles and one `default` member. A theme may add
a world: one image per locale, all one `size`, each with the `places` (floor positions in
image pixels, in fill order) where members stand. Every session shows the `home` locale.
The same contract is used by terminal, status-line, Codex, OpenCode, and desktop
surfaces. Terminals draw the one resolved member; a world is carried on the identity in
`intent.json` for composed surfaces, which place agents by their `admitted` order.

## Terminal and status-line ownership

Graphics must be placed in cells the frontend owns. Claude Code's status line is the
supported surface because it lays out and repaints those cells itself. Relay invokes
`familiar observe`, which transmits a changed pose without printing cells;
`familiar statusline` prints the stable cell box. This keeps graphics out of
transcript content and lets a state change
replace the image in place.

Claude Code polls the status line every `refreshInterval` for every open session, so
`familiar statusline` caches each session's rendered line under
`$FAMILIAR_STATE_DIR/statusline-render/`. A poll whose inputs are unchanged (the HUD
fields from the payload, git, the claimed or retained task and its stage; the session's
bus record, which carries the agent count, the family and the role; `config.yaml`, with its
`families:`, `scheme.json` and `identities.yaml`; every installed theme's `theme.yaml`, in the
user and shipped theme directories, so adding, replacing or removing a theme or editing a
pack's roles, rows or world is a miss; the session's transmit ledger) prints the cached line
without loading the renderer. An entry also expires when a `done` or `error` intent decays,
and after 30 s in any case, which bounds how long the inputs the key does not cover take to
reach the line: a pack's sprites and world images (a world image deleted under a cached line
faults within 30 s), familiar's own code, symlinks under a pinned or recorded path, and
another session's malformed entry in the sessions file. `--with` output, a
faulted line (a world that fails proof included), an image still awaiting its settle, and a
payload with no `session_id` are
never cached; `familiar reap` removes the entries of sessions no longer on
the bus. Anything new the HUD shows must reach it through `readFields`
(`src/render/term/statusfields.js`), which the key covers, or it stays stale for up to 30 s.

The status line's state slot may add the session's task stage (its flow gate, else its
tasks status or park) and a count of the agents relay reports, as in
`▎ ⚡ working · designed · 2 agents`. `verified` is the gate flow recorded, not a check of
the current tree. The count is reported work, refreshed on `Stop`, not proof the session is
waiting on it. A finished or parked task stays on the line, with its outcome, until the
session claims another (`familiar reap` drops it once the session is gone). The stage reads
tasks' park store at a path predicted from tasks' private layout; `node
test/host/tasks-park-store.mjs` checks that prediction against the installed `tasks`, so run
it after a tasks upgrade. The task and its stage reach the line through `readFields`, so the
render cache above keys on them: a stage change shows on the next poll, and every poll
(cached or not) starts the stage's detached refresher when its stage cache is stale.

agy's custom status line works the same way. Its stdin has Claude Code's shape, with
`product: "antigravity"` and the conversation UUID as `session_id`, which is the id relay
publishes as `agy:<uuid>`; the status line and the hook therefore derive the same image id.
Until a conversation exists, agy sends an empty `session_id` and the status line prints the
uncoloured HUD with no cells. Not yet observed: agy under tmux, during its overlay panels,
and on resize with an image transmitted.

Kitty and Ghostty support the same graphics protocol. Inside tmux, familiar asks the
server before drawing: the pane must have `allow-passthrough all` (not `on`, which drops
escapes while the pane is hidden and would leave a stale cat in a background window), and
the attached client must be Kitty or Ghostty. Every graphics command is then wrapped in
DCS passthrough. Known limits: tmux 3.7c redraws placeholders correctly only in
full-width panes (an upstream combining-character bug), Claude Code's status line arrives
at 256 colours under tmux (`FORCE_COLOR=3` is an untested workaround), and attaching a
client shows the cat at the next state change, not on attach. With multiple attached
clients using different outer terminals, tmux may select one client for the probe; the
transmission ledger tracks that client's identity, and this multi-client case is not
addressed.

## Codex

Codex provides its own pet renderer. Familiar installs one pet per member of every
configured theme and supplies the full-colour spritesheet; Codex drives the visible pet from
its own state. Relay owns Codex's lifecycle hooks and invokes `familiar observe`
to update Familiar's shared intent. Codex alone draws the pet.

### Project-specific selection

The earlier global-only limitation no longer applies. Codex resolves `[tui] pet`
through its normal configuration layers, so a trusted project's
`.codex/config.toml` overrides the user-wide `~/.codex/config.toml`. This was first
measured on Codex 0.146 and reproduced on 0.149 on 2026-08-22 with an app-server
`config/read` probe: the effective value was `custom:project-specific`, and its
reported origin was the project `.codex` directory.

Familiar writes one stable `custom:familiar-<theme>--<member>` pet id per member of
each configured theme. The double hyphen separates the two because an id never holds
one, so every pair has its own id (`forest-cats`/`ginger` and `forest`/`cats-ginger`
differ); Codex 0.166.0 loads and draws a pet so named, probed on 2026-11-02 by the
§6.1 rendering method. `familiar install pets` compiles that roster, stamping each
pet with a hash of the sheet it compiled so a later session can tell whether the art
belongs to the session's theme. The managed config is recognised by that per-theme text
only: a file naming a single-theme `custom:familiar-<member>` id is refused like any
unmanaged file (see [Codex pets](install.md#codex-pets) for the one-time removal).

The project's selection is then **maintained automatically**, with
[relay hooks and terminal ownership](install.md#codex-lifecycle-hooks) set up;
daemon-hosted hooks require launching `codex --no-daemon`. On relay's Codex
`session-start` event, `familiar observe` compares the theme and member it resolved
against the repository's managed `.codex/config.toml` and rewrites that one file
when they disagree. That file is the repository's face, read by every later launch,
so only a session with no role converges it: a session started with `FAMILIAR_ROLE`
prints `codex: session role "<role>" set — repository pet selection left unchanged`
and writes nothing.

In a Git worktree that file is the worktree's own, never the main checkout's,
and the member is the one its repository's pins choose: a worktree inherits the
main checkout's `path:` or `project:` pin unless it is pinned itself (see
[project identity and Git worktrees](install.md#project-identity-and-git-worktrees)).
The `.codex/config.toml` exclusion lives in the repository's shared
`info/exclude`, written once for all worktrees.

**A change takes effect on the next launch, not the current one.** Codex reads
`[tui] pet` when its TUI starts, and its `SessionStart` hook arrives only at the first turn
— measured on Codex 0.153.4, see
`docs/specs/2026-09-05-codex-identity-parity-design.md` §6.1. So the first Codex
session in a new repository still shows the previous selection, and a session
that never takes a turn is never repaired at all. `familiar install pets
--sync-projects` forces the same write immediately, for the current repository
and every `path:` entry in `identities.yaml`, when waiting for a launch is not
what you want.

Convergence refuses rather than guesses: it will not select a member whose pet is
missing, incomplete, or compiled for another theme, and it never rewrites a
tracked or unmanaged config. Each of those prints one line naming the remedy.
Tracked project configs remain project-owned; `familiar whoami <project>` reports
the assigned member for manual configuration. The project must be trusted for
Codex to read its config at all, and a `.codex/config.toml` nearer the directory
you launch from, or a `-c` flag, still outranks the managed one. A separate
Claude-style renderer is therefore unnecessary.

Official OpenAI documentation now covers [terminal pets][codex-pets] and confirms
that trusted projects can supply [project-scoped configuration][codex-config], but
the configuration reference still omits `tui.pet`. The focused documentation issue
[openai/codex#36758][codex-project-pet-issue] remains open with no comments or
updates since 2026-08-03.

### Upstream activity since 2026-08-03

- No functional terminal-pet code changed through 2026-08-22. The only merged PR
  touching `codex-rs/tui/src/pets` was [#39028][codex-pet-test-cache], which only
  caches a test fixture.
- The terminal lifecycle bug [#33458][codex-pet-lifetime] remains open with no
  activity after Familiar's 2026-08-03 reproduction. The newer desktop report
  [#38998][codex-desktop-pet-lifetime] describes the same visible symptom—returning
  to idle while work continues—but does not affect project selection.
- The custom-animation proposal [#20863][codex-pet-animation] remains open. Its
  August discussion adds evidence for richer state playback and more than eight
  frames per state; it does not add or remove project-scoped pets.

## OpenCode

OpenCode uses relay's server plugin for lifecycle events and Familiar's TUI plugin
for the full-colour graphic. Relay invokes `familiar observe` to derive Familiar's
presentation state from its registry; the TUI renderer reads `intent.json`.
`relay install --harness opencode` installs the server plugin, while
`familiar install opencode` registers only the TUI renderer and removes Familiar's
retired server entry when ownership is verifiable. Unrelated entries are preserved;
JSONC configurations and unverifiable entries need manual edits as described in
the [OpenCode setup](install.md#opencode).

## Niri integrations

`familiar-niri watch` maps agent sessions to Niri windows and workspaces, writing
`niri-windows.json`. The watcher is the sole writer because a window can move after
its session begins. The retained feed is workspace awareness for external consumers;
the desktop-moments renderer does not depend on it.

On niri-material, the same watcher also writes each terminal's `familiar` signal slot
(`niri msg set-window-signal`), so the glass ring takes that window's identity hue.
Identity sets the accent; state sets the level (`working` is `active`, other `none`
urgency is `quiet`) and the motion, under `motion: full | reduced | off`. Several
sessions in one terminal share one slot, won by the highest level and then the most
recent session. A transient `done` or `error` hands niri its successor and time left,
and a transition into either sends a matching pulse. Windows that no longer host a
session are cleared, by niri's own record, so a restarted watcher leaves no stale hue.
On a niri without window signals the watcher says so once and writes only the map.

`familiar-niri watch` is also the desktop attention coordinator: it attributes each
agent's requests to the workspace hosting it, publishes the workspace feed and a
heartbeat, and sends desktop toasts (`docs/attention.md`).

`integrations/niri-desktop` consumes the shared attention episodes rather than watching
state transitions: it claims one eligible episode at a time through
`familiar attention popup`, finds the focused output through Niri and presents a short
click-through moment with that episode's state art. What it already shows when it
starts is history and is not played; moments follow `motion: full | reduced | off`.

## Tone

Familiar's colour scheme is an explicit input. `familiar scheme set` writes it
directly, and `familiar-noctalia scheme-sync` is the Noctalia adapter that updates it
when dark mode changes. The adapter is deliberately separate from the core so another
tone source can provide the same file contract.

## Scope

The current product is the full-colour graphics and the Niri workspace and desktop
integrations above. The 2026-08-08 retirement design records why earlier
project-identity surfaces were removed; it is historical decision context, not setup
guidance.

[codex-config]: https://learn.chatgpt.com/docs/config-file/config-reference
[codex-desktop-pet-lifetime]: https://github.com/openai/codex/issues/38998
[codex-pet-animation]: https://github.com/openai/codex/issues/20863
[codex-pet-lifetime]: https://github.com/openai/codex/issues/33458
[codex-pet-test-cache]: https://github.com/openai/codex/pull/39028
[codex-pets]: https://learn.chatgpt.com/docs/pets
[codex-project-pet-issue]: https://github.com/openai/codex/issues/36758
