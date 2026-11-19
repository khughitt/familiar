import { readFileSync } from 'node:fs';
import { tmuxFacts } from './tmux.js';

function envOf(pid, read) {
  const raw = read(`/proc/${pid}/environ`, 'utf8');
  return Object.fromEntries(raw.split('\0').filter(Boolean).map((kv) => {
    const eq = kv.indexOf('=');
    return [kv.slice(0, eq), kv.slice(eq + 1)];
  }));
}

export function terminalTarget(pid, {
  platform = process.platform,
  harness,
  record,
  hookEnv = process.env,
  readEnviron = readFileSync,
  probe = tmuxFacts,
} = {}) {
  if (platform === 'linux') {
    let env;
    try { env = envOf(pid, readEnviron); }
    catch { /* tint and bell do not need graphics capability */ }
    // agy keeps its terminal on stdin and redirects stdout and stderr to its log.
    const fd = harness === 'agy' ? 0 : 1;
    return { path: `/proc/${pid}/fd/${fd}`, env, tmux: env === undefined ? undefined : probe(env) };
  }
  if (platform === 'darwin') {
    if (!record || typeof record.tty !== 'string' || !/^ttys[0-9a-f]+$/i.test(record.tty)) {
      throw new Error(`terminal target: agent pid ${pid} has no validated Darwin tty`);
    }
    return { path: `/dev/${record.tty}`, env: hookEnv, tmux: probe(hookEnv) };
  }
  throw new Error(`terminal target: unsupported platform ${JSON.stringify(platform)}`);
}
