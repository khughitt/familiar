---
id: fam-dabf43
title: Confirm CI passes the worktree identity work on its first push
status: doing
priority: 2
size: xs
complexity: low
process: direct
owner: fix/ci-green
created: 2026-10-08T10:54:48Z
updated: 2026-10-14T15:30:50Z
started: 2026-10-14T15:30:43Z
depends: []
parent: fam-74f6e9
tags: [identity]
agent: claude-code/claude-opus-5-5
---

main carries the worktree pin inheritance merge (e84b89d) and has not been pushed, so CI has never run it. On the first push check three things that could not be exercised locally: (1) the Ubuntu test job's new extractions/setup-just step (pinned to the v4 SHA, just 1.58.0) installs just before npm, on Node 22 and 26; (2) the real just bench-hook recipe smoke in test/bench-hook.test.js passes there; (3) the macOS job's new real-Git tests in test/identity.test.js pass on APFS, especially the checkout paths containing LF, CR and trailing spaces, plus the bare and separate-git-dir layouts. Done: all three green, or each failure fixed with a reproducing test.

## Notes

- 2026-10-14T15:30:43Z (main): started
  provenance: {"harness_session":"claude-code:b5ecf18c-f43a-46e9-b421-14c9ea7f96d4","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
- 2026-10-14T15:30:50Z (fix/ci-green): resumed
  provenance: {"harness_session":"claude-code:b5ecf18c-f43a-46e9-b421-14c9ea7f96d4","harness_session_source":"CLAUDE_CODE_SESSION_ID"}
