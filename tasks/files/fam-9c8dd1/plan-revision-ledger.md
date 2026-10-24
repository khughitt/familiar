# Desktop attention design review ledger

Task: fam-9c8dd1. Coordination: ops-e40874.

Spec round 1: codex/gpt-6.1-sol, read-only builder check of familiar commit
eccdaa36275085a2b70a5d2cb61b42101550bcec,
docs/specs/2026-10-24-desktop-attention-design.md.
Report: builder-check-report.md. Findings: none.

Ruling: accept the builder check of eccdaa36275085a2b70a5d2cb61b42101550bcec.
Why: the reviewer found no important unanswered question needed to plan the design.
Cost: implementation feasibility and live desktop behavior remain untested;
planning or headless validation can expose limits requiring a revised design.

Deferred minors: none.

## Spec round 2

Reviewer: claude-code/claude-opus-5-5, as supplied by the user.
Reviewed revision: eccdaa36275085a2b70a5d2cb61b42101550bcec.
Full report: spec-round-2-report.md. Verdict: revise; Important 3, Minor 5.
The round-1 acceptance was a builder-question check, not evidence that lifecycle
claims had passed a technical review. Its limitations remain recorded above.

Replacement revision for all rulings below:
929d0a15dcb2a612247d2f628084bf03b16976d0,
docs/specs/2026-10-24-desktop-attention-design.md. The earlier revision was kept
unchanged in git; no amend or rebase was performed.

Ruling: I1 accepted and addressed in 929d0a1: consume raw root/worker rows before
familiar's fold; worker requests have independent episode IDs attributed to the
root terminal; source progress clears only that source; workers never create
completion moments, and a root completion with live workers is suppressed.
Why: the installed projection overwrites root state with newer worker state,
whereas relay keeps distinct Codex worker rows; folding loses request ownership.
Cost: additional source bookkeeping is needed, and a wrong root association could
leave worker attention unmapped. The spec requires explicit diagnosis, not guessing.

Ruling: I2 accepted with the OpenCode qualification, addressed in 929d0a1: show a
static Turn finished marker and low-priority notice for genuine root completion
on an unfocused workspace; never synthesize native needs-input. Include the pinned
harness coverage table and preserve late-idle upgrade disposition/delivery history.
Why: Codex/OpenCode have no mapped needs-input; Claude's delayed idle notification
cannot cover immediate handoff. OpenCode's native idle kind is reduced to done
after activity, so the final registry state differs from the review's table.
Cost: an unfocused completion can produce attention even if no answer is needed;
the label explicitly says completion, not a pending question. Event-time focus is
unavailable; classification uses the latest validated compositor observation.

Ruling: I3 accepted with the OpenCode qualification, addressed in 929d0a1: accept
unbounded observation lag for Claude/Codex, explicitly label Approval requested —
response unconfirmed with age, stop motion on focus, and allow dismissal. Do not
provisionally resolve the underlying request on a visit.
Why: these adapters lack an approval-result event. OpenCode instead consumes
permission.replied and queues a recomputed aggregate level; it must not be described
as always waiting for tool completion. Seeing is still not answering.
Cost: an unconfirmed static observation can remain indefinitely until same-source
progress or dismissal; it must never be labelled proof that approval is pending.

Ruling: M4 accepted and addressed in 929d0a1: seen means Niri is_focused globally,
not every monitor's is_active workspace.
Why: multiple visible workspaces do not prove which source the user attended.
Cost: an alert on a visible but unfocused monitor retains its unseen treatment.

Ruling: M5 accepted and addressed in 929d0a1 as a mandatory planning validation:
verify pinned Noctalia right-click dispatch and existing bindings with a headless
check; use a supported modifier route or explicit plugin-panel action if needed;
preserve left-click navigation and middle-click settings.
Why: the earlier spec treated an unverified gesture as freely available.
Cost: final gesture selection remains a required planning check and may require
a panel action. This is an explicit planning obligation, not a deferred minor.

Ruling: M6 accepted and addressed in 929d0a1: add the first familiar toast sender
through native Noctalia notification-show IPC with validated JSON fields.
Why: familiar has no existing toast sender; pinned Noctalia 5.3 source supports
the chosen command/payload. No parallel notify-send path is needed.
Cost: this version depends on running Noctalia and its IPC; send failure must be
reported, with pending attention retained.

Ruling: M7 accepted and addressed in 929d0a1: supervise the existing coordinator,
publish a heartbeat, and independently detect failure in the widget with a
persistent disconnected indicator and one DND-respecting Noctalia health notice.
Why: disabling native toasts otherwise removes the user's independent delivery
path and lets a coordinator exit become silent.
Cost: supervision and two-second health checks add lifecycle work; a long desktop
stall can trigger the ten-second stale threshold. Noctalia itself being down still
requires service diagnostics rather than an impossible in-shell notification.

Ruling: M8 accepted for adapter reuse, with the JSON suggestion rejected in
929d0a1: extend familiar-noctalia and query live notification-dnd-status IPC.
Why: its existing settings.json reader is scheme-only; native Noctalia v5 uses
TOML configuration/overrides. The read-only installed query returned off; this
verifies the query path, not DND transition behavior.
Cost: unknown DND suppresses new interruptions until diagnosed/recovered, while
static attention remains visible. Live DND transitions remain to be tested.

Deferred minors after the revision: none. Right-click dispatch and DND transitions
are explicit future validation requirements, not claims of completed checks.

## Spec round 3

Reviewer: codex/gpt-6.1-sol, identity verified in the review turn.
Reviewed revision: 929d0a15dcb2a612247d2f628084bf03b16976d0.
Full report: spec-round-3-report.md. Verdict: revise; Important 1, Minor 0.
The reviewer confirmed all eight round-2 corrections against the pinned code,
with the OpenCode qualifications recorded above, then found one remaining
completion-retention contradiction.

Ruling: accepted and addressed in corrective revision
4fdcb54ae7335e594b95b9578360cdcdbaac02e1: passive OpenCode done→idle→idle retains
the completion episode ID, disposition and delivery decisions, including across
reconcile/restart, without another arrival/reservation. Define genuine root
activity as mapped prompt/before-tool/activity or returning to working; a new
actionable root request supersedes completion except the same-turn input upgrade.
Why: the pinned adapter reduces a repeated session.idle after done to idle, and
the plugin's queue forwards every observation without deduplication. The generic
different-state closure otherwise erased the promised unseen completion marker.
Cost: a completion can remain through indefinite passive idle until focus,
dismissal, genuine new activity, a distinct actionable request, or root end;
that persistence is intentional and must not be interpreted as an active request.

## Spec round 4

Reviewer: codex/gpt-6.1-sol, identity verified in the review turn.
Reviewed revision: 4fdcb54ae7335e594b95b9578360cdcdbaac02e1.
Full report: spec-round-4-report.md. Verdict: accept; no findings.
Scope: passive-idle correction, its clearing/upgrade rules and worker interactions,
verified against pinned OpenCode code and the prior full review. No runtime tests
or desktop validation were run. No deferred minors remain.

User review of the replacement written spec remains required before planning.
Worktree .worktrees/desktop-attention is retained and locked; no host pointers
have been repointed.

## Spec round 5

Reviewer: claude-code/claude-opus-5-5, as supplied by the user.
Reviewed revision: 4fdcb54ae7335e594b95b9578360cdcdbaac02e1.
Full report: spec-round-5-report.md. Verdict: revise; Important 3, Minor 3.
The reviewer confirmed all round-2 corrections and the newer factual claims,
then identified further lifecycle/control gaps. The original reviewed spec digest
was verified as 9580200a132dfaba6497184ca5b7073744f6179fdb745b145af0ce8adf1d0d59.

All six rulings below revise 4fdcb54 into frozen replacement
2b58b29009267ac0978945515cdadc3309736a74,
docs/specs/2026-10-24-desktop-attention-design.md.

Ruling: I1 accepted and addressed by documenting the Claude aggregate-source v1
limitation, requiring an honest tooltip, an aliasing regression case and planning
verification of parallel tool events during another sub-agent's permission wait.
Do not claim the separate Codex worker guarantee for Claude or guess worker IDs.
Why: pinned normalizeEvent invokes an optional workerIdOf; Claude implements none,
so equal native session IDs alias one source. Runtime scheduling while a permission
is open was not verified and remains an explicit planning obligation.
Cost: another same-session Claude worker may close a still-open approval marker
early. This possible false negative is explicitly accepted for v1, rather than
described as proof of an answer or a successful per-worker retention check.

Ruling: I2 accepted and addressed with a static Completion withheld — worker
status unconfirmed diagnostic, independently dismissible by root/blocker-set
incarnations. Keep conservative completion suppression; never expire/reap workers
using age or their shared process handle, and never treat dismissal as completion.
Why: Codex worker liveness uses the root process, so missing terminal observations
cannot be established from elapsed time or a live root. A visible diagnostic
addresses silent suppression without pretending a worker ended.
Cost: a stranded row can still suppress completion indefinitely until source/root
evidence changes. The widget exposes that condition and keeps it in its tooltip
after dismissal; it emits no recurring toast and does not replay withheld events.

Ruling: I3 accepted and addressed by persisting completed-turn metadata separately
from marker visibility, including initially focused, seen, hidden and dismissed
completions, until genuine activity or teardown/incarnation change.
Why: a later Claude idle-input notice must retain the same episode/dispositions
and delivery decisions even after no completion marker remains visible.
Cost: the most recent completion metadata remains stored per root incarnation;
the Claude aggregate-source ambiguity still limits genuine-activity attribution.

Ruling: M4 accepted and addressed with a separate attention-health.json file,
atomically replaced by the singleton coordinator without presentation/episode
locking, attention revision changes, or projection/delivery wake-ups.
Why: two-second liveness refresh must continue independently of hook projection
lock contention. It is explicitly excluded from the episode/control lock rule.
Cost: an additional small health file is maintained and independently validated;
the held-lock behavior remains an implementation test obligation.

Ruling: M5 accepted and addressed by dropping queued/not-yet-started opportunities
on unknown/on DND and durably recording suppression; known/off resumes only new
eligible events, with no replay, including health notices.
Why: holding a queue while DND is unknown would violate the chosen no-backlog
policy and could deliver stale interruptions on reconnection.
Cost: a real attention event may never receive a transient notice after recovery;
its static marker remains available. An external send already in flight may finish.

Ruling: M6 accepted and addressed by explicitly applying Approval requested —
response unconfirmed to all three harnesses and identified workers, with observation
age. OpenCode reply evidence closes the observation through its aggregate update.
Why: common wording describes the displayed last observation without promising a
current native dialog; differing resolution latency is documented separately.
Cost: OpenCode's wording remains conservative even when reply observation is prompt.

Deferred minors after this revision: none. Claude runtime scheduling, gesture,
DND and heartbeat checks remain explicitly unperformed obligations. The native
Codex interrupt-to-SubagentStop guarantee remains unverified, not a prerequisite:
the mandatory regression simulates a missing hook and the policy works without
claiming which native interrupts deliver it.
A read-only installed Niri query confirmed every returned workspace has boolean
is_focused and exactly one was true; it changed no focus/workspace and captured
no window titles or workspace names.

## Spec round 6

Reviewer: codex/gpt-6.1-sol, identity verified by a fresh successful command in the
review turn. Frozen revision: 2b58b29009267ac0978945515cdadc3309736a74.
Full report: spec-round-6-report.md. Verdict: accept; no findings.
All six round-5 corrections were checked against the pinned normalizer/adapters,
registry/worker process behavior and familiar's projection/observer boundaries.
The reviewer found no new consequential contradiction within that scope.

No runtime Claude scheduling, native Codex interrupt guarantee, Noctalia gesture,
plugin notification or DND behavior was verified. These limits remain explicit;
the missing-hook policy does not depend on a native interrupt guarantee.
No deferred minors remain. User review of the frozen replacement spec is next;
no implementation plan, product code or live host activation has been started.

## Spec round 7

Reviewer: claude-code/claude-opus-5-5, as supplied by the user.
Reviewed revision: 2b58b29009267ac0978945515cdadc3309736a74.
Full report: spec-round-7-report.md. Verdict: accept; Minor 1.
Keith explicitly accepted this frozen spec for planning. Its six round-5
corrections stand; the separate implementation-plan review gate remains.

Ruling: retain round-7 M1 as minor (deferred) against spec 2b58b29 and plan
e7fd381ec655fd3d9c434836c9e5ac5225cb61b1. hq-4c954d owns the remaining native
check; revisit the warning/completion policy before rollout if ordinary Codex
root completion with active workers is observed.
Why: the registry cannot distinguish a stranded worker from a legitimate active
worker. The bounded survey of 122 rollout files/51 parent-worker pairs found no
root completion during a worker turn, but does not establish that overlap is
impossible. Claude parallel-permission scheduling also remains inconclusive:
the 30 sampled sessions had bypassPermissions records and no explicit wait
boundaries. Neither result changes the accepted attribution limitation.
Cost: legitimate worker activity may show the warning during ordinary use and
permanently withhold that root turn's completion notice; a worker ending later
does not replay it. Native evidence and a disposition remain rollout prerequisites.

Planning checked pinned native Noctalia click routing with two passing extracted
callback self-checks. These do not prove full native hit testing or configured
gesture interception. The plan chooses direct per-pill right-click plus an
explicit left-click Alerts panel fallback; middle-click settings is preserved.
No modifier gesture is chosen because the pinned runtime rejects those chords.

## Implementation plan round 1: author self-review

Reviewer: codex/gpt-6.1-sol, identity verified in this review turn.
Frozen revision: e7fd381ec655fd3d9c434836c9e5ac5225cb61b1.
Path: docs/plans/2026-10-24-desktop-attention.md.
Full report: plan-self-review-report.md. Verdict: accept for user review; no findings.
This was the writing-plans author checklist, not an independent review or user
acceptance. Tasks 1–7 carry spec coverage and explicit regression/verification
steps; all five Review Focus conditions have owning tests.

Implementation children and ops-f800b0 remain blocked pending plan acceptance.
No product code, host pointers, native settings or live services changed.
Full-suite baseline remains deferred to execution Setup. The single deferred
minor above remains visible in the task handoff and final message.

## External implementation plan round 1: revise

Reviewer: claude-code/claude-opus-5-5, identity supplied by the user.
Reviewed frozen plan: e7fd381ec655fd3d9c434836c9e5ac5225cb61b1.
Full report: plan-round-1-external-report.md. Verdict: revise; Important 4, Minor 1.
The user's explicit round-1 note was recorded as requested. The earlier round-1
accept entry was an author checklist, not external/user acceptance; both audit
entries are preserved, and this external revise verdict controls. The next
external review is round 2. No implementation began.

All five dispositions below are against e7fd381 and frozen replacement
d1776d018ebd018bdeea467bf7ce62185c96dd81,
docs/plans/2026-10-24-desktop-attention.md. The accepted spec 2b58b29 is unchanged.

Ruling: I1 accepted and addressed in d1776d0. Publish immediate workspace topology
in its own lock-free atomic file; ordinary navigation does not wait for attention
debounce, enrichment, IPC or presentation locking. Lock focus updates only for
explicit unseen candidates and recheck under lock. Test the 100 ms healthy-path
budget, including a prior in-flight write and held presentation lock. If the feed
fails, use direct 250 ms Niri polling for live navigation and mark familiar
attribution unavailable; if Niri also fails, cached labels are disabled/stale.
Why: plugins have no workspace list/events/focus API, and replacing the built-in
switcher must not make ordinary navigation depend on the attention lock/service.
Cost: a separate freshness file and 50 ms small-file reads add bounded I/O; outage
fallback runs at most four nonoverlapping Niri queries per second. The 100 ms
test relies on explicit I/O assumptions, not measured native performance; native
p95 <=100 ms/max <=200 ms acceptance is still required before replacement.

Ruling: I2 accepted and addressed in d1776d0 with familiar niri focus ID, declared
through ops-f800b0 and dispatched by the existing typed CLI into integration code.
Use Niri's JSON socket Id reference, a Workspaces preflight, a bounded reply and
an unfocused-output fixture; do not route through an index or focus-monitor step.
Why: the installed CLI exposes index/name references whose monitor-relative
meaning can select the wrong workspace. Pinned 26.04 source confirms the socket
Id variant and cross-output focus branch, without needing a live focus action.
Cost: native focus remains untested; IDs above the exact-double safe integer
range fail explicitly. An ID removed after preflight may be acknowledged as a
no-op, so the UI trusts fresh compositor state rather than optimistic success.

Ruling: I3 accepted and addressed in d1776d0. Use 16 ms only for the finite
200–350 ms arrival, then 200 ms for the 4000 ms pulse, and 2000 ms when static.
Add an eight-hour fake-clock count bound; distinguish changed shared-state
invalidations from periodic widget updates and service file polls.
Why: an unseen request can wait overnight, so its slow pulse must not cause
continuous 60 Hz widget work.
Cost: sustained pulse interpolation is less smooth; the finite arrival retains
the fast cadence. The service still polls topology at 50 ms without forcing
widget redraws on unchanged data/freshness-only writes.

Ruling: I4 accepted and addressed in d1776d0. Run every actual production entry,
module and callback in pinned Luau 0.743, with no Lua-compatible subset restriction.
Use verified release archives for Linux x86_64 and macOS arm64 in private ignored
development storage; generated test chunks use isolated environments and no
unavailable Lua filesystem functions. Missing tooling fails with a setup hint.
Why: Lua 5.4 cannot establish Luau syntax or double-number behavior. The Linux
interpreter passed three capability checks; both archive digests were verified.
The initial universal-macOS-binary assumption was rejected by header inspection:
the actual binary is arm64, matching the current macos-14 runner.
Cost: development/CI must provision that runtime; other architectures fail with
an explicit setup error. Mocked host contracts remain short of embedded-host,
native gesture/rendering and performance acceptance; no plugin test ran here.

Ruling: M5 accepted and addressed in d1776d0. Independently query live Noctalia
DND before an eligible health notice, reserve the throttle slot first, and drop
opportunities on DND on/unknown or query failure without replay. Discard late replies after
recovery using the failure-generation token; notify only after a valid off reply.
Why: a dead coordinator cannot supply live DND, and the runtime notify method's
DND behavior was not established. Pinned runAsync supports argv/callback/timeout.
Cost: unknown DND can suppress the transient health notice and a query can take
up to 2000 ms; the persistent indicator remains. A DND change after the check is
still the accepted external-send race, not an atomic guarantee.

Standing minor (deferred): spec round-7 M1 remains unchanged. Legitimate active
Codex workers may cause an ordinary root completion warning and permanently
withhold that completion, without replay when workers finish. The bounded
51-pair survey found no overlap but is not proof; hq-4c954d owns native evidence
and the policy must be revisited before rollout if ordinary overlap is observed.
Claude parallel-permission scheduling is still inconclusive.

Author revision checklist: codex/gpt-6.1-sol, identity verified in this turn.
Report: plan-revision-check-report.md. This is not an external acceptance or
another review-round note. Coverage, interfaces, task dependencies and evidence
limits were checked; the replacement now requires user/external review.
