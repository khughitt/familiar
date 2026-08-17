import { withLock } from './lock.js';
import { readJson, writeJsonAtomic } from './store.js';
import { pruneDead } from './prune.js';
import { isAlive as defaultIsAlive, startTimeOf as defaultStartTimeOf } from './proc.js';
import { gitContext as defaultGitContext, projectKeyFor, displayProject } from './identity.js';
import { resolveAll } from './resolve.js';
import { assertState } from 'familiar-theme';

// Resolve, then write BOTH files. The single-writer point of the system:
// renderers only ever watch intent.json, so two of them cannot disagree about
// what a state looks like — neither one decides.
//
// ORDER IS THE WHOLE POINT HERE. Every fallible step happens BEFORE the first
// write, so a record that cannot be resolved is never admitted to the bus.
//
// The lock gives MUTUAL EXCLUSION. It does not give FAILURE ATOMICITY, and
// writing agents.json first bought neither: a throw from the identity resolve or
// the asset resolve — a pack with no member for the record's slot, a member pin
// contradicting its pin slot, a missing sprite PNG, half a light variant — would
// leave the new record COMMITTED to agents.json with intent.json never updated.
// And since resolveAll resolves EVERY record, that one poisoned record then
// makes every SUBSEQUENT transaction throw, for every session on the machine,
// while agents.json keeps advancing: one healthy session's cat freezes on
// `working` forever, straight through a `needs-approval` the user never sees.
// reap cannot heal it either — it returns early when nothing is dead.
//
// There is no rollback to write, and no second lock to take. There is just an
// order: earn the intent first, and only then let the record in.
//
// THAT GUARDS THE WRITE PATH ONLY. It stops a bad record being ADMITTED; it does
// nothing about a record already on the bus that BECOMES unresolvable — edit
// identities.yaml, switch `theme:` in config.yaml, rename a theme member, delete
// a sprite. Resolution used to be all-or-nothing over every record, so one such
// record threw for EVERY session on the machine, on every hook, before anything
// was written: both files frozen, every surface still saying "working", and reap
// unable to heal it (it returns early when nothing is dead, and the misconfigured
// agent is very much alive).
//
// So resolution is now FAULT-ISOLATED PER RECORD (see resolveIdentities), and the
// two kinds of record get the two different answers they deserve — which is the
// reason this function needs `required`, and the reason it is the transaction,
// not the resolver, that decides:
//
//   THE INCOMING RECORD (`required`) must resolve, or the transaction ABORTS and
//     writes nothing. That is the existing failure-atomicity guarantee, unchanged:
//     an unresolvable record is never admitted, and the session that owns the
//     misconfiguration is the one that gets told about it, in its own transcript.
//
//   A PRE-EXISTING record that faults is EVICTED — dropped from agents.json for
//     this transaction, with a diagnostic — and everyone else transacts normally.
//     Dropping it, rather than parking it on the bus unrendered, is deliberate:
//       - agents.json and intent.json keep IDENTICAL key sets. A record present in
//         one and absent from the other is a shape no reader is written against.
//       - it is SELF-HEALING and SELF-LIMITING. The evicted session is alive, so
//         its very next hook re-admits it — as the INCOMING record, where it
//         either resolves (the user fixed the config: it is simply back) or aborts
//         and reports to its own session. Keeping it on the bus instead would
//         re-fault on every hook of every OTHER session, forever: one stderr line
//         per tool call, in transcripts belonging to projects that did nothing.
//
// Callers must already hold the lock.
async function commit({
  paths, agents, tone, motionPolicy, prepareSprites, required = null,
}) {
  // Resolves each record's identity and admits the complete member it names —
  // sprites plus animation — per-record fault-isolated, before touching the bus.
  const { identities, spriteFor, animationFor, faults } = await prepareSprites(agents);

  if (required !== null && faults.has(required)) throw new Error(faults.get(required));

  const kept = {};
  const evicted = [];
  for (const [sessionId, record] of Object.entries(agents)) {
    if (faults.has(sessionId)) evicted.push({ sessionId, reason: faults.get(sessionId) });
    else kept[sessionId] = record;
  }

  const intent = resolveAll({
    agents: kept, identities, tone, spriteFor, animationFor, motionPolicy,
  });

  // Past this line nothing throws by design: two atomic renames, and the second
  // is the one renderers watch.
  await writeJsonAtomic(paths.agentsPath, kept);
  await writeJsonAtomic(paths.intentPath, intent);
  return { intent, evicted };
}

// There is no resolver daemon. The CLI process handling a hook event does
// everything in one locked transaction.
//
// It returns both the prior resolved intent and the newly resolved `intent`
// alongside the transition. The terminal emitter therefore has serialized
// lifecycle evidence without re-reading the file outside the lock.
// `adapter` is REQUIRED, and has no default. This function used to import claude-code's adapter
// directly, which quietly made "the core" and "claude-code" the same thing — and a default here
// would put that back while looking like a convenience: a codex hook with a forgotten flag would
// go looking for a `claude` process among its ancestors, fail to find one, and report a confusing
// error about the wrong agent entirely. The caller knows which agent fired; it says so.
export async function applyHookEvent({ event, stdin, deps }) {
  const {
    paths, tone, motionPolicy, prepareSprites, adapter,
    gitContext = defaultGitContext,
    isAlive = defaultIsAlive,
    startTimeOf = defaultStartTimeOf,
    now = () => Date.now(),
  } = deps;

  if (!adapter) throw new Error('applyHookEvent needs an adapter — see src/adapters/index.js');
  const { stateForEvent, parsePayload, reduceState } = adapter;
  const resolveAgentPid = deps.resolveAgentPid ?? adapter.resolveAgentPid;

  // The LEVEL: what the event says, on its own. Still validated before the lock, so an unknown
  // event still fails before anything is written -- and `null` still means "clear", so the git
  // and pid resolution below are still skipped for it.
  const level = stateForEvent(event);
  const { sessionId, cwd } = parsePayload(stdin);

  // Git runs OUTSIDE the lock. It spawns up to two subprocesses, and PreToolUse
  // fires on every tool call — holding the bus lock across a process spawn would
  // serialize every concurrent hook on the machine behind it. Nothing here reads
  // shared state, so there is nothing to protect.
  const context = level === null ? null : await gitContext(cwd);
  const pid = level === null ? null : resolveAgentPid();

  // Stamped at WRITE time, next to the pid it qualifies. A pid alone is a number
  // the kernel reuses; the pair is a process. Without it a record could never be
  // reaped once its pid was recycled (see isAlive in ./proc.js).
  //
  // It cannot be absent in practice — the pid came from walking /proc, so
  // /proc/<pid>/stat was readable a moment ago — and if the agent has died since,
  // there is nothing left to decorate. Fail early and say so, rather than writing
  // an unverifiable record that outlives its process, which is the bug itself.
  let starttime = null;
  if (level !== null) {
    starttime = startTimeOf(pid);
    if (!Number.isInteger(starttime)) {
      throw new Error(`could not read the start time of agent pid ${pid} — it is gone`);
    }
  }

  return withLock(paths.lockPath, async () => {
    // Lifecycle evidence must come from the same serialized transaction as the
    // agent record. Read it before commit replaces intent.json; the hook cannot
    // infer a previous virtual placement from process-local memory or a terminal
    // query it cannot safely perform.
    const priorIntents = (await readJson(paths.intentPath)) ?? {};
    const priorIntent = priorIntents[sessionId]?.current ?? null;
    const agents = pruneDead((await readJson(paths.agentsPath)) ?? {}, { isAlive });
    const prev = agents[sessionId] ?? null;

    let next = null;
    if (level === null) {
      delete agents[sessionId];
    } else {
      // THE STATE, which is a function of the level AND of what we were showing a moment ago.
      // This is the only place `prev` exists, which is why the reduction happens here and not up
      // beside stateForEvent. opencode needs it: its `session.status:idle` arrives microseconds
      // after `session.error` (measured -- see the spec, §4), and a reducer that could not see
      // `prev` would let the `done` erase the `error` every single time.
      const state = assertState(reduceState(level, prev?.state ?? null));
      const { remote, repoRoot } = context;
      next = {
        sessionId,
        projectKey: projectKeyFor({ remote, repoRoot, cwd }),
        project: displayProject({ repoRoot, cwd }),
        remote,
        repoRoot,
        cwd,
        pid,
        starttime,
        state,
        updatedAt: now(),
      };
      agents[sessionId] = next;
    }

    // The one place that knows which record is INCOMING. A SessionEnd removes a
    // record rather than adding one, so it requires nothing of anybody: every
    // record left on the bus is pre-existing, and evictable.
    const { intent, evicted } = await commit({
      paths, agents, tone, motionPolicy, prepareSprites,
      required: level === null ? null : sessionId,
    });
    return { prev, next, priorIntent, intent, evicted };
  });
}

// pruneDead running ONLY inside a hook event means "removed on next write" is a
// promise nothing keeps: close the terminal, kill -9 the agent, or drop an SSH
// connection and there IS no next write. The stale record remains on the bus until
// some agent, somewhere on the machine, happens to fire a hook.
//
// So pruning is also a transaction in its own right, which any surface may
// trigger. It stays HERE, in the core, rather than in a renderer: a renderer that
// filters out dead pids is a renderer that resolves, and that is the one thing
// they must never do.
export async function reap({ deps }) {
  const {
    paths, tone, motionPolicy, prepareSprites, isAlive = defaultIsAlive,
  } = deps;

  return withLock(paths.lockPath, async () => {
    const before = (await readJson(paths.agentsPath)) ?? {};
    const agents = pruneDead(before, { isAlive });

    const reaped = Object.keys(before).filter((id) => !(id in agents));
    if (reaped.length === 0) return { reaped, evicted: [] };   // nothing to do; do not churn the files

    // Every record here is pre-existing — reap admits nothing — so `required` is
    // null and a faulted record is evicted rather than aborting the sweep.
    const { evicted } = await commit({
      paths, agents, tone, motionPolicy, prepareSprites,
    });
    return { reaped, evicted };
  });
}
