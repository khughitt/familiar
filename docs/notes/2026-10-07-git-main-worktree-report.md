# Draft Git report: separate Git directory reported as main worktree

Prepared during `fam-9ab24c`, 2026-10-07. Unpublished; sending this report
requires separate user approval.

[Git's contribution guidance](https://github.com/git/git/blob/master/.github/CONTRIBUTING.md)
directs bug reports to `git@vger.kernel.org`. The upstream checkout has no
root `AGENTS.md` or `CONTRIBUTING.md`, and its `.github` directory has no
issue template; its pull-request template also directs reports to the list.
This report follows the reproduction/expected/actual shape described by
[`git bugreport`](https://git-scm.com/docs/git-bugreport). It is a report,
not a proposed patch.

Subject: [BUG] worktree list reports separate Git directory as main worktree

Git version: 2.56.0, Linux. Reproduced with a temporary empty repository.

## Reproduction

Run with `sh`; every repository and worktree is inside the temporary directory.
The trap removes the fixture after the output is printed.

```sh
set -eu
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT HUP INT TERM

git -c core.hooksPath=/dev/null init -q -b main \
  --separate-git-dir "$fixture/metadata" "$fixture/primary"
git -C "$fixture/primary" -c core.hooksPath=/dev/null \
  -c user.name=Fixture -c user.email=fixture@example.invalid \
  commit -q --allow-empty -m fixture
git -C "$fixture/primary" -c core.hooksPath=/dev/null \
  worktree add -q --detach "$fixture/linked"

git -C "$fixture/primary" worktree list --porcelain
git -C "$fixture/linked" worktree list --porcelain
git -C "$fixture/primary" config core.worktree "$fixture/primary"
git -C "$fixture/linked" worktree list --porcelain
git -C "$fixture/metadata" rev-parse --show-toplevel
```

## Expected behavior

The first `worktree` record should name the actual main checkout,
`<fixture>/primary`, both before and after setting `core.worktree`, or the
documentation should explicitly explain why this layout cannot report that
checkout. The worktree manual says the main worktree is listed first.

## Actual behavior

All three listings start with `worktree <fixture>/metadata`, followed by
`HEAD` and `branch refs/heads/main`. The linked record correctly names
`<fixture>/linked`. After setting `core.worktree`, the final `rev-parse`
prints `<fixture>/primary`, but `worktree list` still names the metadata
directory as the main worktree.

The same result occurs with `worktree list --porcelain -z`; it is not a
quoting or newline parsing issue. A consumer cannot treat that first path
as an authoritative checkout directory in this layout.

An additional fixture put the separated metadata under `store/.git`. The
listing then named `store`, and `git -C store rev-parse --show-toplevel`
successfully named `store` until `core.worktree` declared the real primary.
Thus checking the listed path with `rev-parse` alone does not resolve every
separated-directory case.

## Source and prior search

On 2026-10-07, `get_main_worktree()` in Git's
[master](https://github.com/git/git/blob/master/worktree.c) and
[next](https://github.com/git/git/blob/next/worktree.c) derives the path from
the common Git directory and strips a `/.git` suffix. This accounts for the
observed separate-directory result even with `core.worktree` configured.

Searches of Git/GitGitGadget issues and PRs across states, indexed Git mailing
list discussions, and 2.54–2.56 release notes found no matching correction.
The related open [PR 2208](https://github.com/git/git/pull/2208) concerns
`repo info` path keys rather than this behavior. This is a bounded search,
not proof that no earlier report exists. No upstream build was run; the
master/next comparison is source inspection, not a reproduction on those
branches.

Is honoring the main checkout's `core.worktree` in this listing the intended
direction, or should consumers use another command to identify that checkout?
