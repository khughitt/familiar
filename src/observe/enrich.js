import { sameBasis, sessionIdOf } from '../bus/sessions.js';
import { gitContext as defaultGitContext, projectKeyFor, displayProject } from '../bus/identity.js';
import { NO_PROJECT, lookupProjectColor as defaultLookupProjectColor } from '../bus/project-color.js';
import { noTerminalMessage } from '../render/harness.js';

export async function prepareEnrichment({
  envelope, snapshot, prior, relayProcess, renderProcess, adapterFor,
  gitContext = defaultGitContext, lookupProjectColor = defaultLookupProjectColor,
  startPid = process.pid,
}) {
  const event = envelope.event;
  let sessionId = sessionIdOf(event.root ?? event.agentId);
  const agent = snapshot?.agents[event.agentId];
  const row = agent?.root ? snapshot.agents[agent.root] : agent;
  const refused = (exitCode, reason) => ({ ok: false, sessionId, exitCode, reason });
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

  const pid = adapter.resolveTerminalPid({ startPid, ancestors: relayProcess.ancestors });
  if (pid === null) return refused(1, noTerminalMessage(event.harness, relayProcess.ancestors(startPid)));
  const starttime = renderProcess.startTimeOf(pid);
  if (!Number.isInteger(starttime)) return refused(1, `could not read the start time of agent pid ${pid} — it is gone`);

  const context = await gitContext(row.cwd);
  const old = prior.sessions[sessionId];
  const carried = old && old.repoRoot === context.repoRoot && Object.hasOwn(old, 'projectColor');
  const color = context.repoRoot === null ? NO_PROJECT : carried
    ? { color: old.projectColor, warnings: [] } : await lookupProjectColor(context.repoRoot);
  return {
    ok: true, sessionId, basis, terminal: { pid, starttime },
    context: {
      cwd: row.cwd, projectKey: projectKeyFor({ ...context, cwd: row.cwd }),
      project: displayProject({ ...context, cwd: row.cwd }),
      remote: context.remote, repoRoot: context.repoRoot, repositoryRoot: context.repositoryRoot,
      projectColor: color.color,
    },
    warnings: color.warnings,
  };
}
