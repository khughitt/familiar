---
id: fam-fb393c
title: Restore an installed theme from its receipt
status: idea
priority: 2
created: 2026-10-16T18:37:48Z
updated: 2026-10-17T21:13:43Z
depends: []
parent: fam-ebff9c
tags: [theme]
agent: claude-code/claude-opus-5
---

Theme receipts sync between hosts (dotfiles tracks `familiar/theme-receipts/`) but the pack content does not (`familiar/themes/` is gitignored, deliberately: the art is not the dotfiles' to carry). A host that has never installed the theme, or has lost it, therefore holds a receipt describing a theme that is not there, and every familiar invocation fails at theme resolution with a bare ENOENT on the themes dir.

Recovering today takes two manual steps: `theme add <url>` refuses with 'orphan receipt ... remove it first', so the receipt must be deleted by hand and the theme re-added. The re-add also resolves the source's current head rather than the commit the receipt names, so the restore is not faithful to the receipt unless the two happen to agree.

A `theme restore [ID]` (or teaching `theme add` to act on an orphan receipt) that reinstalls at the receipt's recorded commit would make this one command, and would make a new host's first setup the same command.

Observed on europa, 2026-10-16: receipt present at commit 08942fa, ~/.config/familiar/themes/ empty. Related: fam-2b8fff (update an installed theme in place).
