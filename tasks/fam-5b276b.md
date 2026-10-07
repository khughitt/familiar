---
id: fam-5b276b
title: Session-end hook parks a task the session still claims
status: idea
priority: 2
created: 2026-09-09T12:39:44Z
updated: 2026-10-07T13:09:53Z
depends: [tasks-08b9d5, tasks-56b450, tasks-724c9e]
parent: fam-2313e1
tags: [hooks]
---

When a coding-agent session ends while holding a live claim on a task that was not parked, the hook bus parks it with a placeholder next step and the session identity, so nothing is left silently open. Zero-keystroke complement to 'tasks park' (tasks-08b9d5): the agent skill only needs one rule, park before ending a turn that waits on the user, and the hook covers the case where it forgot. Depends on park existing in tasks.

## Notes

- 2026-10-07T13:09:52Z (main): scope: briefed; preserved source material; reused tasks-56b450 for policy ownership and tasks-724c9e for claim enumeration; task recovery should be a tasks policy consumer of relay, rather than a Familiar presentation write; explicit rerun after those findings; brief: docs/notes/2026-10-07-session-end-task-recovery-brief.md
