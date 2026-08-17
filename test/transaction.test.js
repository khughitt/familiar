import { adapterFor } from '../src/adapters/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHookEvent, reap } from '../src/bus/transaction.js';
import { readJson } from '../src/bus/store.js';
import { resolveIdentities } from '../src/bus/resolve.js';
import { parseIdentities } from '../src/bus/pins.js';
import { TTL_DONE_MS } from '../src/protocol/intent.js';
import { parseThemePack, STATES } from 'familiar-theme';

const POSES = STATES.map((s) => `      ${s}: a pose for ${s}`).join('\n');
const PACK = parseThemePack(
  `spec-version: 1\nid: cats\nlabel: Cats\nmembers:\n  - id: dog-in-disguise\n    asset-root: sprites/dog-in-disguise\n    label: Dog in Disguise\n    slots: [3, 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]\n    persona: The Impostor.\n    animation: { kind: static }\n    poses:\n${POSES}\n`,
  '/themes/cats'
);

function harness(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-tx-'));
  const paths = {
    agentsPath: join(dir, 'agents.json'),
    lockPath: join(dir, 'agents.lock'),
    intentPath: join(dir, 'intent.json'),
  };

  const pack = over.pack ?? PACK;
  const catalog = over.catalog ?? parseIdentities('identities: []');

  return {
    paths,
    deps: {
      paths,
      pack,
      catalog,
      // The transaction no longer knows which agent it serves — it is handed one. These tests
      // use claude-code because its event names are the ones they assert on; the codex adapter
      // gets its own coverage in test/codex.test.js.
      adapter: adapterFor('claude-code'),
      tone: { mode: 'dark', satScale: 1 },
      motionPolicy: 'full',
      // The REAL shape, and the real identity pass — only the bake is faked.
      // prepareSprites is where a transaction does its resolving, so a stub that
      // resolved nothing would make every failure-atomicity test below vacuous:
      // there would be nothing left in commit() that could throw.
      prepareSprites: async (agents) => ({
        ...resolveIdentities({ agents, catalog, pack }),   // identities AND faults
        spriteFor: (m, s) => ({ terminal: `/c/${m}/${s}.png`, rows: 12 }),
        animationFor: () => ({ kind: 'static' }),
      }),
      gitContext: async () => ({ remote: 'github.com/me/api', repoRoot: '/home/k/d/api' }),
      resolveAgentPid: () => 4242,
      // The agent's start time, stamped onto the record so a RECYCLED pid can
      // never keep a dead record "alive" (see isAlive in src/bus/proc.js).
      startTimeOf: () => 987_654,
      isAlive: () => true,
      now: () => 1_000_000,
      ...over,
    },
  };
}

const stdin = JSON.stringify({ session_id: 's1', cwd: '/home/k/d/api' });

test('writes the bus AND the resolved intent in one transaction', async () => {
  const { paths, deps } = harness();
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });

  const agents = await readJson(paths.agentsPath);
  assert.deepEqual(agents.s1, {
    sessionId: 's1',
    projectKey: 'github.com/me/api',
    project: 'api',
    remote: 'github.com/me/api',
    repoRoot: '/home/k/d/api',
    cwd: '/home/k/d/api',
    pid: 4242,
    starttime: 987_654,
    state: 'working',
    updatedAt: 1_000_000,
  });

  const intent = await readJson(paths.intentPath);
  assert.equal(intent.s1.current.state, 'working');
  assert.equal(intent.s1.current.identity.member, 'dog-in-disguise');
  assert.equal(intent.s1.current.motionPolicy, 'full');
  assert.deepEqual(intent.s1.current.animation, { kind: 'static' });
  assert.equal(intent.s1.expiresAt, null);
});

test('reports the transition, so the terminal emitter can gate on it without extra state', async () => {
  const { deps } = harness();
  const first = await applyHookEvent({ event: 'SessionStart', stdin, deps });
  assert.equal(first.prev, null);
  assert.equal(first.next.state, 'idle');

  const second = await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });
  assert.equal(second.prev.state, 'idle');
  assert.equal(second.next.state, 'working');

  // PreToolUse fires on EVERY tool call. Steady-state working is not a transition.
  const third = await applyHookEvent({ event: 'PreToolUse', stdin, deps });
  assert.equal(third.prev.state, 'working');
  assert.equal(third.next.state, 'working');
});

test('returns the prior resolved intent from inside the locked transaction', async () => {
  const { deps } = harness();
  const first = await applyHookEvent({ event: 'SessionStart', stdin, deps });
  assert.equal(first.priorIntent, null);

  const second = await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });
  assert.equal(second.priorIntent.state, 'idle');
  assert.equal(second.priorIntent.sessionId, 's1');
  assert.deepEqual(second.priorIntent.animation, { kind: 'static' });
});

test('a corrupt prior intent snapshot is a named transaction failure', async () => {
  const { paths, deps } = harness();
  mkdirSync(join(paths.intentPath, '..'), { recursive: true });
  writeFileSync(paths.intentPath, '{broken');
  await assert.rejects(
    applyHookEvent({ event: 'SessionStart', stdin, deps }),
    new RegExp(`corrupt JSON at ${paths.intentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
});

test('a transient state is written with its expiry and its successor', async () => {
  const { paths, deps } = harness();
  await applyHookEvent({ event: 'Stop', stdin, deps });

  const intent = await readJson(paths.intentPath);
  assert.equal(intent.s1.current.state, 'done');
  assert.equal(intent.s1.expiresAt, 1_000_000 + TTL_DONE_MS);
  assert.equal(intent.s1.after.state, 'idle');
});

test('SessionEnd removes the record from both files', async () => {
  const { paths, deps } = harness();
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });
  const result = await applyHookEvent({ event: 'SessionEnd', stdin, deps });

  assert.equal(result.next, null);
  assert.deepEqual(await readJson(paths.agentsPath), {});
  assert.deepEqual(await readJson(paths.intentPath), {});
});

test('a dead agent is pruned on the next write — portable, no compositor asked', async () => {
  const { paths, deps } = harness();
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });

  const other = JSON.stringify({ session_id: 's2', cwd: '/home/k/d/api' });
  await applyHookEvent({
    event: 'UserPromptSubmit',
    stdin: other,
    deps: { ...deps, resolveAgentPid: () => 5555, isAlive: (pid) => pid === 5555 },
  });

  const agents = await readJson(paths.agentsPath);
  assert.deepEqual(Object.keys(agents), ['s2']);   // s1's pid 4242 is gone
});

test('an unknown hook event throws and writes nothing', async () => {
  const { paths, deps } = harness();
  await assert.rejects(
    applyHookEvent({ event: 'PostToolUse', stdin, deps }),
    /unknown claude-code hook event/
  );
  assert.equal(await readJson(paths.agentsPath), null);
});

test('reap sweeps an agent that died without a SessionEnd — kill -9 leaves no hook behind', async () => {
  const { paths, deps } = harness();
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });

  // The terminal was closed. No SessionEnd fired, and no further hook ever will.
  const { reaped } = await reap({ deps: { ...deps, isAlive: () => false } });

  assert.deepEqual(reaped, ['s1']);
  assert.deepEqual(await readJson(paths.agentsPath), {});
  assert.deepEqual(await readJson(paths.intentPath), {});
});

test('reap with nothing dead does not touch the files — no churn, no spurious surface reload', async () => {
  const { paths, deps } = harness();
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });
  const before = await readJson(paths.intentPath);

  const { reaped } = await reap({ deps });

  assert.deepEqual(reaped, []);
  assert.deepEqual(await readJson(paths.intentPath), before);
});

// --- Failure atomicity ------------------------------------------------------
//
// The lock buys MUTUAL EXCLUSION. It does not buy FAILURE ATOMICITY, and the
// two are not the same promise. If agents.json is committed before the work
// that can throw, a record that cannot be resolved is admitted to the bus
// anyway — and because resolveAll resolves EVERY record, that one poisoned
// record makes every subsequent transaction, for every session on the machine,
// throw on its way past it. The bus is then wedged for everybody: agents.json
// keeps advancing, intent.json never moves again, and reap cannot heal it (it
// returns early when nothing is dead).
//
// So the test is not "the failing transaction fails". It is: the failing
// transaction leaves BOTH files byte-identical to what they were, and the very
// next healthy transaction — from a DIFFERENT session — still succeeds.
test('a record that cannot be resolved is never admitted: both files are untouched, and the bus is not poisoned', async () => {
  const { paths, deps } = harness({
    // Was: a slot this pack has no member for. Every slot is covered under
    // spec-version 1, so the unresolvable record is now one whose pin names a
    // member the theme does not have. What is under test is unchanged: the
    // failing transaction must leave both files byte-identical.
    catalog: parseIdentities(
      'identities:\n  - project: other\n    slot: 9\n    members:\n      cats: cheshire\n'
    ),
  });

  // A healthy session first, so there is real state to preserve.
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });
  const agentsBefore = readFileSync(paths.agentsPath, 'utf8');
  const intentBefore = readFileSync(paths.intentPath, 'utf8');

  // s2 is the pinned project. Resolution MUST throw.
  await assert.rejects(
    applyHookEvent({
      event: 'UserPromptSubmit',
      stdin: JSON.stringify({ session_id: 's2', cwd: '/home/k/d/other' }),
      deps: { ...deps, gitContext: async () => ({ remote: 'github.com/me/other', repoRoot: '/home/k/d/other' }) },
    }),
    /theme "cats" has no member "cheshire"/
  );

  // Neither file moved. Not "agents.json has the record but intent.json is
  // stale" — byte-for-byte the state before the attempt.
  assert.equal(readFileSync(paths.agentsPath, 'utf8'), agentsBefore);
  assert.equal(readFileSync(paths.intentPath, 'utf8'), intentBefore);

  // ...and the bus still works. THIS is the half that matters: a third session,
  // resolvable, transacts normally. If s2's record had been committed, this
  // would throw on s2 while resolving, forever, for every session on the box.
  const third = await applyHookEvent({
    event: 'Stop',
    stdin: JSON.stringify({ session_id: 's3', cwd: '/home/k/d/api' }),
    deps,
  });
  assert.equal(third.next.state, 'done');

  const agents = await readJson(paths.agentsPath);
  assert.deepEqual(Object.keys(agents).sort(), ['s1', 's3']);   // s2 never got in
  const intent = await readJson(paths.intentPath);
  assert.deepEqual(Object.keys(intent).sort(), ['s1', 's3']);
});

test('a first-ever transaction that cannot resolve creates NO files at all', async () => {
  const { paths, deps } = harness({
    gitContext: async () => ({ remote: 'github.com/me/other', repoRoot: '/home/k/d/other' }),
    // Same substitution as above: an unresolvable record is now a pin naming a
    // member the theme does not have, not a pin to an unpopulated slot.
    catalog: parseIdentities(
      'identities:\n  - project: other\n    slot: 9\n    members:\n      cats: cheshire\n'
    ),
  });

  await assert.rejects(
    applyHookEvent({ event: 'UserPromptSubmit', stdin, deps }),
    /theme "cats" has no member "cheshire"/
  );

  assert.equal(existsSync(paths.agentsPath), false);
  assert.equal(existsSync(paths.intentPath), false);
});

test('the record carries the agent starttime, and a dead agent takes the record down even on a live pid', async () => {
  const { paths, deps } = harness();
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });
  assert.equal((await readJson(paths.agentsPath)).s1.starttime, 987_654);

  // s1's agent died and its pid 4242 was recycled — something else is using the
  // number now, so a pid-only check still says "alive". The starttime does not
  // match, so the record is a phantom and goes. s2, on a pid that IS what it
  // claims, stays.
  const recycled = (pid, { starttime } = {}) => (pid === 5555 && starttime === 111);
  await applyHookEvent({
    event: 'UserPromptSubmit',
    stdin: JSON.stringify({ session_id: 's2', cwd: '/home/k/d/api' }),
    deps: { ...deps, resolveAgentPid: () => 5555, startTimeOf: () => 111, isAlive: recycled },
  });

  assert.deepEqual(Object.keys(await readJson(paths.agentsPath)), ['s2']);
});

test('an agent that vanishes before its starttime can be read is a hard error, not an unverifiable record', async () => {
  // Writing a record with no starttime would recreate the very bug: a record
  // nothing can ever prove dead. Fail early instead — one stderr line, exit 0.
  const { paths, deps } = harness();
  await assert.rejects(
    applyHookEvent({ event: 'UserPromptSubmit', stdin, deps: { ...deps, startTimeOf: () => null } }),
    /could not read the start time of agent pid 4242 — it is gone/
  );
  assert.equal(await readJson(paths.agentsPath), null);
});

// --- Fault isolation: a config edit must not poison the bus ------------------
//
// Failure atomicity above guards the WRITE path: an unresolvable NEW record is
// never admitted. It says nothing about the READ path. Resolution runs over EVERY
// record on the bus on EVERY hook, so an ALREADY-ADMITTED record that BECOMES
// unresolvable — repin it in identities.yaml, switch `theme:` in config.yaml,
// rename a member, delete a sprite — used to throw for every session on the
// machine, before anything was written. Both files froze. reap could not heal it:
// it returns early when nothing is dead, and the misconfigured agent is alive.
//
// Reproduced against the real binary with two live sessions: repinning ONLY B
// left session A — pinned to a different slot, blocked on a permission prompt,
// with nothing whatever to do with the edit — frozen at "working" on every
// surface, forever.

// Same PACK, same paths, but resolving against a DIFFERENT identities.yaml: the
// user edited their config between one hook and the next.
const withCatalog = (deps, catalog) => ({
  ...deps,
  prepareSprites: async (agents) => ({
    ...resolveIdentities({ agents, catalog, pack: PACK }),
    spriteFor: (m, s) => ({ terminal: `/c/${m}/${s}.png`, rows: 12 }),
    animationFor: () => ({ kind: 'static' }),
  }),
});

// Repinning s2's project onto a member this theme does not have makes an
// already-admitted record retroactively unresolvable. (Before spec-version 1
// this pinned an empty slot; every slot is covered now, so the misconfiguration
// under test is the renamed-member one instead — the same per-record fault, from
// the same edit to identities.yaml.)
const REPIN_B_TO_A_MISSING_MEMBER = parseIdentities(
  'identities:\n  - project: other\n    slot: 9\n    members:\n      cats: cheshire\n'
);

const stdinB = JSON.stringify({ session_id: 's2', cwd: '/home/k/d/other' });
const asProjectB = (deps) => ({
  ...deps,
  gitContext: async () => ({ remote: 'github.com/me/other', repoRoot: '/home/k/d/other' }),
});

test('a record that BECOMES unresolvable is evicted — it does not take the other sessions down with it', async () => {
  const { paths, deps } = harness();

  // Two live sessions, both resolvable. s2's project (github.com/me/other) has a
  // plain slot pin and no member pin — this is the identities.yaml entry the user
  // edits below into the broken one.
  const bothFine = parseIdentities('identities:\n  - project: other\n    slot: 3\n');
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps: withCatalog(deps, bothFine) });
  await applyHookEvent({
    event: 'UserPromptSubmit', stdin: stdinB, deps: asProjectB(withCatalog(deps, bothFine)),
  });
  assert.deepEqual(Object.keys(await readJson(paths.agentsPath)).sort(), ['s1', 's2']);

  // The user edits identities.yaml, repinning ONLY s2's project — onto a member
  // this theme does not have. s2's record is already on the bus.
  const poisoned = withCatalog(deps, REPIN_B_TO_A_MISSING_MEMBER);

  // Now s1 — a different project, a different slot, innocent of the whole thing —
  // fires a hook. It must go through, and it must reach BOTH files.
  const result = await applyHookEvent({ event: 'Notification:permission_prompt', stdin, deps: poisoned });
  assert.equal(result.next.state, 'needs-approval');

  const agents = await readJson(paths.agentsPath);
  const intent = await readJson(paths.intentPath);
  assert.equal(agents.s1.state, 'needs-approval', 'the healthy session advanced on the bus');
  assert.equal(intent.s1.current.state, 'needs-approval', 'and on the file every renderer watches');

  // s2 was evicted, with a diagnostic naming the misconfiguration — and the two
  // files agree about it, because a record in one and not the other is a shape no
  // reader is written against.
  assert.deepEqual(result.evicted, [{ sessionId: 's2', reason: 'theme "cats" has no member "cheshire"' }]);
  assert.deepEqual(Object.keys(agents), ['s1']);
  assert.deepEqual(Object.keys(intent), ['s1']);
});

test('the poisoned session itself still aborts loudly — in its OWN transcript, and admits nothing', async () => {
  const { paths, deps } = harness();
  const bothFine = parseIdentities('identities:\n  - project: other\n    slot: 3\n');
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps: withCatalog(deps, bothFine) });

  const poisoned = withCatalog(deps, REPIN_B_TO_A_MISSING_MEMBER);

  // The INCOMING record must still resolve or the transaction aborts. That is the
  // failure-atomicity guarantee, and eviction does not weaken it: s2 is not
  // quietly evicted on its own hook, it is refused.
  await assert.rejects(
    applyHookEvent({ event: 'UserPromptSubmit', stdin: stdinB, deps: asProjectB(poisoned) }),
    /theme "cats" has no member "cheshire"/
  );
  assert.deepEqual(Object.keys(await readJson(paths.agentsPath)), ['s1']);
});

test('eviction is self-healing: fix the config and the session is simply back', async () => {
  const { paths, deps } = harness();
  const bothFine = parseIdentities('identities:\n  - project: other\n    slot: 3\n');
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps: withCatalog(deps, bothFine) });
  await applyHookEvent({
    event: 'UserPromptSubmit', stdin: stdinB, deps: asProjectB(withCatalog(deps, bothFine)),
  });

  // Broken: s1's next hook evicts s2.
  await applyHookEvent({
    event: 'PreToolUse', stdin, deps: withCatalog(deps, REPIN_B_TO_A_MISSING_MEMBER),
  });
  assert.deepEqual(Object.keys(await readJson(paths.agentsPath)), ['s1']);

  // The user fixes identities.yaml. s2 is alive, so its very next hook re-admits
  // it — as the incoming record, which resolves. No reap, no restart, no repair.
  await applyHookEvent({
    event: 'PreToolUse', stdin: stdinB, deps: asProjectB(withCatalog(deps, bothFine)),
  });
  assert.deepEqual(Object.keys(await readJson(paths.agentsPath)).sort(), ['s1', 's2']);
  assert.deepEqual(Object.keys(await readJson(paths.intentPath)).sort(), ['s1', 's2']);
});

test('reap evicts a faulted record too — every record it sees is pre-existing', async () => {
  const { paths, deps } = harness();
  const bothFine = parseIdentities('identities:\n  - project: other\n    slot: 3\n');
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps: withCatalog(deps, bothFine) });
  await applyHookEvent({
    event: 'UserPromptSubmit',
    stdin: stdinB,
    deps: { ...asProjectB(withCatalog(deps, bothFine)), resolveAgentPid: () => 5555 },
  });

  // s1's agent died (pid 4242); s2's config broke. reap must sweep the first and
  // evict the second rather than throwing on it and sweeping neither.
  const { reaped, evicted } = await reap({
    deps: { ...withCatalog(deps, REPIN_B_TO_A_MISSING_MEMBER), isAlive: (pid) => pid !== 4242 },
  });

  assert.deepEqual(reaped, ['s1']);
  assert.deepEqual(evicted.map((e) => e.sessionId), ['s2']);
  assert.deepEqual(await readJson(paths.agentsPath), {});
  assert.deepEqual(await readJson(paths.intentPath), {});
});

test('an asset failure faults only the sessions on that member — not the bus', async () => {
  // A deleted sprite PNG throws from the ASSET resolve (assetsFor), not the identity
  // pass, and the asset resolve is per-member. It must fault exactly the sessions
  // resolving to that member. Here s1 and s2 share a project (and therefore a member),
  // so both go; what matters is that the transaction still commits, rather than
  // throwing.
  const { paths, deps } = harness();
  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });

  const brokenAssets = {
    ...deps,
    prepareSprites: async (agents) => {
      const { identities, faults } = resolveIdentities({ agents, catalog: deps.catalog, pack: PACK });
      for (const [sessionId, identity] of [...identities]) {
        if (identity.member !== 'dog-in-disguise') continue;
        faults.set(sessionId, 'ENOENT: no such file, open ".../dog-in-disguise/idle.png"');
        identities.delete(sessionId);
      }
      return {
        identities,
        faults,
        spriteFor: () => ({ terminal: '/c/x.png', rows: 12 }),
        animationFor: () => ({ kind: 'static' }),
      };
    },
  };

  // SessionEnd requires nothing of anybody — every record left is pre-existing.
  const { evicted } = await applyHookEvent({ event: 'SessionEnd', stdin: stdinB, deps: brokenAssets });
  assert.deepEqual(evicted.map((e) => e.sessionId), ['s1']);
  assert.match(evicted[0].reason, /no such file/);
  assert.deepEqual(await readJson(paths.agentsPath), {}, 'the transaction still committed');
});

// --- Task 11 review requirement --------------------------------------------
//
// AgentRecord must carry `remote` AND `repoRoot`, not just `projectKey`:
// projectKey COLLAPSES to the remote whenever one exists (identity.js,
// projectKeyFor), so a `path:` pin on a repo that also has a remote could
// never match on projectKey alone — the user's pin would be silently
// ignored. This proves the pass-through survives the full transaction: a
// record written by applyHookEvent, with a live remote, still resolves via
// its repoRoot-only pin.
test('a path: pin still matches after a record with a remote makes the full round trip through the transaction', async () => {
  // github.com/me/other autoSlots to 9 (verified out of band), and this pin says
  // 3 — so if `repoRoot` were dropped anywhere along the way, matchPin would fail
  // to find this pin (it has no `remote` key), the resolver would fall through to
  // the unpinned autoSlot, and the record would land on slot 9. The resolved slot
  // asserted below is what makes a false pass impossible: it is the pinned slot
  // only if the pin's repoRoot was honored. (Under spec-version 1 every slot has
  // a member, so a dropped repoRoot resolves rather than throwing — the slot is
  // now the whole signal.)
  const { paths, deps } = harness({
    gitContext: async () => ({ remote: 'github.com/me/other', repoRoot: '/home/k/d/other' }),
    catalog: parseIdentities('identities:\n  - path: /home/k/d/other\n    slot: 3\n'),
  });

  await applyHookEvent({ event: 'UserPromptSubmit', stdin, deps });

  const agents = await readJson(paths.agentsPath);
  assert.equal(agents.s1.remote, 'github.com/me/other');
  assert.equal(agents.s1.repoRoot, '/home/k/d/other');
  assert.equal(agents.s1.projectKey, 'github.com/me/other');   // collapsed to the remote

  const intent = await readJson(paths.intentPath);
  assert.equal(intent.s1.current.identity.slot, 3);
  assert.equal(intent.s1.current.identity.member, 'dog-in-disguise');
});
