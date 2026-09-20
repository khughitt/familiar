---
id: fam-b148e3
title: Declare familiar's command table and conform to the shared CLI vocabulary
status: done
priority: 2
size: s
complexity: mid
process: direct
owner: main
created: 2026-09-20T11:30:32Z
updated: 2026-09-20T14:13:20Z
started: 2026-09-20T13:49:45Z
completed: 2026-09-20T14:13:20Z
depends: []
tags: [cli, cross-project]
agent: claude-code/claude-opus-5
---

Adopt the shared CLI vocabulary: vendor tools/cli.toml (and tools/cli_surface.py), make the parser conform, add the conformance test. The steps are Task 10 in the ops plan docs/plans/2026-09-20-cli-conventions.md (spec docs/specs/2026-09-20-cli-conventions-design.md). Waits for the ops table task ops-c9ecf0 to land on ops main; the ops step ops-bbd404 tracks this piece.

## Notes

- 2026-09-20T13:49:45Z (main): started
  provenance: {"harness_session":"claude-code:20e55bde-4aed-4a6f-993d-b44b058f509f","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-09-20T14:13:20Z (fam-b148e3): done
  provenance: {"harness_session":"claude-code:20e55bde-4aed-4a6f-993d-b44b058f509f","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-09-20T14:13:20Z (fam-b148e3): Declared familiar's command table in src/commands.js, conformed the CLI to the shared vocabulary (nested help, help routing, exit 2 on usage errors, -V/--version, --json/--pretty/--color, completion), and added the conformance test
  provenance: {"harness_session":"claude-code:20e55bde-4aed-4a6f-993d-b44b058f509f","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
