---
id: fam-053b0d
title: Paint familiar's project label in the project's tasks colour
status: idea
priority: 2
created: 2026-10-15T16:49:02Z
updated: 2026-10-17T21:02:33Z
depends: []
tags: []
agent: claude-code/claude-opus-5-5
---

Why: every registered project now has one authored colour, exposed by the tasks CLI as color on tasks where / tasks resolve / tasks projects JSON (ops-30b965). familiar shows a project label (basename of repo root or cwd, src/bus/identity.js:184-186) in the HUD/status line (src/render/term/statusfields.js:62, hud.js:102-108, the project: pen at hud.js:92) and in familiar whoami / familiar projects (bin/familiar.js:741-758,781,803; cells.js), coloured from its own slot ramp, never the project colour.

Open: whether the label should take the project colour while the pet keeps its identity hue (the slot ramp is a separate concept and stays); how to map a repo root to a prefix (tasks where <path>) and read the colour without a CLI call on every hook-bus render (cache, or resolve at session start); what an unregistered directory shows.

## Established (scope, 2026-10-17)

- Mapping is cheap and public: `tasks where <path>` returns `project.color` (`#bc8369` here) in ~10 ms, and `{"project":null}` with exit 0 for an unregistered directory. The colour is authored in each project's committed tasks/.config.toml, so a linked worktree resolves to its project too.
- The label is computed in the hook transaction (src/bus/transaction.js:170, `project: displayProject(...)`) on every event, beside the per-event Git discovery, and carried on the agent record into intent (bin/familiar.js:1055-1059). A colour resolved there can ride the record and be carried forward while `repoRoot` is unchanged, so only a session's first event (or a cwd move) pays the spawn; `just bench-hook` measures it.
- Consistent with the intent invariant (src/protocol/intent.js:12-13, identity owns colour): the project colour is identity, not state. Technical lean: unregistered → today's slot-ramp pen; `tasks` not installed (ENOENT) → the same, as familiar must run without tasks; any other `tasks` failure is surfaced, not swallowed.

## Open questions

Do you want the project label (HUD/status line, `whoami`, `projects`) painted in the project's tasks colour while the pet, the rule and the branch keep the slot hue, so one status line carries two hues? Yes makes this a direct, small task on the lean above; no drops it.

## Notes

- 2026-10-17T20:34:47Z (main): scope: question; body keeps the original text and records the established facts (tasks where ~10 ms, null for unregistered; label computed in transaction.js:170 and cacheable on the agent record) and one taste question: label in the tasks colour beside the slot-hued pet, yes or no; related to fam-60d716's drop and fam-74f6e9 (kept unparented, no goal created for one question); brief: docs/notes/2026-10-07-project-identity-brief.md
- 2026-10-17T21:02:33Z (main): answer (user, 2026-10-17): label and pet colour should be the same; one project colour source of truth used everywhere. Avoid tight coupling of familiar to ops (or whoever owns project colour assignment): either familiar optionally consumes colours from the owner, or the owner generates familiar's colour config
