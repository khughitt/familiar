import { sameBasis } from './sessions.js';

const sameTerminal = (a, b) => a.pid === b.pid && a.starttime === b.starttime;
const endedRecord = (record, seq) => ({
  sessionId: record.sessionId, harness: record.harness, project: record.project,
  pid: record.pid, starttime: record.starttime, seq,
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

  if (mode === 'drop-only') {
    const present = new Set(roots.map((row) => row.sessionId));
    for (const [sid, record] of previous) {
      if (present.has(sid)) kept.set(sid, record);
    }
    intent = Object.fromEntries(Object.entries(priorIntent).filter(([sid]) => kept.has(sid)));
  } else {
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
        context = { ...prepared.context, ...prepared.terminal };
      } else if (old && sameBasis(old.basis, basis)) {
        context = old;
      } else {
        continue;
      }
      kept.set(sid, {
        ...context, sessionId: sid, agentId: row.id, harness: row.harness, basis,
        seq, state: row.state, updatedAt: row.updatedAt,
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
