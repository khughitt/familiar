---
id: fam-a877b3
title: "identities.yaml lives in familiar's config dir, not state"
status: idea
priority: 2
created: 2026-09-12T10:23:31Z
updated: 2026-09-12T10:23:31Z
depends: []
tags: [dotfiles]
---

familiar writes identities.yaml into $XDG_CONFIG_HOME/familiar, which is a whole-directory symlink into the dotfiles tree shared over Dropbox. It is per-machine state (dotfiles gitignores it and now marks it com.dropbox.ignored, but a copy recreated on the other machine syncs back unmarked). Keep it under XDG_STATE_HOME/familiar; dotfiles then drops the ignore.
