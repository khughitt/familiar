---
id: fam-f088b1
title: Verify OpenCode renderer fixes on macOS hardware
status: todo
priority: 2
size: m
complexity: mid
created: 2026-08-30T16:30:28Z
updated: 2026-09-12T16:42:29Z
depends: []
tags: [migration, macos]
spec: docs/specs/2026-08-22-macos-support-design.md
---

Outcome: OpenCode's sprite pose transitions and needs-approval state are verified in live Kitty and Ghostty sessions on the physical Apple Silicon Mac, earning or explicitly denying the renderer's current provisional claim.

Acceptance evidence: Re-run the corrected OpenCode cells from the macOS terminal gate after restoring the byte-level tee; record live state/bus observations and byte traces showing pose changes for distinct states and a needs-approval transition in both terminals, or preserve the provisional label with exact failures. Run the repository gate and update current support docs and the evidence note in the same change.

Sources: docs/specs/2026-08-22-macos-support-design.md (Remaining work and §11), docs/ref/2026-08-24-macos-terminal-smoke.md, docs/ref/2026-08-24-macos-terminal-gate-handoff.md, and docs/ref/2026-08-24-gate-runbook-amendments.md.

Uncertainty: The code fixes are merged and CI-backed, but neither has been exercised against a live OpenCode; the disposable tee must be restored or reimplemented before capture.

## Notes

- 2026-09-12T16:42:29Z (main): Complexity mid: read the macOS support design, terminal-smoke evidence, handoff and amendments; both OpenCode fixes are ancestors of HEAD and present in the renderer/binding. Acceptance is explicit, but restoring the disposable byte tee and interpreting live pose/approval evidence still require bounded judgment. Physical Mac access is an execution prerequisite, not a reason for high.
