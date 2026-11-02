import { sameBasis, sessionIdOf } from '../bus/sessions.js';
import { gitContext as defaultGitContext, projectKeyFor, displayProject } from '../bus/identity.js';
import { lookupProjectColor as defaultLookupProjectColor } from '../bus/project-color.js';
import { lookupFamily as defaultLookupFamily } from '../bus/family.js';
import { assertId, RESERVED_ROLE } from '../bus/id.js';
import { noTerminalMessage } from '../render/harness.js';

// The session's role, from the hook's environment: the one source in this piece (spec
// §5.5). Unset or empty is no role. Anything else must be an id, and an invalid value is
// an error, never null: a misspelled role that silently showed the default is the
// anti-goal. `default` is reserved for an agent with no role.
export function roleFromEnv(env) {
  const value = env.FAMILIAR_ROLE;
  if (value === undefined || value === '') return null;
  assertId(value, 'FAMILIAR_ROLE', 'reviewer');
  if (value === RESERVED_ROLE) {
    throw new Error(`FAMILIAR_ROLE "${RESERVED_ROLE}" is reserved for an agent with no role — unset FAMILIAR_ROLE instead`);
  }
  return value;
}

// The colour and family of a checkout, reused from the session's own record while it is
// in the same checkout and owns both, so the hook pays for `tasks resolve` and the family
// file once per session and checkout (spec §3, §5.3). A record that owns a colour but no
// family (written before the family existed) is looked up afresh, both together.
async function projectFacts(old, repoRoot, lookupProjectColor, lookupFamily) {
  if (repoRoot === null) return { color: null, family: null, warnings: [] };
  if (old && old.repoRoot === repoRoot && Object.hasOwn(old, 'projectColor') && Object.hasOwn(old, 'family')) {
    return { color: old.projectColor, family: old.family, warnings: [] };
  }
  const { color, root, warnings } = await lookupProjectColor(repoRoot);
  // A null registered root (unregistered, or tasks absent) has no family file to read.
  const family = root === null ? null : await lookupFamily(root);
  return { color, family, warnings };
}

const PROCESS_READ_FAILURES = ['PROCESS_UNREADABLE', 'PROCESS_UNAVAILABLE'];

// The process that keeps the terminal once the agent exits: the agent's parent when it
// has a terminal too (the shell). Recorded so the tint can still be reset through it
// after an owner that sent no session-end is gone; null when there is none to prove.
function terminalHolder({ chain, pid, renderProcess }) {
  const at = chain.findIndex((row) => row.pid === pid);
  const parent = at >= 0 ? chain[at + 1] : undefined;
  if (!parent || parent.tty === null) return null;
  const starttime = renderProcess.startTimeOf(parent.pid);
  return Number.isInteger(starttime) ? { pid: parent.pid, starttime } : null;
}

export async function prepareEnrichment({
  envelope, snapshot, prior, relayProcess, renderProcess, adapterFor,
  gitContext = defaultGitContext, lookupProjectColor = defaultLookupProjectColor,
  lookupFamily = defaultLookupFamily, env = process.env, startPid = process.pid,
}) {
  const event = envelope.event;
  let sessionId = sessionIdOf(event.root ?? event.agentId);
  const refused = (exitCode, reason) => ({ ok: false, sessionId, exitCode, reason });
  // First, before any process or git work: the hook prints why and writes nothing, so the
  // session keeps its previous record (Review Focus 3).
  let role;
  try {
    role = roleFromEnv(env);
  } catch (error) {
    return refused(0, error.message);
  }
  const agent = snapshot?.agents[event.agentId];
  const row = agent?.root ? snapshot.agents[agent.root] : agent;
  if (!row) return { ...refused(0, 'no registry row for this session'), absent: true };
  sessionId = row.sessionId;
  if (envelope.registry.generation !== snapshot.generation) return refused(0, 'obsolete envelope');

  const basis = { generation: snapshot.generation, agentId: row.id, process: row.process, cwd: row.cwd };
  const adapter = adapterFor(event.harness);
  let own;
  try {
    const pid = adapter.resolveSessionPid({
      startPid, ancestors: relayProcess.ancestors,
      executableOf: relayProcess.executableOf, argvOf: relayProcess.argvOf,
    });
    if (pid === null) return refused(1, 'ownership unproven');
    own = relayProcess.handleOf(pid);
  } catch {
    return refused(1, 'ownership unproven');
  }
  if (own === null || row.process === null) return refused(1, 'ownership unproven');
  if (!sameBasis(basis, { ...basis, process: own })) return refused(0, 'a newer process owns this session');

  let pid;
  try {
    pid = adapter.resolveTerminalPid({
      startPid, ancestors: relayProcess.ancestors,
      executableOf: relayProcess.executableOf, argvOf: relayProcess.argvOf,
    });
  } catch (error) {
    // A terminal-owning ancestor that cannot be read is a state of the host, not a defect.
    if (!PROCESS_READ_FAILURES.includes(error?.code)) throw error;
    return refused(1, `could not read the agent terminal process: ${error.code}: ${error.message}`);
  }
  if (pid === null) return refused(1, noTerminalMessage(event.harness, relayProcess.ancestors(startPid)));
  const starttime = renderProcess.startTimeOf(pid);
  if (!Number.isInteger(starttime)) return refused(1, `could not read the start time of agent pid ${pid} — it is gone`);
  const holder = terminalHolder({ chain: relayProcess.ancestors(startPid), pid, renderProcess });

  const context = await gitContext(row.cwd);
  const facts = await projectFacts(prior.sessions[sessionId], context.repoRoot, lookupProjectColor, lookupFamily);
  return {
    ok: true, sessionId, basis, terminal: { pid, starttime }, holder,
    context: {
      cwd: row.cwd, projectKey: projectKeyFor({ ...context, cwd: row.cwd }),
      project: displayProject({ ...context, cwd: row.cwd }),
      remote: context.remote, repoRoot: context.repoRoot, repositoryRoot: context.repositoryRoot,
      projectColor: facts.color, family: facts.family, role,
    },
    warnings: facts.warnings,
  };
}
