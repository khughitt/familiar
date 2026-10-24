import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseEnvelope } from './envelope.js';
import { prepareEnrichment } from './enrich.js';
import { loadContext, visualResolver } from './context.js';
import { emitTransition } from './emission.js';
import { readSessions, writeSessions, sessionIdOf } from '../bus/sessions.js';
import { projectSnapshot } from '../bus/projection.js';
import { nextSeq } from '../bus/seq.js';
import { readJson, writeJsonAtomic } from '../bus/store.js';
import { withLock } from '../bus/lock.js';
import { defaultProcessOps } from '../bus/proc.js';
import { pruneLedgers } from '../render/term/ledger-prune.js';
import { pruneTerminalOwners } from '../render/term/terminal-owner.js';
import { sweepTemps } from '../bus/temp-sweep.js';
import { convergeCodexProject } from '../install/codex-converge.js';
import { reduceAttention } from '../attention/model.js';
import { mutateAttention } from '../attention/store.js';

const line = (message) => `familiar: observe: ${message}`;
const faultLine = (error) => line(`${error.code ? `${error.code}: ` : ''}${error.message.replace(/^observe: /, '')}`);
const acknowledged = (result) => result.kind === 'ended' || result.kind === 'superseded'
  || (result.kind === 'suppressed' && result.reason === 'owner-dead');

function dependencies(given) {
  const deps = { renderProcess: defaultProcessOps, loadContext, emitTransition, now: Date.now, env: process.env, ...given };
  const lock = given.lockWith ?? withLock;
  deps.lockWith = (path, fn, options) => lock(path, fn, {
    ...options, now: deps.now, startTimeOf: deps.renderProcess.startTimeOf,
    isAlive: deps.renderProcess.lockHolderAlive ?? deps.renderProcess.ownerAlive,
  });
  return deps;
}

// Attention is captured from relay's raw rows before anything visual can fail: a broken
// theme, a missing sprite or a terminal that cannot be written must not lose a request.
export async function captureAttention({ paths, envelope, relay, now = Date.now, lockWith = withLock }) {
  const { state } = await mutateAttention({ paths, lockWith }, async (saved) => reduceAttention(saved, {
    type: 'observe', snapshot: await relay.readSnapshot(), envelope, now: now(),
  }));
  return state;
}

// A capture failure is reported by name and leaves the saved attention as it was.
async function captured(deps, envelope) {
  try {
    await captureAttention({ paths: deps.paths, envelope, relay: deps.relay, now: deps.now, lockWith: deps.lockWith });
    return [];
  } catch (error) {
    return [line(`attention: ${error.code ? `${error.code}: ` : ''}${error.message.replace(/^attention: /, '')}`)];
  }
}

async function project({ deps, event = null, prepared = null, mode = 'full' }) {
  return deps.lockWith(deps.paths.presentationLockPath, async () => {
    const seq = await nextSeq(deps.paths);
    const snapshot = await deps.relay.readSnapshot();
    const prior = await readSessions(deps.paths.sessionsPath);
    const priorIntent = await readJson(deps.paths.intentPath) ?? {};
    const ctx = mode === 'full' ? await deps.loadContext({ paths: deps.paths }) : null;
    const result = await projectSnapshot({
      snapshot, prior, priorIntent, seq, mode, event, prepared,
      resolveVisuals: ctx ? visualResolver(ctx) : undefined,
    });
    await writeSessions(deps.paths.sessionsPath, result.sessions);
    await writeJsonAtomic(deps.paths.intentPath, result.intent);
    const awaiting = [...new Set(Object.values(snapshot?.agents ?? {})
      .filter((row) => row.scope !== 'worker' && !Object.hasOwn(result.sessions.sessions, row.sessionId))
      .map((row) => row.sessionId))];
    const lines = [
      ...result.diagnostics.map(line),
      ...[...result.faults].map(([sid, reason]) => line(`session ${sid}: ${reason}`)),
    ];
    return { ...result, seq, ctx, awaiting, lines };
  });
}

export async function acknowledgeEnded({ paths, sessionId, seq, lockWith = withLock }) {
  return lockWith(paths.presentationLockPath, async () => {
    const sessions = await readSessions(paths.sessionsPath);
    if (sessions.ended[sessionId]?.seq !== seq) return false;
    delete sessions.ended[sessionId];
    await writeSessions(paths.sessionsPath, sessions);
    return true;
  });
}

export async function reconcile({ deps: given }) {
  const deps = dependencies(given);
  const failed = await captured(deps, null);
  const { sessions, awaiting, lines } = await project({ deps });
  return { sessions, awaiting, lines: [...failed, ...lines] };
}

async function cleanup(deps) {
  const { paths, renderProcess, lockWith, now } = deps;
  const { sessions } = await readSessions(paths.sessionsPath);
  const ownerAlive = (pid, stamp) => renderProcess.ownerAlive(pid, stamp);
  await pruneLedgers({ transmitDir: paths.transmitDir, agents: sessions, ownerAlive,
    startTimeOf: renderProcess.startTimeOf, lockWith, now });
  await pruneTerminalOwners({ transmitDir: paths.transmitDir, ownerAlive, lockWith });
  await sweepTemps({ dirs: [paths.stateDir, paths.transmitDir, join(paths.transmitDir, 'terminals')],
    pidExists: renderProcess.pidExists, now });
}

export async function observe({ text, deps: given }) {
  const lines = [];
  try {
    const envelope = parseEnvelope(text);
    const deps = dependencies(given);
    const failed = await captured(deps, envelope);
    lines.push(...failed);
    if (envelope.type === 'reconcile') {
      const result = await project({ deps });
      lines.push(...result.lines);
      await cleanup(deps);
      return { exitCode: lines.length ? 1 : 0, lines };
    }
    let event = { ...envelope.event, sessionId: sessionIdOf(envelope.event.root ?? envelope.event.agentId) };
    const teardown = event.kind === 'session-end';
    let prepared = null;
    let absent = false;
    if (!teardown) {
      const snapshot = await deps.relay.readSnapshot();
      const prior = await readSessions(deps.paths.sessionsPath);
      const enrichment = await prepareEnrichment({
        envelope, snapshot, prior, relayProcess: deps.relayProcess,
        renderProcess: deps.renderProcess, adapterFor: deps.adapterFor,
        gitContext: deps.gitContext, lookupProjectColor: deps.lookupProjectColor,
      });
      absent = enrichment.absent === true;
      if (!enrichment.ok && !absent) return { exitCode: failed.length ? 1 : enrichment.exitCode, lines: [...lines, line(enrichment.reason)] };
      event = { ...event, sessionId: enrichment.sessionId };
      if (enrichment.ok) {
        prepared = enrichment;
        lines.push(...enrichment.warnings.map(line));
      }
    }
    const result = await project({ deps, event, prepared, mode: teardown ? 'drop-only' : 'full' });
    lines.push(...result.lines);
    if (result.stale) return { exitCode: failed.length ? 1 : 0, lines: [...failed, line(`stale basis for session ${event.sessionId}`)] };
    if (!absent && result.capture) {
      const { prev, next } = result.capture;
      if ((prev || next) && !(teardown && next)) {
        const outcome = await deps.emitTransition({
          prev, next, intent: next ? result.intent[next.sessionId]?.current ?? null : null,
          seq: result.seq, harness: event.harness, provisional: event.kind === 'session-start',
          paths: deps.paths, renderProcess: deps.renderProcess, hookEnv: deps.env, lockWith: deps.lockWith,
        });
        const ended = result.sessions.ended[event.sessionId];
        if (ended && prev === ended && acknowledged(outcome)) {
          await acknowledgeEnded({ paths: deps.paths, sessionId: event.sessionId, seq: ended.seq, lockWith: deps.lockWith });
        }
      }
      if (event.harness === 'codex' && event.kind === 'session-start' && next && result.intent[next.sessionId]) {
        const ctx = result.ctx;
        const convergence = await convergeCodexProject({
          repoRoot: next.repoRoot, member: result.intent[next.sessionId].current.identity.member,
          catalog: ctx.catalog, pack: ctx.pack, themeId: ctx.themeId,
          petsDir: join(deps.env.CODEX_HOME ?? join(homedir(), '.codex'), 'pets'),
        });
        if (convergence.outcome === 'error') throw new Error(convergence.reason);
        if (convergence.outcome === 'actionable') lines.push(line(convergence.reason));
      }
    }
    await cleanup(deps);
    return { exitCode: result.faults.size || result.diagnostics.length || failed.length ? 1 : 0, lines };
  } catch (error) {
    lines.push(faultLine(error));
    return { exitCode: 1, lines };
  }
}
