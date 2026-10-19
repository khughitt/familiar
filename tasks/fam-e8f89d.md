---
id: fam-e8f89d
title: "Point the macOS gate scripts at the relay consumer's state, not the retired agents.json"
status: todo
priority: 2
size: s
complexity: mid
process: direct
created: 2026-10-19T20:48:54Z
updated: 2026-10-19T20:48:54Z
depends: [fam-6e8321]
tags: []
source: "fam-6e8321 final whole-branch review: declined to judge tools/gate"
agent: claude-code/claude-opus-5-5
---

Why: once the relay consumer (fam-6e8321, feat/relay-identity) merges, familiar no longer writes agents.json, but tools/gate/gate-env.sh, gate-reap.sh, gate-status.sh and gate-watch.sh still read it. The macOS terminal gate that fam-f088b1 re-runs would then watch dead state. Done: each script reads familiar's sessions.json, or relay's registry where it needs agent identity, or is deleted if the gate no longer needs it; gate-reap.sh follows reap's relay prune plus reconcile; docs/ref/2026-08-24-gate-runbook-amendments.md matches, and the scripts stay labelled unsupported.
