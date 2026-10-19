import { defaultProcessOps } from '../bus/proc.js';
import { withLock } from '../bus/lock.js';
import { terminalTarget } from '../render/term/target.js';
import { tmuxFacts } from '../render/term/tmux.js';
import { fileLedger, ledgerPaths, transmitLockOptions } from '../render/term/ledger.js';
import { withTerminal } from '../render/term/terminal-owner.js';
import { emit } from '../render/term/emit.js';
import { printsPlaceholderCells } from '../render/harness.js';

// Probe before taking the transmission lock: tmux and Darwin process queries spawn.
// Await the whole emission section so its failures reach the hook's error boundary.
export async function emitTransition({
  prev, next, intent, seq, harness, provisional = false,
  paths,
  renderProcess = defaultProcessOps,
  platform = process.platform,
  hookEnv = process.env,
  probe = tmuxFacts,
  lockWith = withLock,
}) {
  const record = next ?? prev;
  if (record == null) return { kind: 'noop' };
  const terminal = terminalTarget(record.pid, {
    platform,
    record: renderProcess.recordOf(record.pid),
    hookEnv,
    probe,
  });
  const { entryPath, lockPath } = ledgerPaths(paths.transmitDir, record.sessionId);
  const ownerAlive = (pid, { starttime }) => renderProcess.ownerAlive(pid, { starttime });
  const lockOptions = transmitLockOptions({ ownerAlive, startTimeOf: renderProcess.startTimeOf });
  const lock = (fn) => lockWith(lockPath, fn, lockOptions);
  return withTerminal({ transmitDir: paths.transmitDir, terminal: record,
    sessionId: record.sessionId, seq, lockWith, lockOptions }, () => emit({
    prev,
    next,
    seq,
    transmitSprite: printsPlaceholderCells(harness),
    provisional,
    terminal,
    ledger: fileLedger(entryPath),
    lock,
    ownerAlive,
    intent: next !== null ? intent
      : { identity: { project: prev.project }, pid: prev.pid, sessionId: prev.sessionId },
  }));
}

