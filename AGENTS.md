# familiar (engine)

- `just test` runs the suite (`npm test`, i.e. `tools/test-runner.mjs fast`); every
  recipe records its wall time through `tools/tt`. `just check` is the pre-commit gate
  and `just gate` the pre-push one; install the hooks in a fresh clone with
  `git config core.hooksPath .githooks`.
- The theme contract lives in the `familiar-theme` package (git dependency);
  do not deep-import beyond its package export.
- Pre-split history and design docs: https://github.com/khughitt/familiar-archive (private archive)

## Tasks workflow

- Run `tasks prime` at the start of a work session and `tasks ready` before choosing work.
- Run `tasks start ID` before implementation, add concise notes as evidence changes, and close the task with a one-line result in the same commit as the work.
- Never edit `tasks/*.md` directly; use the `tasks` CLI for every task mutation.
- Before completion, run `tasks check`. Require zero errors and report every warning. Registration-only `unreachable_dep` and `cycle_unverifiable` warnings are environmental on machines without all referenced projects; resolve every other warning.
