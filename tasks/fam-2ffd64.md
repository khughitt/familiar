---
id: fam-2ffd64
title: Assess and resolve inherited npm audit findings
status: todo
priority: 2
size: m
complexity: mid
process: direct
created: 2026-10-19T16:49:42Z
updated: 2026-10-19T16:50:01Z
depends: []
tags: []
source: fam-6e8321
agent: codex
---

The relay consumer clean-install proof recorded inherited npm audit findings that are outside the migration scope. Assess actual exposure and apply the smallest compatible dependency updates; do not assume audit severity proves exploitability or force an unrelated OpenTUI major upgrade.

Baseline (2026-10-19): five affected packages (3 critical, 1 high, 1 low): seroval 1.5.6, solid-js 1.9.12, @opentui/solid 0.4.3, brace-expansion 2.1.4, and @babel/core 7.28.0. Solid/OpenTUI include transitive findings. npm audit suggests an OpenTUI major update; compare compatible lockfile updates before choosing that route.

Scope and acceptance:
- Read the attached audit and upstream search evidence, refresh the advisories, and trace reachable call sites and untrusted inputs for each underlying issue.
- Prefer compatible released fixes and lockfile refreshes; document any remaining advisory with evidence, mitigation and a release/upgrade trigger. Broader rendering API migration needs a separately scoped task if required.
- Verify a clean install and the project test front door (focused affected checks, just test-fast and just check), including OpenCode behavior if its dependency versions change. Record the post-change audit and disposition of every baseline finding.

Known upstream reports/fixes: Seroval thenable guard (patched 1.6.2) https://github.com/advisories/GHSA-p6vx-979v-rg4c; typed-array memory exhaustion (patched 1.6.3) https://github.com/advisories/GHSA-jp82-f5mq-hwhp; brace expansion DoS https://github.com/advisories/GHSA-q2hr-2g5m-vwhr and related GHSA-qhr7-859c-m2p7 / GHSA-6j4f-fj2g-mc7p; Babel source map file read https://github.com/advisories/GHSA-4x5r-pxfx-6jf8. Use released upstream fixes rather than carrying a local library patch.

Process: direct because the task is bounded exposure assessment and compatible dependency maintenance, with explicit acceptance criteria.

## Notes

- 2026-10-19T16:49:47Z (feat/relay-identity): concerns: fam-6e8321 extension — Assess inherited dependency advisories recorded during the migration clean-install proof; these were outside the completed migration scope.
- 2026-10-19T16:49:55Z (feat/relay-identity): Upstream checked before scoping: searched open and closed issues/PRs in lxsmnsyc/seroval (thenable), juliangruber/brace-expansion (denial), and babel/babel (sourceMappingURL); checked default/development branch names and package snapshots, changelogs where present, and recent releases. Known advisories already link fixes, so use released compatible upgrades rather than a local patch. Seroval main is 1.6.7 and next 1.3.2; its package changelog records the 1.6.2 thenable guard (https://github.com/lxsmnsyc/seroval/blob/main/packages/seroval/CHANGELOG.md). Brace main is 5.0.12, with existing reports https://github.com/juliangruber/brace-expansion/pull/65 and https://github.com/juliangruber/brace-expansion/issues/71; no root changelog was found. Babel main is 8.0.7, master core 7.10.2; source-map handling fix https://github.com/babel/babel/pull/17999 is in the search results. Refresh exact applicable versions during implementation. No local reproduction, patch or exploitability assessment was attempted.
- 2026-10-19T16:50:01Z (feat/relay-identity): attached: followup-audit.json (5782 bytes): npm audit baseline from the completed relay consumer worktree, 2026-10-19; vulnerability reachability remains unassessed.
