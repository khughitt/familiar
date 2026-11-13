# Surfaces

Type: guide; document types 1. Understand which process owns each rendering
surface, supported combinations and diagnosis. See [install](install.md),
[configuration](configuration.md), [terminal rendering](terminal-rendering.md)
and [desktop attention](attention.md) for procedures and contracts.

## Surfaces

Relay owns lifecycle hooks, process admission and its registry. Familiar observes
that registry and publishes presentation intent; renderers own the space they draw.

| Surface | Owner and input |
| --- | --- |
| Terminal | Observer transmits the resolved image on lifecycle changes to a supported terminal. |
| Claude Code | Familiar statusline prints owned cells; the observer replaces the image underneath. |
| agy | The same statusline arrangement; agy configuration is managed outside Familiar's installer. |
| Codex | Native pet renderer; Familiar installs sheets and maintains eligible project selections. |
| OpenCode | Relay server plugin supplies events; Familiar TUI plugin renders intent in its sidebar box. |
| Niri moments | Quickshell reserves eligible episodes from attention.json on the focused output. |
| Noctalia pills | Plugin reads attention.json and niri-workspaces.json, with trusted health. |
| Niri window signals | familiar-niri watch maps intent to each terminal's niri-material signal slot. |

Themes supply six full-colour state images and a member row count. Cast roles and
an optional world resolve through [family, role and world](configuration.md#family-role-and-world).
Terminal surfaces draw one member. Composed surfaces use the home locale and
admission order to choose its places; the theme package owns the asset contract.

## Platform support

Linux and macOS on Apple Silicon are supported targets; macOS terminal rendering
has narrower measured evidence. Live-hook ancestry was checked on a physical Mac
on 2026-08-23 for Claude Code, Codex and OpenCode in Kitty/Ghostty. A physical gate
on 2026-08-24 through 2026-08-28 confirmed Familiar terminal output for **Claude
Code and Codex**, Kitty 0.46.2/Ghostty 1.3.1, macOS 26.6.2, Node 22/25 only.
Those observations do not qualify newer versions or another terminal/platform.
Intel Macs, macOS 13 and other terminal combinations remain unclaimed.

OpenCode's own renderer remains provisional: that gate found a pose-change fault
and a missing approval mapping. Both fixes landed afterward but have not been
retested on physical hardware. Hook-side tint/bell passed the old gate. Fixtures
and current CI establish portable rules, not physical rendering or gestures.
Use the [terminal acceptance checklist](terminal-rendering.md#acceptance) before
relying on an unclaimed combination. Dated raw measurements remain private evidence.

## Terminal and statusline

Claude owns and lays out the placeholder cells in its statusline; Familiar does
not inject cells into transcript content. The observer transmits a changed image
without printing the box; the statusline prints the stable box. Its one transmit
exception settles a provisional SessionStart image under the same terminal locks.
The historical Claude observation was that permission prompts, autocomplete and
some menus hide the statusline, including its approval pose. Treat this as a
bounded frontend observation, not a universal promise for every future version.

Inside tmux, rendering requires `allow-passthrough all` and a Kitty/Ghostty client.
`on` loses hidden-pane writes. Each graphics command has its own DCS wrapper.
Known limits: tmux through 3.7c needs full-width panes for placeholder redraw;
Claude's statusline is reduced to 256 colours there (`FORCE_COLOR=3` is an untested
workaround). Attaching shows the pet on the next state change, not immediately.
Mixed-terminal multiple clients remain unaddressed; the ledger follows the client
the probe selected. [Transport and failures](terminal-rendering.md) gives the rules.

### Render cache

Each session's line is cached under `$FAMILIAR_STATE_DIR/statusline-render/`.
The key covers payload HUD fields, git, the claimed/retained task and stage, the
session bus row (including agent count/family/role), config, scheme, identities,
every installed user/shipped theme.yaml and the transmit ledger. A changed theme
roster, roles, rows or world descriptor is a cache miss.
Entries expire with a decaying done/error intent and after 30 seconds at most.
Changes to image bytes, Familiar code, symlinks under a pin/record, and another
session's malformed bus entry can therefore take up to 30 seconds to appear.
`--with`, a visual fault, unresolved settle and absent session_id bypass the cache.
`familiar reap` removes dead sessions' entries. New HUD inputs must reach
`readFields` in src/render/term/statusfields.js to be covered by the key.

The task stage is a recorded flow gate, task status or park, not a verification of
the current tree. Agent counts are relay's reported work refreshed on Stop, not
proof of a wait. Done/parked tasks stay visible until another claim or session reap.
The stage reader predicts tasks' private park-store path. After a tasks upgrade,
the separate installed-tool maintenance check `node test/host/tasks-park-store.mjs`
compares that prediction to the installed binary. This is not a portable suite run.
Each poll, cached or otherwise, starts a stale stage-cache refresher when needed.

agy uses Claude-shaped stdin with product antigravity and its conversation id;
relay uses that id prefixed agy:. Until an id exists there are no image cells,
only the uncoloured HUD. Its custom line's ESC colour-reset rewriting leaves the
placeholder cells intact. agy under tmux, overlays and resize is not yet observed.

## Statusline diagnostics

A cold macOS `git symbolic-ref` can exceed the 250 ms branch-field budget and show
a short commit id instead of a branch; it corrects itself once git is warm.
A missing bus identity still gives an uncoloured HUD. A malformed theme/world is
reported as a visual fault rather than guessed away. Diagnose config and theme
installation before assuming a frontend problem.

## Codex

Familiar emits no pet graphics into Codex: the native renderer chooses animation
tracks. `familiar install pets` compiles all configured themes into per-member
sheets; see [Codex setup](install.md#codex-pets). The compiler makes 1536×1872 sheets
with an 8×9 grid of 192×208 frames. Declarations and observed native selections
are different evidence; see [the native boundary](terminal-rendering.md#native-pet-boundary).

## Codex selection

Trusted project `<project>/.codex/config.toml` can override the user config. Familiar uses
stable `custom:familiar-<theme>--<member>` ids, separating theme/member to avoid
collisions. The compiler stamps the sheet hash; convergence refuses missing,
incomplete or differently compiled pets, and tracked/unmanaged project configs.
Old single-theme ids need the explicit [managed-file remedy](install.md#codex-pets).

On relay session-start, an unroled session converges its repository's managed
selection to the resolved theme/member. A session with FAMILIAR_ROLE leaves that
repository face unchanged. A worktree updates only its own config using inherited
pins; info/exclude is shared. Settings are read when the TUI starts, before the
first-turn SessionStart hook, so the correction takes effect on the **next launch**.
A session that never takes a turn never converges. `install pets --sync-projects`
forces current/pinned-path selections without waiting for a hook. Closer config
layers and explicit overrides still win, and project trust is required.
The daemon-hosted hook ancestry observed in Codex 0.160.1 requires `codex --no-daemon`
for attribution/convergence; native drawing does not depend on Familiar's observer.

## OpenCode

Relay's server plugin publishes lifecycle state; Familiar's TUI plugin reads
intent.json. Its sidebar rectangle owns normal image placements, reasserted in
the OpenTUI post-process frame callback. Timers only queue changes; they never
stream alongside the frontend. Combining-diacritic placeholders are not portable
through that layout path. TUI API integration is version-coupled; an isolated
fixture does not replace real-OpenCode acceptance. Install server then renderer;
JSONC/unverifiable entries require the [documented manual edits](install.md#opencode).

## Desktop

`familiar-niri watch` is the sole session-to-window/workspace map writer; windows
can move after startup. It publishes niri-windows.json for external consumers.
The popup does not depend on that retained feed. On niri-material, the watcher
sets the terminal's familiar signal slot: identity hue, state level/motion, with
highest level then newest session winning a shared terminal. Transient done/error
signals carry successor/time-left and a pulse. Closed/moved windows are cleared;
per-window command failures are isolated so the next pass can recover.
Desktop requests, popups, pills and toasts use [attention](attention.md), with
[supervised setup and recovery](runbooks/desktop-attention.md). These integrations
are Linux-only. Native urgency is separate from Familiar's attention markers.

## Interaction limits

Graphics placements provide no Familiar hit-testing or independent mouse input.
Claude and Codex own stdin; Familiar does not enable mouse capture there.
OpenCode also owns frontend input; new interaction would require a separate
feature through its APIs, not a Kitty-image click handler.

## Scope

Familiar separates lifecycle observation, identity/theme resolution and rendering.
It does not provide an image filter pipeline or arbitrary frontend animation UI.
The core takes an explicit [scheme input](configuration.md#scheme-and-motion);
Noctalia's adapter is optional. Proposed animation/filter/dashboard directions
and dated upstream-issue tracking are historical research, not shipped behavior.
