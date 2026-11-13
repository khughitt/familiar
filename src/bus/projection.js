import { sameBasis } from './sessions.js';

const sameTerminal = (a, b) => a.pid === b.pid && a.starttime === b.starttime;
// The status line's agent token: a root row's own background count, when relay reports one.
const agentsOf = (row) => {
  const agents = row.background?.agents;
  return Number.isSafeInteger(agents) && agents > 0 ? { agents } : {};
};
const endedRecord = (record, seq) => ({
  sessionId: record.sessionId, harness: record.harness, project: record.project,
  pid: record.pid, starttime: record.starttime, seq,
  ...(record.holder ? { holder: record.holder } : {}),
});

export async function projectSnapshot({
  snapshot, prior, priorIntent, seq, mode, event, prepared, resolveVisuals,
}) {
  const rows = Object.values(snapshot?.agents ?? {});
  const roots = rows.filter((row) => row.scope !== 'worker');
  const previous = new Map(Object.entries(prior.sessions));
  const previousEnded = new Map(Object.entries(prior.ended));
  const ended = new Map(previousEnded);
  const kept = new Map();
  const diagnostics = [];
  let stale = false;
  let intent;
  let faults = new Map();

  // `admitted` is the seq at which a record entered sessions.json, kept while it stays:
  // `seq` moves on every event and state change, so it orders nothing by arrival. One
  // that leaves and returns is admitted again; one written before admission existed
  // gets the current seq, its true order being gone (the local state contract).
  if (mode === 'drop-only') {
    const present = new Set(roots.map((row) => row.sessionId));
    for (const [sid, record] of previous) {
      if (present.has(sid)) kept.set(sid, { ...record, admitted: record.admitted ?? seq });
    }
    intent = Object.fromEntries(Object.entries(priorIntent).filter(([sid]) => kept.has(sid)));
  } else {
    const rootRows = new Map(roots.map((row) => [row.id, row]));
    const folded = new Map(roots.map((row) => [row.id, { ...row }]));
    for (const worker of rows.filter((row) => row.scope === 'worker')) {
      const root = folded.get(worker.root);
      if (root && worker.updatedAt > root.updatedAt) {
        root.state = worker.state;
        root.updatedAt = worker.updatedAt;
      }
    }
    const candidates = new Map();
    for (const row of folded.values()) {
      const group = candidates.get(row.sessionId) ?? [];
      group.push(row);
      candidates.set(row.sessionId, group);
    }
    if (prepared) {
      const group = candidates.get(event?.sessionId);
      stale = !group?.some((row) => sameBasis(prepared.basis, {
        generation: snapshot.generation, agentId: row.id, process: row.process, cwd: row.cwd,
      }));
    }
    for (const [sid, group] of candidates) {
      if (group.length > 1) {
        diagnostics.push(`sessionId collision ${sid}: ${group.map((row) => row.id).join(', ')}`);
        continue;
      }
      const [row] = group;
      const basis = { generation: snapshot.generation, agentId: row.id, process: row.process, cwd: row.cwd };
      const old = previous.get(sid);
      let context;
      if (prepared && event?.sessionId === sid && !stale) {
        context = { ...prepared.context, ...prepared.terminal, ...(prepared.holder ? { holder: prepared.holder } : {}) };
      } else if (old && sameBasis(old.basis, basis)) {
        context = old;
      } else {
        continue;
      }
      // Niri orders sessions by their last event or row change, not by reconciles.
      const changed = !old || old.state !== row.state || old.updatedAt !== row.updatedAt
        || (event?.sessionId === sid && !stale);
      // Taken from the unfolded root row: a worker's background is its own, never the session's.
      // A count the old record carried is dropped with the rest of it when the row has none.
      const { agents: _carried, ...base } = context;
      kept.set(sid, {
        ...base, sessionId: sid, agentId: row.id, harness: row.harness, basis,
        seq: changed ? seq : old.seq, admitted: old?.admitted ?? seq, state: row.state, updatedAt: row.updatedAt,
        ...agentsOf(rootRows.get(row.id)),
      });
    }
  }

  const keptRecords = [...kept.values()];
  for (const [sid, record] of previous) {
    if (!kept.has(sid) && !keptRecords.some((keptRecord) => sameTerminal(record, keptRecord))) {
      ended.set(sid, endedRecord(record, seq));
    }
  }
  if (mode === 'full') {
    for (const [sid, record] of ended) {
      if (kept.has(sid) || keptRecords.some((keptRecord) => sameTerminal(record, keptRecord))) ended.delete(sid);
    }
    ({ intent, faults } = await resolveVisuals(Object.fromEntries(kept)));
  }

  const sessions = {
    schema: 1,
    registry: snapshot ? { generation: snapshot.generation, revision: snapshot.revision } : null,
    sessions: Object.fromEntries(kept),
    ended: Object.fromEntries(ended),
  };
  let capture = null;
  if (event && !stale) {
    const next = kept.get(event.sessionId) ?? null;
    const prev = next
      ? previous.get(event.sessionId) ?? previousEnded.get(event.sessionId) ?? null
      : ended.get(event.sessionId) ?? null;
    capture = { prev, next };
  }
  return { sessions, intent, faults, stale, capture, diagnostics };
}
