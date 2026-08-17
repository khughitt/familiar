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
  return { sessionId: data.session_id, cwd: data.cwd ?? process.cwd() };
}
