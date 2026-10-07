---
id: fam-a877b3
title: "identities.yaml lives in familiar's config dir, not state"
status: idea
priority: 2
created: 2026-09-12T10:23:31Z
updated: 2026-10-07T13:06:43Z
depends: [fam-090b35]
parent: fam-74f6e9
tags: [dotfiles]
---

familiar writes identities.yaml into $XDG_CONFIG_HOME/familiar, which is a whole-directory symlink into the dotfiles tree shared over Dropbox. It is per-machine state (dotfiles gitignores it and now marks it com.dropbox.ignored, but a copy recreated on the other machine syncs back unmarked). Keep it under XDG_STATE_HOME/familiar; dotfiles then drops the ignore.

## Notes

- 2026-10-07T13:06:42Z (main): scope: briefed; retained original report; engine only reads the pin catalog, and dots-85a593 identifies atomic editor saves as the writer; fam-090b35 will distinguish authored choices from machine paths before relocation; brief: docs/notes/2026-10-07-project-identity-brief.md
