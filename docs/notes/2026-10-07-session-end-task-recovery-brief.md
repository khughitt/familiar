# Session end task recovery policy

Scoping handoff, 2026-10-07. Goal: fam-2313e1. Member: fam-5b276b.

## Problem

A session can end without recording the next action for a task it still claims.
The original idea proposes automatic parking with a placeholder next step.
Decide whether that fallback adds useful recovery, who owns it, and which actual
lifecycle event can safely release the claim.

## Current behaviour and evidence

At engine commit `cd9a82a`, `src/adapters/claude-code.js` maps `Stop` to
`done` and `SessionEnd` to removal. `src/bus/transaction.js` removes the
agent record and commits presentation state; `src/install/setup.js` generates
the hook commands. These paths do not invoke tasks or record a resumption action.
The idea was filed in `7cad909`, before relay extraction was scheduled.

`tasks-08b9d5` is done and records the park API: status is preserved, the
claim is released, and the next action is stored with session/worktree context.
Existing work now covers parts of the policy question: `tasks-56b450` decides
claim-guard ownership and completion rules, while `tasks-724c9e` compares
`tasks claims` with Stop-policy claim selection.

The prerequisite findings recorded on `tasks-56b450` distinguish Codex
controller Stop, worker SubagentStop and session exit. Worker SessionEnd is
excluded in that captured release; worker completion may allow continuation.
Those are recorded source findings, not a new live hook capture here.

## Constraints

`fam-6e8321` schedules Familiar as a presentation consumer of relay.
`tack-fd10db` schedules the claim-guard adapter at operator cutover. Adding
task-record writes to Familiar would cross that ownership boundary.

An end-event fallback cannot promise recovery from abrupt termination that
emits no event. It must preserve existing parks, target only the correct
session's claims, and avoid releasing a live worker or a resumed/reassigned
claim. A placeholder cannot claim to know the next action; recovery must identify
who reconstructs it and where to look. Hook identity, claim liveness and
ownership races require a policy decision before implementation.

## Alternatives

1. Keep explicit agent parking and enforce it at supported turn boundaries.
   Reuse the existing guard work; session-exit recovery remains a separate gap.
2. Add a tasks-owned consumer of relay for genuine end events, with an explicit
   recovery action pointing to the task, authoritative worktree and session.
   This is the current lean if a residual gap survives the existing policy work.
3. Recover orphaned claims during later task selection. This can cover missing
   end events, but needs a liveness/ownership contract and is wider than one hook.

Prefer option 2 over a Familiar-specific mutation. Retain option 1 if the
existing policy proves sufficient; do not add a second policy implementation.

## Unanswered questions

- Which claim policy belongs in tasks, and what establishes actual completion?
  `tasks-56b450` owns that decision.
- Can the existing claim inventory select every relevant claim with its
  authoritative worktree? `tasks-724c9e` supplies the bounded comparison.
- After those findings, is a true session-exit gap left, and what recovery
  action can be recorded honestly? Explicitly rerun `/scope fam-5b276b`.
  If a gap remains, design it with the chosen tasks policy owner.
- Which end events are actually delivered, and how does a concurrent resume
  invalidate an end-event write? The chosen owner must prove event delivery and
  ownership checks before shipping any fallback.

## Proposed decomposition

- fam-2313e1 keeps the local handoff associated with `fam-5b276b`.
- Reuse `tasks-56b450` and `tasks-724c9e`; both are dependencies of the
  idea and goal. Do not duplicate their design or investigation here.
- Keep `fam-5b276b` as an idea with its original body. The existing tasks
  completion instructions do not name this idea as one to wake, so use the
  explicit rerun above when their findings land.
- If design identifies an implementation outside Familiar, file it with the
  owning project and preserve this idea as the source. No runtime hook,
  settings or external task record is changed by this pass.
