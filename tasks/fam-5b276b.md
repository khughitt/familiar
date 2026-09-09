---
id: fam-5b276b
title: Session-end hook parks a task the session still claims
status: idea
priority: 2
created: 2026-09-09T12:39:44Z
updated: 2026-09-09T12:39:44Z
depends: [tasks-08b9d5]
tags: [hooks]
---

When a coding-agent session ends while holding a live claim on a task that was not parked, the hook bus parks it with a placeholder next step and the session identity, so nothing is left silently open. Zero-keystroke complement to 'tasks park' (tasks-08b9d5): the agent skill only needs one rule, park before ending a turn that waits on the user, and the hook covers the case where it forgot. Depends on park existing in tasks.
