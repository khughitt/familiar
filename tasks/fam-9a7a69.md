---
id: fam-9a7a69
title: Verify FORCE_COLOR=3 fixes the 256-colour status line under tmux
status: idea
priority: 3
created: 2026-09-18T11:15:15Z
updated: 2026-09-18T11:15:15Z
depends: []
tags: [tmux]
agent: "claude-code/claude-opus-5[1m]"
---

Claude Code downgrades the status line to 256 colours under tmux: familiar statusline emits 38;2;R;G;B but the pane grid holds 38;5;141 for every placeholder run (80/80 repaints), with COLORTERM=truecolor set in Claude Code's own environment. Kitty would read image id 141, so the cat cannot bind under tmux until this is worked around. Untested: FORCE_COLOR=3 in the tmux environment (docs/specs/2026-09-18-tmux-rendering-design.md §7.2). Outcome: measured result recorded here; if it works, docs/install.md's tmux checklist names it.
