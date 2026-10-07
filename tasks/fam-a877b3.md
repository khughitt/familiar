---
id: fam-a877b3
title: "identities.yaml lives in familiar's config dir, not state"
status: idea
priority: 2
created: 2026-09-12T10:23:31Z
updated: 2026-10-07T13:18:13Z
depends: [fam-090b35]
parent: fam-74f6e9
tags: [dotfiles]
---

familiar writes identities.yaml into $XDG_CONFIG_HOME/familiar, which is a whole-directory symlink into the dotfiles tree shared over Dropbox. It is per-machine state (dotfiles gitignores it and now marks it com.dropbox.ignored, but a copy recreated on the other machine syncs back unmarked). Keep it under XDG_STATE_HOME/familiar; dotfiles then drops the ignore.

## Notes

- 2026-10-07T13:06:42Z (main): scope: briefed; retained original report; engine only reads the pin catalog, and dots-85a593 identifies atomic editor saves as the writer; fam-090b35 will distinguish authored choices from machine paths before relocation; brief: docs/notes/2026-10-07-project-identity-brief.md
- 2026-10-07T13:18:13Z (investigate/pin-storage): finding: fam-090b35 traced a read-only authored catalog: slots/member overrides and remote/project selectors are portable choices; path selectors are host bindings. Recommend one catalog with optional explicit file-location override for local configuration, not blanket state relocation or merged catalogs. Detailed evidence and conflict/copy/verify/cutover/rollback contract are in docs/notes/2026-10-07-project-identity-brief.md; no relocation implemented. Re-scope this idea from that result.
