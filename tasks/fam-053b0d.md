---
id: fam-053b0d
title: Derive familiar's identity colour from the project's tasks colour
status: doing
priority: 2
size: m
complexity: high
process: planned
owner: feat/project-colour
created: 2026-10-15T16:49:02Z
updated: 2026-10-18T01:25:42Z
started: 2026-10-17T21:09:21Z
depends: []
tags: []
agent: claude-code/claude-opus-5-5
spec: docs/specs/2026-10-17-project-colour-design.md
plan: docs/plans/2026-10-17-project-colour.md
---

Why: one project colour, used everywhere (user, 2026-10-17). Every registered project has one authored colour, the `color` key in its committed tasks/.config.toml (ops-b31634, assigned by ops-40f2a6 with ops bin/project-colors; familiar-pinned projects were kept within 18° of their slot hue), exposed by the tasks CLI as color on tasks where / tasks resolve / tasks projects JSON (ops-30b965, which depends on this task). tasks pretty output and hq sessions already paint it. familiar instead colours everything (pet member, HUD rule/label/branch, OSC 11 backdrop, whoami/projects) from its own slot of 12 (src/protocol/slot-hues.js → src/theme/ramp.js identityColors), chosen by pin or autoSlot(projectKey) in src/bus/resolve.js. The user wants the label and the pet to agree with the project colour, without tightly coupling familiar to whoever assigns colours.

Approach (decided 2026-10-17, over "the owner generates familiar's colour config"): familiar optionally consumes the colour from its owner, tasks, through the public `tasks where <repoRoot>` JSON (~10 ms; `{"project":null}`, exit 0, when unregistered; a linked worktree resolves to its project). Rejected alternative: ops/tasks writing identities.yaml pins — slots carry only 12 discrete hues, so the label could not show the exact colour without a new hex field; the generator would bake familiar's frozen slot table into ops; and a generated file would collide with the authored, dotfiles-tracked catalog (fam-a877b3 → dots-13aa63). Reading tasks/.config.toml directly is rejected too: it couples familiar to tasks' private file format.

Established constraints:
- Pet sprites are per-member art, not tinted: the pet's colour is its slot's family (12), so with 33 projects over 12 slots the pet can match the project colour only by family (nearest slot), while chrome (label, rule, branch, backdrop) can take the project hue exactly.
- The label is computed per hook event in src/bus/transaction.js:170 and carried on the agent record into intent (bin/familiar.js:1055-1059); a colour resolved there can ride the record and be carried forward while repoRoot is unchanged, so only a session's first event or a cwd move pays the spawn. `just bench-hook` measures hook latency.
- familiar must run without tasks installed (project identity brief constraints); unregistered or tasks-absent keeps today's slot behaviour; any other tasks failure surfaces rather than being swallowed.
- Identity owns colour (src/protocol/intent.js:12-13): the project colour is identity, not state.

Design must settle: how a project colour picks the pet's slot (nearest hue, low-chroma → slot 11) and whether familiar's ramp derives from the project hex or the label uses the hex itself (legible at 3:1 on dark and light per ops-40f2a6); what an identities.yaml slot pin means for a registered project once the colour is the single source (error on disagreement, ignore, or pins keep only member choice and unregistered projects); which entry points consume it (hooks/statusline, whoami, projects, codex install).

Done: for a registered project, familiar's label shows the project colour and its pet is the slot family the design maps that colour to, in the HUD, status line, whoami and projects; unregistered and tasks-absent checkouts behave as today; no measurable steady-state hook slowdown on `just bench-hook`; tests cover registered, unregistered, tasks-absent and tasks-failure paths. Then note ops-30b965.

Where: src/bus/transaction.js, src/bus/resolve.js, src/bus/pins.js, src/theme/ramp.js, src/protocol/slot-hues.js, src/render/term/hud.js and statusfields.js, bin/familiar.js (whoami/projects), src/install/codex.js; brief docs/notes/2026-10-07-project-identity-brief.md (rerun sections).

## Notes

- 2026-10-17T20:34:47Z (main): scope: question; body keeps the original text and records the established facts (tasks where ~10 ms, null for unregistered; label computed in transaction.js:170 and cacheable on the agent record) and one taste question: label in the tasks colour beside the slot-hued pet, yes or no; related to fam-60d716's drop and fam-74f6e9 (kept unparented, no goal created for one question); brief: docs/notes/2026-10-07-project-identity-brief.md
- 2026-10-17T21:02:33Z (main): answer (user, 2026-10-17): label and pet colour should be the same; one project colour source of truth used everywhere. Avoid tight coupling of familiar to ops (or whoever owns project colour assignment): either familiar optionally consumes colours from the owner, or the owner generates familiar's colour config
- 2026-10-17T21:04:23Z (main): scope: scoped; user answer (single project colour SoT, label and pet agree, loose coupling) applied: chose familiar optionally consuming tasks' public colour over the owner generating familiar config; retitled; body records the constraints (sprites untinted, so the pet matches by slot family) and what the design must settle; todo, m, high, planned
- 2026-10-17T21:09:21Z (main): started
  provenance: {"harness_session":"claude-code:65e74f70-bc90-420d-976b-bd39045ce213","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-17T21:09:52Z (feat/project-colour): resumed
  provenance: {"harness_session":"claude-code:65e74f70-bc90-420d-976b-bd39045ce213","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-17T21:30:17Z (feat/project-colour): design: spec drafted at docs/specs/2026-10-17-project-colour-design.md; builder check raised one question (tasks where reads a worktree's checked-out config: 38 of 49 worktrees report no colour), settled by switching to tasks resolve (registered colour, the one tasks paints); slot rule = nearest HSL slot hue, OKLCH chroma < 0.05 → slot 11, reproduces all 13 pins on registered projects; strict pin rule (disagreeing slot pin faults); awaiting user spec review
- 2026-10-17T21:30:31Z (feat/project-colour): review: spec round 1 — verdict: revise; findings: blocking 1, minor 3; reviewer: claude-code
- 2026-10-17T21:30:32Z (feat/project-colour): parked (waiting on user, review): user reviews docs/specs/2026-10-17-project-colour-design.md in .worktrees/project-colour (calls to check: strict pin rule, label exact hex with chrome at slot saturation, 19 pets change); on acceptance the agent writes the plan at docs/plans/2026-10-17-project-colour.md with writing-plans
  provenance: {"harness_session":"claude-code:65e74f70-bc90-420d-976b-bd39045ce213","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-17T22:33:10Z (feat/project-colour): review: spec round 1 — verdict: revise; findings: Important 1; reviewer: codex
- 2026-10-17T22:33:18Z (feat/project-colour): spec finding (Important): lines 102–106 suppress warnings on unregistered rows. Isolated tasks resolve probe: linked checkout with valid config returns resolved + color; invalid color in its overlay config returns unregistered + warning, exit 0. The proposed reader suppresses the failure and caches null. Forward warnings whenever no color is returned, including unregistered, and test this linked-project case. Review only; spec unchanged.
- 2026-10-17T22:34:21Z (feat/project-colour): review: spec round 2 — verdict: revise; findings: must-fix 1; reviewer: human
- 2026-10-17T22:34:22Z (feat/project-colour): resumed
  provenance: {"harness_session":"claude-code:65e74f70-bc90-420d-976b-bd39045ce213","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-17T22:35:16Z (feat/project-colour): spec revised for round 2: warnings forwarded whenever no colour is returned (unregistered rows included, the linked-project config-failure case), forwarded by every entry point; linked case added to tests
- 2026-10-17T22:35:25Z (feat/project-colour): parked (waiting on user, review): user re-reviews the round-2 fix in docs/specs/2026-10-17-project-colour-design.md §1 (warnings forwarded whenever no colour is returned) in .worktrees/project-colour; on acceptance the agent writes docs/plans/2026-10-17-project-colour.md with writing-plans
  provenance: {"harness_session":"claude-code:65e74f70-bc90-420d-976b-bd39045ce213","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-17T23:22:43Z (feat/project-colour): review: spec round 3 — verdict: accept; findings: none; reviewer: codex
- 2026-10-17T23:24:03Z (feat/project-colour): review: spec round 3 — verdict: accept; findings: none; reviewer: human
- 2026-10-17T23:24:04Z (feat/project-colour): resumed
  provenance: {"harness_session":"claude-code:65e74f70-bc90-420d-976b-bd39045ce213","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-17T23:35:12Z (feat/project-colour): plan: docs/plans/2026-10-17-project-colour.md, six steps fam-e0c282 → fam-577d64 → fam-e13178 → fam-0b2c16 → fam-a4f5d5 → fam-1b0712 (chained deps); suite insulated from host tasks via test/fixtures/fake-tasks on the runner PATH; reader passes --json explicitly (TASKS_FORMAT=pretty); awaiting user plan review and execution choice
- 2026-10-17T23:35:13Z (feat/project-colour): parked (waiting on user, review): user reviews docs/plans/2026-10-17-project-colour.md in .worktrees/project-colour and picks subagent-driven (recommended) or native execution; then the agent starts fam-e0c282 there, running the worktree baseline (just test-fast) before the first code change
  provenance: {"harness_session":"claude-code:65e74f70-bc90-420d-976b-bd39045ce213","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-18T00:39:09Z (feat/project-colour): review: plan round 1 — verdict: revise; findings: Important 1, minor 1; reviewer: codex
- 2026-10-18T00:39:16Z (feat/project-colour): plan findings: Important — Task 6 leaves prepareFixture/workerEnv with an empty tasks registry (suite fake also defaults to unregistered), so cached projectColor stays null and the registered slotForColor/hexToHsl steady-state work is never measured. Supply a controlled registered colour, assert the candidate actually carries it and performs one initial lookup then none, and run a minimal comparison with a warmup and later sample before the full sitting (the existing 1-sample/0-warmup pilot does not exercise warmed comparison gates). Minor — Task 6 Step 8 closes records after integration; close Task 6 and the parent on the branch after review/visual acceptance and before merging, as repository instructions require. Review only; plan unchanged.
- 2026-10-18T01:17:33Z (feat/project-colour): resumed
  provenance: {"harness_session":"claude-code:65e74f70-bc90-420d-976b-bd39045ce213","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-18T01:17:33Z (feat/project-colour): correction: my notes 'review: spec round 2 … reviewer: human' (22:34) and 'review: spec round 3 … reviewer: human' (23:24) duplicate the codex reviewer's own notes for the same reviews (22:33 round 1, 23:22 round 3); count those, not mine
- 2026-10-18T01:19:06Z (feat/project-colour): plan revised for round 1: bench answers a controlled registered colour (#317d01) via the fake tasks, proves it on the candidate record and intent, requires one lookup per context then none, runs a 1-warmup 1-sample compare before the full sitting; closeout moved before integration; checked tasks resolve resolves an external worktree (via git)
- 2026-10-18T01:19:07Z (feat/project-colour): parked (waiting on user, review): user re-reviews the round-1 revisions in docs/plans/2026-10-17-project-colour.md (Task 6 Interfaces, Steps 1-5 and 8) in .worktrees/project-colour and picks subagent-driven (recommended) or native execution; then the agent starts fam-e0c282 there, running the worktree baseline (just test-fast) first
  provenance: {"harness_session":"claude-code:65e74f70-bc90-420d-976b-bd39045ce213","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-18T01:25:42Z (feat/project-colour): review: plan round 2 — verdict: accept; findings: none; reviewer: codex
