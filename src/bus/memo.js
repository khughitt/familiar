// Bounds expensive fresh liveness probes while ensuring a dead lock holder is
// noticed within `ttlMs` rather than cached for the process lifetime.
export function memoizeFor(fn, ttlMs, { now = () => Date.now() } = {}) {
  const cache = new Map();
  return (pid, { starttime = null } = {}) => {
    const key = `${pid}:${starttime}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = fn(pid, { starttime });
    cache.set(key, { at: now(), value });
    return value;
  };
}
