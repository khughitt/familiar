# Configuration

Type: guide; document types 1. Configure theme selection, project identity and
motion. Start with [installation](install.md); [surfaces](surfaces.md) describes
where those choices appear. Theme formats belong to the
[familiar-theme package](https://github.com/khughitt/familiar-theme), not this guide.

## Files and defaults

Familiar reads `~/.config/familiar/config.yaml`, `scheme.json` and `identities.yaml`.
`FAMILIAR_CONFIG_DIR` replaces that directory; `FAMILIAR_STATE_DIR` replaces the
state directory and must be absolute and nonempty. `FAMILIAR_THEMES_DIR` overrides
the shipped-theme search directory. User themes shadow shipped themes by id.
This engine ships no art. With no config file the default theme id is `cats`;
installing another theme does not select it. Set `theme:` explicitly to its id.

```yaml
theme: cats
families:
  guild: cats
  verifiably: plant-nooks
motion: full
```

Only `full`, `reduced` and `off` are valid motion policies; default is `full`.
Family keys and theme ids are validated; a family must map to a theme id, not an
array or another map. A configured but absent theme faults when that family is
resolved, rather than failing unrelated projects. Inspect with `familiar whoami`
and `familiar theme list`; [theme recovery](install.md#theme-recovery) explains
missing packs and receipts. Editing config is separate from theme installation.

## Project identity

A registered project's colour chooses its familiar as described below. Without
a project colour, a hash of the project's identity chooses its familiar;
`~/.config/familiar/identities.yaml` pins one deliberately by `remote:`, `path:`
or `project:` (basename). A Git worktree follows its repository: a pin on the main checkout applies to every
worktree of it, including one stored outside the checkout or reached through a
symlink, while an unrelated repository nested inside it never inherits. The
pin that wins is the first matching entry of the first tier that matches:

1. the effective `remote:` (normalized origin) of the checkout you are in;
2. `path:` of the current checkout;
3. `path:` of the repository's main checkout;
4. `project:` naming the current checkout's directory;
5. `project:` naming the main checkout's directory;
6. otherwise, the hash.

A matching `remote:` pin already covers every worktree and wins over any path
pin. To give one worktree its own familiar, pin that worktree by path; a
`project:` pin never beats a path. The winning pin is the whole choice: its slot
and its `members:` map.

- **Labels and keys.** A worktree keeps its own directory name as its label, so
  several working contexts stay distinguishable. Without a remote, the hash key
  is the main checkout's path, so a repository and its worktrees share one
  automatic familiar; moving or renaming a worktree does not change it.
- **Bare repositories.** A worktree of a bare repository takes the bare
  directory as its repository. Its name is kept verbatim (`familiar.git`
  matches `project: familiar.git`, not `project: familiar`), and a bare
  directory named just `.git` contributes no repository name.
- **Separated Git metadata.** A main checkout whose metadata lives elsewhere
  (`git init --separate-git-dir`) works as is. Its worktrees need the real main
  checkout declared with `git config core.worktree <main checkout>`; until then
  every hook that discovers identity reports an error naming `core.worktree`
  (session-end hooks skip discovery). Metadata stored in a directory named
  `.git` elsewhere, as in `store/.git`, looks to Git like a repository at
  `store` and is not always detectable: declare `core.worktree` there too.
- **After upgrading.** Records from before the identity upgrades may lack a
  repository anchor, `projectColor`, `family` or `role`. They leave the bus until each session's
  next hook re-admits it; a status line may show no identity until then. Pins
  are untouched.

## Family, role and world

A family is a named set of projects. A project declares its family in a family file at
its registered root (the `root` that `tasks resolve` returns, so a worktree whose branch
predates the file still has the family): `tools/family.toml`, else `family.toml`, the
first that exists. Familiar reads one key, `name`, an id (lowercase letters and digits
joined by single hyphens). A project with no family file has no family. A file that
cannot be parsed, a `name` that is not an id, a file over 65536 bytes, or a symlink or
path that leaves the root is an error: the hook prints one line and writes nothing.
The family is read once per session and checkout, with the colour.

The family selects the theme. `config.yaml` names the default theme and maps families to
themes:

```yaml
theme: cats
families:
  guild: cats
  verifiably: plant-nooks
motion: full
```

A family named under `families:` uses the theme it names; an unnamed family, or a
project with no family, uses `theme:`. Config is not checked against the installed
themes: a named theme that is not installed faults for that family's projects only.
A pin's `members:` map is keyed by theme id, so a pin applies to whichever theme the
family resolves to, and an entry for another theme is inert.

The theme's cast then gives the member. A member declares `roles:` in the pack, and one
member holds the reserved role `default`. A session's role is the environment variable
`FAMILIAR_ROLE`, an id, set by whatever launches the agent
(`FAMILIAR_ROLE=reviewer claude`); unset or empty means no role. An invalid value, or
`default` itself, is a refused event: the observer prints one error line, exits 0 and
writes nothing, so the session keeps its previous record. The member is:

| role | the theme holds the role | pin names a member of this theme | member | source shown |
| --- | --- | --- | --- | --- |
| none | not applicable | no | the `default` holder | `default` |
| none | not applicable | yes | the pinned member | `pin` |
| set | yes | either | the role's member | `role` |
| set | no | no | the `default` holder | `unmapped` |
| set | no | yes | the pinned member | `pin` |

A pin replaces the `default` holder for its project and never overrides a role the theme
covers. A role the theme does not cover is not a fault; `familiar whoami` shows
`unmapped` so a theme author sees which roles the cast lacks. The hue is the project's,
as in [Project colour](#project-colour); roles never change it.

```text
$ FAMILIAR_ROLE=reviewer familiar whoami
<project>
  family  guild · theme cats (family)
  role    reviewer · member <label> (role)
```

`family` shows `—` when there is none and `role` shows `—` when unset. A theme may
also carry a world: a background per locale, with places where members stand. Every
session shows the `home` locale. `familiar theme validate <dir>` prints a theme's roles
and the default member, and its world's locales with their place counts (or
`world none`). The identity in `intent.json` carries the family, theme, role, member
source and, when the theme has a world, the locale image and its places.

## Project colour

A registered project's colour comes from `tasks resolve`, so every Git worktree
shows the registered colour. The project label uses that exact colour, the
chrome uses its hue, and the pet uses the nearest hue slot (greys use the grey
familiar). A matching pin on a registered project with a colour must name that
slot; a conflict is an error naming both the pinned slot and the colour's slot.

Unregistered checkouts, projects without a colour, and hosts without `tasks`
(or with `tasks` off the hook's `PATH`) keep pins and the hash. When tasks
returns no colour, its warnings appear as `familiar: tasks:` lines. Familiar
reads the colour once per session and checkout: an edit in tasks reaches a
running session at its next checkout change or next session.
Use `familiar --color auto projects` for coloured swatches in a TTY; the CLI
defaults to plain output.


## Scheme and motion

```sh
familiar scheme set dark          # or light
familiar scheme set dark --sat 1
familiar-noctalia scheme-sync
```

`scheme set` writes `scheme.json` with `mode` and `satScale`. The Noctalia adapter
is a separate writer of that same input; set its dark-mode hook to the final
command when Noctalia should choose the scheme. Missing/invalid scheme data is
an explicit error. The core never asks a bar for its colours.
Motion policy controls presentation, not relay's lifecycle or attention state.
Desktop DND and unknown coordinator trust can further suppress transient effects;
see [attention](attention.md#delivery).

## Upgrade notes

Older session records without a repository anchor, colour, family or role leave
the presentation bus until the session's next hook re-admits it. Pins are preserved.
Colour/family metadata is read once per session and checkout: changes reach a
running session at its next checkout change or the next session.
For old hook/theme installations use [Upgrade](install.md#upgrade), not the fresh
setup commands as a rollback recipe.
