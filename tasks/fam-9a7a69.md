---
id: fam-9a7a69
title: Verify FORCE_COLOR=3 fixes the 256-colour status line under tmux
status: todo
priority: 3
size: s
complexity: mid
process: direct
created: 2026-09-18T11:15:15Z
updated: 2026-10-01T12:50:37Z
depends: []
parent: fam-361178
tags: [tmux]
agent: "claude-code/claude-opus-5[1m]"
---

Why: the implemented tmux graphics transport cannot bind the cat when Claude converts its truecolour placeholder id to an indexed colour.

Question: Does FORCE_COLOR=3 inherited by a freshly started Claude process preserve familiar's RGB placeholder id through the status-line renderer under tmux?

Where to start: docs/specs/2026-09-18-tmux-rendering-design.md section 7.2; docs/install.md tmux checklist; docs/surfaces.md; src/render/term/statusline.js and test/tmux-pty.slow.test.js.

Bound: One isolated tmux server and a full-width Kitty pane with allow-passthrough all. Run a baseline with FORCE_COLOR absent and a fresh Claude process with FORCE_COLOR=3; record actual environment and versions. Keep NO_COLOR absent in both arms. Capture the status-line output, pane colour attributes and outer-client bytes, comparing the complete RGB image id (38;2;R;G;B), not just whether text is colourful. Confirm that the matching image binds after a state transition; distinguish colour failure from attach/startup or combining-character failure. Clean up the test server/processes; do not modify shared tmux configuration or a live agent's environment.

Expected result: Record evidence, pass/fail/inconclusive, and a recommendation on this task. If effective, replace the untested wording in install/surfaces/spec with the measured setup and version limits. If ineffective, record the negative result and retain the known limit without an invented workaround. No renderer rewrite or broader version matrix.

Ideas it wakes: None. This task supplies the colour prerequisite for attach-repaint validation; link its finding from docs/notes/2026-10-01-tmux-rendering-followups-brief.md.

## Original capture

Claude Code downgrades the status line to 256 colours under tmux: familiar statusline emits 38;2;R;G;B but the pane grid holds 38;5;141 for every placeholder run (80/80 repaints), with COLORTERM=truecolor set in Claude Code's own environment. Kitty would read image id 141, so the cat cannot bind under tmux until this is worked around. Untested: FORCE_COLOR=3 in the tmux environment (docs/specs/2026-09-18-tmux-rendering-design.md §7.2). Outcome: measured result recorded here; if it works, docs/install.md's tmux checklist names it.

## Notes

- 2026-10-01T12:50:36Z (main): scope: scoped; bounded FORCE_COLOR A/B experiment with colour-byte and image-binding checks; recorded negative results also satisfy the task
