// codex's hook payload is claude-code's, near enough to share this outright: JSON on stdin,
// snake_case, same field names (session_id, cwd, transcript_path, hook_event_name, tool_name,
// tool_input). That is not a coincidence to paper over -- it is the reason a codex adapter is
// a day's work and not a rewrite, and it belongs in one function rather than two that must be
// kept in step.
//
// What differs between the agents is the EVENT SET and the PROCESS to find, and those stay in
// the adapters, where the differences are visible.
export function parsePayload(stdin) {
  let data;
  try {
    data = JSON.parse(stdin);
  } catch {
    throw new Error('hook payload is not JSON');
  }
  if (typeof data?.session_id !== 'string' || data.session_id === '') {
    throw new Error('hook payload has no session_id');
  }
  return {
    sessionId: data.session_id,
    cwd: data.cwd ?? process.cwd(),
    background: inFlightBackground(data.background_tasks),
  };
}

// claude-code's Stop and SubagentStop list the session's in-flight background work: running or
// pending, and backgrounded (measured on 2.1.302: `[{ id, type: 'subagent', status: 'running',
// ... }]`, and `[]` once it has finished). Every other event omits the field, so `undefined` means
// "not reported", never "none running" -- the transaction carries the last reported counts forward
// rather than reading absence as zero.
//
// The work splits by what it means for the turn. An AGENT-type task wakes the session when it
// finishes, so a turn that ends with one in flight has handed its work off rather than finished
// it; these are the types claude-code's own idle notice waits on (local_agent, local_workflow,
// in_process_teammate, remote_agent), under the labels the payload gives them. Its check also
// skips an idle teammate, a long-running cloud session and a paused task, but the payload carries
// none of those flags (only id, type, status and description), so such a task holds the Stop at
// `working` here while claude-code's idle notice still fires. Everything else
// (a shell, a monitor, an MCP task, claude-code's own housekeeping) may run indefinitely -- a dev
// server, a Monitor -- and must not hold the turn open. Scheduled wakeups arrive separately, in
// `session_crons`, and are not counted: a cron may be a day away, or recur forever.
const AGENT_TYPES = new Set(['subagent', 'workflow', 'teammate', 'cloud session']);
const IN_FLIGHT = new Set(['running', 'pending']);

function inFlightBackground(tasks) {
  if (tasks === undefined) return undefined;
  if (!Array.isArray(tasks)) {
    throw new Error(`hook payload background_tasks must be a list (found ${typeof tasks})`);
  }
  const inFlight = tasks.filter((task) => IN_FLIGHT.has(task?.status));
  const agents = inFlight.filter((task) => AGENT_TYPES.has(task.type)).length;
  return { agents, other: inFlight.length - agents };
}
