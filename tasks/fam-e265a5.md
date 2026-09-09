---
id: fam-e265a5
title: Hook entrypoints must fail readably when dependencies are missing
status: done
priority: 1
size: s
owner: main
created: 2026-09-08T15:13:04Z
updated: 2026-09-09T09:03:06Z
depends: []
tags: [errors, hooks, bootstrap]
---

Found bringing europa (laptop) up to date on 2026-09-08 after ~3 weeks. With node_modules absent, every familiar hook died with a raw ERR_MODULE_NOT_FOUND, so Claude Code showed a continuous stream of 'PreToolUse:Bash hook error / Failed with non-blocking status code: node:internal/modules/package_json_reader:301' with nothing naming familiar or the fix. Outcome: bin/familiar detects missing dependencies and emits one line naming the project and the install command.

## Notes

- 2026-09-09T09:03:06Z (main): Only two entrypoints reach node_modules: bin/familiar and bin/familiar-opencode. familiar-niri and familiar-noctalia run clean without it, verified in a worktree with no node_modules. Both failing ones are now launchers over bin/familiar.js and bin/familiar-opencode.js; the check cannot live in those files because a missing bare specifier fails at resolution, before any of their code runs.
- 2026-09-09T09:03:06Z (main): bin/familiar and bin/familiar-opencode preflight src/deps.js and print one line naming familiar and the npm install command; verified against a tree with no node_modules.
