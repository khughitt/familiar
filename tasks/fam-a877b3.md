---
id: fam-a877b3
title: "identities.yaml lives in familiar's config dir, not state"
status: idea
priority: 2
created: 2026-09-12T10:23:31Z
updated: 2026-10-17T21:02:32Z
depends: [fam-090b35]
parent: fam-74f6e9
tags: [dotfiles]
---

familiar writes identities.yaml into $XDG_CONFIG_HOME/familiar, which is a whole-directory symlink into the dotfiles tree shared over Dropbox. It is per-machine state (dotfiles gitignores it and now marks it com.dropbox.ignored, but a copy recreated on the other machine syncs back unmarked). Keep it under XDG_STATE_HOME/familiar; dotfiles then drops the ignore.

## Established (scope, 2026-10-17)

- The premise that familiar writes the file is false: the engine only reads the catalog (`loadIdentities(paths.identitiesPath)`, src/bus/paths.js:19); the unmarked copy came from an editor's atomic save (dots-85a593).
- fam-090b35 classified the catalog as authored configuration, not state: slots and members are portable choices, and only `path` selectors bind to a host. It rejected a blanket move to state and recommended, if a local catalog is wanted, an explicit absolute `FAMILIAR_IDENTITIES_FILE` override (unimplemented) with the cutover contract in the brief.
- The live catalog (dotfiles `familiar/identities.yaml`) pins only `~/d/...` paths, and `~/d` is the dotfiles cross-host checkout convention; a pin for a directory absent on a host is inert. It is still gitignored and marked com.dropbox.ignored (checked 2026-10-17).

## Open questions

Should the catalog be one file shared by every host, or a separate file on each?
- Shared (lean): dotfiles tracks `familiar/identities.yaml` and drops its ignore entry and Dropbox mark; the same project gets the same familiar on every host (fam-74f6e9's goal) and there's no engine work, so this idea drops and the follow-up is a dotfiles task.
- Per host: implement `FAMILIAR_IDENTITIES_FILE` per the brief's minimum contract (tests in test/paths.test.js, test/pins.test.js, test/bin-familiar.test.js; docs/install.md), then wire it in dotfiles under a separate authorization.

## Notes

- 2026-10-07T13:06:42Z (main): scope: briefed; retained original report; engine only reads the pin catalog, and dots-85a593 identifies atomic editor saves as the writer; fam-090b35 will distinguish authored choices from machine paths before relocation; brief: docs/notes/2026-10-07-project-identity-brief.md
- 2026-10-07T13:18:13Z (investigate/pin-storage): finding: fam-090b35 traced a read-only authored catalog: slots/member overrides and remote/project selectors are portable choices; path selectors are host bindings. Recommend one catalog with optional explicit file-location override for local configuration, not blanket state relocation or merged catalogs. Detailed evidence and conflict/copy/verify/cutover/rollback contract are in docs/notes/2026-10-07-project-identity-brief.md; no relocation implemented. Re-scope this idea from that result.
- 2026-10-17T20:34:26Z (main): scope: question; rerun after fam-090b35's finding; body records the established facts (read-only engine, authored catalog, live catalog pins only ~/d paths) and one open question: one synced catalog (lean, dotfiles tracks it, no engine work) or a per-host catalog via FAMILIAR_IDENTITIES_FILE; brief: docs/notes/2026-10-07-project-identity-brief.md
- 2026-10-17T21:02:32Z (main): answer (user, 2026-10-17): shared — one identities.yaml for every host
