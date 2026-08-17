// Pruning is PID-liveness based, not window-based. That is what makes it
// portable: a bare terminal over SSH has no compositor to ask.
//
// The record carries its agent's `starttime` alongside its pid, and BOTH are
// handed to the liveness check. A pid on its own cannot be trusted: agents.json
// survives reboots, the kernel recycles pids, and `kill(pid, 0)` says "alive"
// for whatever unrelated process now holds the number (see isAlive in ./proc.js).
export function pruneDead(agents, { isAlive }) {
  const kept = {};
  for (const [sessionId, record] of Object.entries(agents)) {
    if (isAlive(record.pid, { starttime: record.starttime })) kept[sessionId] = record;
  }
  return kept;
}
