// A session whose owner died without a session-end (agy has no such hook; any harness
// after a crash) leaves its tint in the terminal, and the dead owner's /proc fd cannot be
// written. The record's `holder` (the agent's parent, usually the shell) still holds the
// pty: reset through it, only while it is the same live process and no live session
// still uses it.
export async function resetOrphanedTerminals({
  ended, sessions, emitTransition, paths, renderProcess, hookEnv, lockWith,
}) {
  const handled = [];
  const holders = Object.values(sessions).flatMap((record) => [record.holder, record].filter(Boolean));
  for (const [sid, record] of Object.entries(ended)) {
    const { holder } = record;
    if (!holder) continue;
    if (renderProcess.ownerAlive(record.pid, { starttime: record.starttime })) continue;
    if (!renderProcess.ownerAlive(holder.pid, { starttime: holder.starttime })) continue;
    if (holders.some((live) => live.pid === holder.pid && live.starttime === holder.starttime)) continue;
    const outcome = await emitTransition({
      prev: { ...record, pid: holder.pid, starttime: holder.starttime }, next: null, intent: null,
      seq: record.seq, harness: record.harness, paths, renderProcess, hookEnv, lockWith,
    });
    if (outcome.kind === 'ended') handled.push(sid);
  }
  return handled;
}
