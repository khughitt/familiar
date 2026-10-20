---
id: fam-ff5351
title: Status line shows the task id this session has claimed
status: idea
priority: 2
created: 2026-10-20T14:21:16Z
updated: 2026-10-20T14:21:31Z
depends: []
tags: [statusline]
agent: claude-code/claude-opus-5-5
---

When a session is working on a task it has claimed with `tasks start`, the status line names that task: instead of `hq  ⎇ main`, show `hq (hq-c6c847)  ⎇ main`. With no claim, the line is unchanged.

Where it would land: the identity slot of the HUD (`src/render/term/hud.js`, which currently renders project, then `⎇`, then branch), fed by `familiar statusline`, which gets `session_id` on stdin.

Open questions for scoping:
- Lookup. `tasks claims` (JSON) lists live claims with `session`, `root_session`, `worktree` and `id`. Match on the session id from the payload, or on the relay agent id once fam-6e8321 settles how familiar consumes relay identity. With `refreshInterval` set the statusline runs every few seconds, and `claims` reads every store, so it may need a cached or bounded read rather than a process spawn per render.
- Width. The project cap is 20 cells and the branch cap 26 (`CAPS`). Decide what gets truncated first when the task id is added.
- Several claims held by one session: show the most recent claim, or a count.
- Other harnesses. Codex's `status_line` in hq's `codex/config.toml` only takes built-in items, so this may be Claude Code only, unless Codex or pi turn out to accept a custom item.

Related: fam-8f0f2b (the status-line pet reflects the flow state).
