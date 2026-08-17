# Surfaces: current full-colour graphics

Familiar separates state from rendering. Agent events update the shared intent;
each surface renders the full-colour state image in the form it owns. That keeps the
core independent of frontend and desktop integrations.

## Shipped surfaces

| surface | state source | current contract |
| --- | --- | --- |
| terminal | Familiar hooks | Kitty-graphics-capable terminals receive the current full-colour image. |
| Claude Code | Claude Code hooks and `statusLine` | The status line owns the cells; hooks replace the image beneath them on state changes. |
| Codex | Codex native pet state | `familiar install pets` writes the selected theme as Codex pets; Codex selects its native animation track. |
| OpenCode | Familiar server and TUI plugins | The plugins render the full-colour graphic and publish intent for desktop moments. |
| Niri desktop moments | `intent.json` | `integrations/niri-desktop` plays click-through `done` and `error` moments on the focused output. |

The sprite contract is six full-colour state images plus `rows`. The same contract is
used by terminal, status-line, Codex, OpenCode, and desktop surfaces.

## Terminal and status-line ownership

Graphics must be placed in cells the frontend owns. Claude Code's status line is the
supported surface because it lays out and repaints those cells itself. Familiar's hook
transmits a changed pose without printing cells; `familiar statusline` prints the
stable cell box. This keeps graphics out of transcript content and lets a state change
replace the image in place.

Kitty and Ghostty support the same graphics protocol. Familiar declines to render
inside tmux because passthrough is a user setting the hook cannot verify.

## Codex

Codex provides its own pet renderer. Familiar installs one pet per current theme
member and supplies the full-colour spritesheet; Codex drives the visible pet from
its own state. Familiar's Codex hooks still publish lifecycle state for the shared
intent, but they do not draw the pet.

## OpenCode

OpenCode uses two plugins. Its server plugin turns OpenCode events into Familiar
lifecycle updates, while its TUI plugin draws the full-colour graphic. The install
command writes both registrations and leaves unrelated plugin entries intact.

## Niri integrations

`familiar-niri watch` maps agent sessions to Niri windows and workspaces, writing
`niri-windows.json`. The watcher is the sole writer because a window can move after
its session begins. The retained feed is workspace awareness for external consumers;
the desktop-moments renderer does not depend on it.

`integrations/niri-desktop` watches `intent.json` directly. On `done` or `error`, it
uses Niri to find the focused output and presents a short click-through moment. The
moment is skipped for the initial state and follows `motion: full | reduced | off`.

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
