// Desktop attribution for attention: which stable Niri workspace each source's
// attention belongs to, and what a popup, pill or toast needs to present it. Pure but
// for the theme loader it is handed; compositor knowledge stays in integrations/.
import { assetsFor } from 'familiar-theme';

const PRIORITY = { error: 0, 'needs-approval': 1, 'needs-input': 2, completion: 3 };

const sessionIdOf = (agentId) => agentId.slice(agentId.indexOf(':') + 1);

// The terminal hosting a source: walk the source's own process (checked against its
// recorded start, so a reused pid is not mistaken for it) up to a Niri window's pid.
function windowOf(source, byPid, ancestors) {
  if (source.process === null) return null;
  let chain;
  try {
    chain = ancestors(source.process.pid);
  } catch {
    return null;
  }
  if (!Array.isArray(chain) || chain[0]?.pid !== source.process.pid || chain[0].starttime !== source.process.start) return null;
  const hit = chain.find((row) => byPid.has(row.pid));
  return hit ? byPid.get(hit.pid) : null;
}

// The desktop input for the reducer. `workspaces` is the validated topology's rows, or
// null when the topology is untrusted: then nothing is attributed and nothing claims to
// know where the user is looking.
export function projectDesktop({ state, windows, workspaces, presentations, dnd, instanceId, now, ancestors }) {
  const known = Array.isArray(workspaces);
  const rows = known ? workspaces.map((row) => ({ ...row })) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byPid = new Map((windows ?? []).map((window) => [window.pid, window]));
  const origins = {};
  if (known) {
    for (const [key, source] of Object.entries(state.sources)) {
      if (source.scope !== 'root') continue;
      const window = windowOf(source, byPid, ancestors);
      const workspace = window ? byId.get(String(window.workspace_id)) : undefined;
      if (workspace) origins[key] = { workspaceId: workspace.id, output: workspace.output ?? null };
    }
  }
  return {
    type: 'desktop', instanceId, status: known ? 'known' : 'disconnected', dnd,
    workspaces: rows, origins, enrichment: presentations, now,
  };
}

// Which attention a workspace marker shows. Requests stay (statically) once seen;
// errors and completions clear when seen; dismissed or closed attention never shows.
const marked = (episode) => !episode.closed && !episode.dismissed
  && (episode.kind === 'needs-input' || episode.kind === 'needs-approval' || !episode.seen);

export function attentionByWorkspace(state) {
  const workspaces = {};
  const unmapped = { count: 0, episodeIds: [], diagnosticIds: [] };
  const originOf = (rootKey) => rootKey === null ? null : state.desktop.origins[rootKey]?.workspaceId ?? null;
  const groupFor = (workspaceId) => (workspaceId === null ? unmapped
    : workspaces[workspaceId] ??= { kind: null, winnerId: null, count: 0, episodeIds: [], diagnosticIds: [] });
  const ranked = Object.values(state.episodes).filter(marked)
    .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || b.order - a.order || (a.id < b.id ? -1 : 1));
  for (const episode of ranked) {
    const origin = originOf(episode.rootKey);
    // A completion is only ever marked where it is known to have finished.
    if (origin === null && episode.kind === 'completion') continue;
    const group = groupFor(origin);
    if (origin !== null && group.winnerId === null) {
      group.kind = episode.kind;
      group.winnerId = episode.id;
    }
    group.count += 1;
    group.episodeIds.push(episode.id);
  }
  for (const diagnostic of Object.values(state.diagnostics)) {
    if (diagnostic.dismissed) continue;
    groupFor(originOf(diagnostic.rootKey)).diagnosticIds.push(diagnostic.id);
  }
  return { workspaces, unmapped };
}

// Art and identity for each open episode. The pose follows the episode's own kind;
// only identity and colour come from the root's current presentation, whose state may
// be folded or expired. Missing art leaves the episode neutral and diagnosed: it never
// selects another state's image, and it never blocks attribution or a text toast.
export async function resolvePresentations({ state, intent, loadContext }) {
  const presentations = {};
  const diagnostics = [];
  let context = null;
  let contextError = null;
  const assets = new Map();
  const loaded = async () => {
    if (context === null && contextError === null) {
      try {
        context = await loadContext();
      } catch (error) {
        contextError = error;
        diagnostics.push(`attention: theme unavailable: ${error.message}`);
      }
    }
    return context;
  };
  for (const episode of Object.values(state.episodes).sort((a, b) => a.order - b.order)) {
    if (episode.closed) continue;
    const pose = episode.kind === 'completion' ? 'done' : episode.kind;
    const source = state.sources[episode.sourceKey];
    const root = episode.rootKey === null ? undefined : state.sources[episode.rootKey];
    const current = root ? intent[sessionIdOf(root.agentId)]?.current : undefined;
    const presentation = {
      pose, sprite: null, color: current?.color?.base ?? null,
      label: current?.identity?.label ?? null, project: current?.identity?.project ?? null,
      harness: source.harness, worker: source.scope === 'worker' ? sessionIdOf(source.agentId) : null,
      motionPolicy: current?.motionPolicy ?? 'full',
    };
    presentations[episode.id] = presentation;
    const member = current?.identity?.member;
    if (typeof member !== 'string') {
      diagnostics.push(`attention: identity unavailable for episode ${episode.id}`);
      continue;
    }
    const ctx = await loaded();
    if (ctx === null) continue;
    presentation.motionPolicy = ctx.motionPolicy;
    try {
      if (!assets.has(member)) assets.set(member, assetsFor(ctx.pack, member, ctx.tone.mode));
      const sprite = assets.get(member)[pose]?.terminal;
      if (typeof sprite !== 'string') throw new Error(`member "${member}" has no ${pose} art`);
      presentation.sprite = sprite;
    } catch (error) {
      diagnostics.push(`attention: art unavailable for episode ${episode.id}: ${error.message}`);
    }
  }
  return { presentations, diagnostics };
}
