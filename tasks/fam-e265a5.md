---
id: fam-e265a5
title: Hook entrypoints must fail readably when dependencies are missing
status: todo
priority: 1
size: s
created: 2026-09-08T15:13:04Z
updated: 2026-09-08T15:13:04Z
depends: []
tags: [errors, hooks, bootstrap]
---

Found bringing europa (laptop) up to date on 2026-09-08 after ~3 weeks. With node_modules absent, every familiar hook died with a raw ERR_MODULE_NOT_FOUND, so Claude Code showed a continuous stream of 'PreToolUse:Bash hook error / Failed with non-blocking status code: node:internal/modules/package_json_reader:301' with nothing naming familiar or the fix. Outcome: bin/familiar detects missing dependencies and emits one line naming the project and the install command.
