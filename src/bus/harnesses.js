// The harnesses whose relay rows and events familiar accepts. One row from a harness
// missing here makes familiar refuse the whole snapshot, and relay publishes a row as
// soon as any of that harness's hooks dispatch on the host, whoever subscribes. So add
// a harness here, and to printsPlaceholderCells, before its hooks route through relay.
export const HARNESSES = Object.freeze(['claude-code', 'codex', 'opencode', 'agy']);
