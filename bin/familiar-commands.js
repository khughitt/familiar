// Every familiar command but `observe`, which bin/familiar.js routes on its own: that file
// parses and routes, and loads this module only for the commands implemented here.
import { loadContext as context, makePrepareSprites } from '../src/observe/context.js';
export { makePrepareSprites } from '../src/observe/context.js';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spritesheet, petFile, SPRITESHEET_PATH, FRAME } from '../src/render/codex/pets.js';
import { STAMP_FILE, stampFor } from '../src/install/pet-stamp.js';
import { paths as resolvePaths } from '../src/bus/paths.js';
import { loadConfig, loadTone, writeTone, themeDirFor } from '../src/config.js';
import { listThemes, stagingStatus } from '../src/theme/catalog.js';
import { addTheme } from '../src/theme/add.js';
import { planCodexProjectSync, applyCodexProjectSync } from '../src/install/codex.js';
import { setupDocument } from '../src/install/setup.js';
import { readReceipt, receiptPath } from '../src/theme/receipt.js';
import { slotSpec } from '../src/protocol/slot-hues.js';
import { identityColors } from '../src/theme/ramp.js';
import { BOLD, RESET, sanitize } from '../src/render/term/sgr.js';
import { reapRegistry, readSnapshot } from 'relay';
import { reconcile } from '../src/observe/run.js';
import { runAttentionCommand } from '../src/attention/commands.js';
import { readSessions, writeSessions } from '../src/bus/sessions.js';
import { pruneTerminalOwners, withTerminal } from '../src/render/term/terminal-owner.js';
import { withLock } from '../src/bus/lock.js';
import { defaultProcessOps } from '../src/bus/proc.js';
import { resolveIdentity, resolveAll, oneThemePackFor } from '../src/bus/resolve.js';
import { gitContext, projectKeyFor, displayProject } from '../src/bus/identity.js';
import { lookupProjectColor, NO_PROJECT } from '../src/bus/project-color.js';
import { loadIdentities, matchPin, pinPath } from '../src/bus/pins.js';
import { gridPlan, layoutRow } from '../src/render/term/cells.js';
import { displayedIntent } from '../src/protocol/intent.js';
import { settle } from '../src/render/term/emit.js';
import { terminalTarget } from '../src/render/term/target.js';
import { describeTmux, tmuxFacts, wrapForTmux } from '../src/render/term/tmux.js';
import { fileLedger, ledgerPaths, transmitLockOptions } from '../src/render/term/ledger.js';
import { pruneLedgers } from '../src/render/term/ledger-prune.js';
import { sweepTemps } from '../src/bus/temp-sweep.js';
import { composeForIntent } from '../src/render/term/statusline.js';
import { hudLines } from '../src/render/term/hud.js';
import { readFields } from '../src/render/term/statusfields.js';
import { GRAPHICS_CAPABILITY, graphicsCapability } from '../src/render/term/capability.js';
import { transmit, transmitAcross } from '../src/render/term/kitty.js';
import { boxFor } from '../src/render/term/box.js';
import { composeStrip, composeGrid, scaleTo, padTo } from '../src/render/term/contact.js';
import {
  loadThemePack, loadThemePackSync, memberOrThrow, defaultMember, DEFAULT_ROLE, ROW_MIN, ROW_MAX,
  assetsFor, STATES, loadAnimationMember, validateThemePack, decodeRgba, encodeRgba,
} from 'familiar-theme';
import { cliColor, cliSwatch, parseLeaf, leafOptionsFor, readStdin, usageError } from './familiar.js';
import { commandAt } from '../src/commands.js';

// A PINNABLE CLOCK, for the decay tests only. Nothing in production sets this; without it
// testing the 8s done and 30s error expiries would require real sleeps.
const now = () => (process.env.FAMILIAR_NOW_MS ? Number(process.env.FAMILIAR_NOW_MS) : Date.now());

// THE WRAPPED COMMAND IS NOT OBLIGED TO READ THE PAYLOAD. It is handed the same stdin
// claude-code sent us, because a status-line script may want the session id or the context
// percentage -- but most of them print and exit without ever looking. When the child exits
// with the payload still undelivered, the parent's write fails with EPIPE.
//
// EPIPE HERE IS NOT A FAILURE OF THE COMMAND, and execSync could not say so: it throws on
// `error` before ever consulting `status`, so an undrained stdin arrived at the boundary
// looking exactly like a command that had died. The status line went blank and printed
// `familiar: spawnSync /bin/sh EPIPE` for a command that ran to completion and exited 0.
// It is a race -- the parent usually wins the write at the few hundred bytes claude-code
// sends -- which is why it showed as an intermittent CI failure and never once locally.
//
// SO THE TWO ARE READ SEPARATELY, which is the whole reason this is spawnSync and not
// execSync: `error` is the PARENT's IO with the child, `status` is the child's own verdict.
// EPIPE is the one parent-side error that says nothing about whether the command worked --
// and it is unambiguous, since the parent writes to no other pipe. Every other error still
// throws, and a nonzero exit or a killing signal is still a failure, reported through the
// boundary as one line.
//
// The command is quoted into the message rather than interpolated raw: a --with is an
// arbitrary shell string and may span lines, and the boundary above promises the failure
// is reported ONCE, ON ONE LINE.
function runWrapped(command, input) {
  const result = spawnSync(command, { input, encoding: 'utf8', shell: '/bin/sh' });
  if (result.error && result.error.code !== 'EPIPE') throw result.error;
  const named = JSON.stringify(command);
  if (result.signal) throw new Error(`--with command was killed by ${result.signal}: ${named}`);
  if (result.status !== 0) throw new Error(`--with command exited ${result.status}: ${named}`);
  return result.stdout;
}

// The status line's half of a provisional SessionStart transmission (see settle() in
// src/render/term/emit.js). The unlocked read is the common path: every refresh of every
// session pays one small file read, and only provisional evidence goes on to probe the
// terminal, which may spawn tmux, and take the lock.
export async function settleStatusline({
  record, intent, paths,
  processOps = defaultProcessOps,
  platform = process.platform,
  hookEnv = process.env,
  probe = tmuxFacts,
  lockWith = withLock,
}) {
  const { entryPath, lockPath } = ledgerPaths(paths.transmitDir, record.sessionId);
  const ledger = fileLedger(entryPath);
  if (!(await ledger.read()).held?.provisional) return { kind: 'noop' };
  const ownerAlive = (pid, { starttime }) => processOps.ownerAlive(pid, { starttime });
  const lockOptions = transmitLockOptions({ ownerAlive, startTimeOf: processOps.startTimeOf });
  return withTerminal({ transmitDir: paths.transmitDir, terminal: record,
    sessionId: record.sessionId, seq: null, lockWith, lockOptions }, () => {
    const terminal = terminalTarget(record.pid, {
      platform,
      record: processOps.recordOf(record.pid),
      hookEnv,
      probe,
    });
    return settle({
      owner: record,
      intent,
      terminal,
      ledger,
      lock: (fn) => lockWith(lockPath, fn, lockOptions),
      ownerAlive,
    });
  });
}

// A member's roles as the theme views print them: `default` first, then the rest in
// declaration order. A member with none is reachable only by a project's pin.
export function rolesText(roles) {
  if (roles.length === 0) return '(pin only)';
  return [...roles].sort((a, b) => (b === DEFAULT_ROLE) - (a === DEFAULT_ROLE)).join(', ');
}

// The `theme sheet` caption row: label, id, then the member's roles. No swatch: since
// spec-version 2 a member holds no slot, so it has no colour of its own to show.
export function sheetRowCaptions(rows) {
  const idWidth = Math.max(...rows.map((row) => row.id.length));
  return rows.map((row) => `  ${row.member.label.padEnd(20)}${row.id.padEnd(idWidth)}  ${rolesText(row.member.roles)}\n`);
}

function reportTasksWarnings(warnings) {
  for (const warning of new Set(warnings)) process.stderr.write(`familiar: tasks: ${warning}\n`);
}

// The identity pipeline whoami and projects share: config -> pack -> pin catalog,
// loaded once, then one directory at a time through git and the resolver. The
// asset proof (assetsFor) is part of resolving, not of printing: an identity whose
// sprites are missing is not an identity the surfaces can show.
async function identityResolver() {
  const paths = resolvePaths();
  const [{ themeId }, tone] = await Promise.all([loadConfig({ paths }), loadTone({ paths })]);
  const pack = await loadThemePack(themeDirFor(paths, themeId));
  const catalog = await loadIdentities(paths.identitiesPath);
  // SHIM (Task C7 replaces it): one theme, no families, and no family or role for the
  // directory, until whoami and projects resolve a checkout's family and every theme.
  // Keyed by the pack's own id, which is what member pins were matched against before.
  const themes = { themeId: pack.id, families: {}, packFor: oneThemePackFor(pack.id, pack) };
  return {
    themeId,
    tone,
    pack,
    catalog,
    async resolve(cwd) {
      const { remote, repoRoot, repositoryRoot } = await gitContext(cwd);
      const projectKey = projectKeyFor({ remote, repositoryRoot, cwd });
      const project = displayProject({ repoRoot, cwd });
      const pin = matchPin(catalog, { remote, repoRoot, repositoryRoot, project });
      const { color: projectColor, prefix, warnings } = repoRoot
        ? await lookupProjectColor(repoRoot)
        : NO_PROJECT;
      const identity = resolveIdentity({
        projectKey, project, remote, repoRoot, repositoryRoot, projectColor,
        family: null, role: null, catalog, themes,
      });
      assetsFor(pack, identity.member, tone.mode);
      return { identity, pin, prefix, warnings };
    },
  };
}

export async function reap({ deps: given }) {
  const deps = { renderProcess: defaultProcessOps, now: Date.now, ...given };
  const { paths, renderProcess, now } = deps;
  const lock = deps.lockWith ?? withLock;
  deps.lockWith = (path, fn, options) => lock(path, fn, {
    ...options, now, startTimeOf: renderProcess.startTimeOf,
    isAlive: renderProcess.lockHolderAlive ?? renderProcess.ownerAlive,
  });
  const { reaped } = await deps.relay.reapRegistry();
  const { awaiting, lines } = await reconcile({ deps });
  const ended = [];
  const ownerAlive = (pid, stamp) => renderProcess.ownerAlive(pid, stamp);
  const sessions = await deps.lockWith(paths.presentationLockPath, async () => {
    const current = await readSessions(paths.sessionsPath);
    for (const [sid, record] of Object.entries(current.ended)) {
      if (ownerAlive(record.pid, { starttime: record.starttime })) continue;
      delete current.ended[sid];
      ended.push(sid);
    }
    if (ended.length) await writeSessions(paths.sessionsPath, current);
    return current.sessions;
  });
  const { removed } = await pruneLedgers({
    transmitDir: paths.transmitDir, agents: sessions, ownerAlive,
    startTimeOf: renderProcess.startTimeOf, lockWith: deps.lockWith, now,
  });
  await pruneTerminalOwners({ transmitDir: paths.transmitDir, ownerAlive, lockWith: deps.lockWith });
  const { removed: swept } = await sweepTemps({
    dirs: [paths.stateDir, paths.transmitDir, join(paths.transmitDir, 'terminals')],
    pidExists: renderProcess.pidExists, now,
  });
  return { reaped, awaiting, ended, pruned: removed.length, swept: swept.length,
    lines: lines.map((line) => line.replace(/^familiar: observe:/, 'familiar: reap:')) };
}

export async function main({ command, args: rest, color, mode }) {
  const leafOptions = leafOptionsFor(command);
  if (command === 'setup claude-code' || command === 'setup relay') {
    parseLeaf(rest, leafOptions);
    // The launcher, not this file: what setup writes into a config must be what the
    // agent invokes, and the launcher is the one that checks dependencies first.
    const binPath = realpathSync(fileURLToPath(new URL('familiar', import.meta.url)));
    const agent = command.slice('setup '.length);
    process.stdout.write(`${JSON.stringify(setupDocument(agent, binPath), null, 2)}\n`);
  } else if (command === 'whoami') {
    const { positionals } = parseLeaf(rest, leafOptions);
    const cwd = positionals[0] ?? process.cwd();
    const resolver = await identityResolver();
    const { identity, prefix, warnings } = await resolver.resolve(cwd);
    reportTasksWarnings(warnings);
    const { hue } = slotSpec(identity.slot);
    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify({
        project: identity.project,
        theme: resolver.themeId,
        slot: identity.slot,
        color: identity.projectColor,
        source: identity.source,
        hue,
        member: { id: identity.member, label: identity.label },
      })}\n`);
      return;
    }
    process.stdout.write(
      `${identity.project}\n` +
      `  theme   ${resolver.themeId}\n` +
      `  slot    ${identity.slot} · hue ${hue}°\n` +
      (identity.projectColor ? `  colour  ${identity.projectColor} · ${prefix}\n` : '') +
      `  member  ${identity.label} (${identity.member})\n`,
    );
  } else if (command === 'projects') {
    const { positionals, values } = parseLeaf(rest, leafOptions);
    const resolver = await identityResolver();
    // With no DIR the pin catalog is the list. A `remote:` or `project:` pin
    // names no directory, so only `path:` pins can be walked.
    const given = positionals.length > 0
      ? positionals
      : resolver.catalog.identities.flatMap((pin) => (pin.path ? [pinPath(pin.path)] : []));
    // A path that is not there is a typo and an error. A path that is not a
    // directory is what `~/src/*` sweeps up beside the checkouts, and is skipped.
    const dirs = given.filter((dir) => {
      let stat;
      try {
        stat = statSync(dir);
      } catch {
        throw new Error(`no such directory: ${dir}`);
      }
      return stat.isDirectory();
    });
    const resolved = await Promise.all(dirs.map((dir) => resolver.resolve(dir)));
    reportTasksWarnings(resolved.flatMap(({ warnings }) => warnings));
    resolved.sort((a, b) => a.identity.project.localeCompare(b.identity.project));

    // The same view control, the same bounds, and the same reason as `theme show`.
    const viewRows = values.rows === undefined ? resolver.pack.rows : Number(values.rows);
    if (!Number.isInteger(viewRows) || viewRows < ROW_MIN || viewRows > ROW_MAX) {
      throw new Error(
        `--rows must be a whole number between ${ROW_MIN} and ${ROW_MAX} — got ${JSON.stringify(values.rows)}`
      );
    }
    const state = values.state ?? 'idle';
    if (!STATES.includes(state)) {
      throw new Error(`unknown state "${state}" — one of: ${STATES.join(', ')}`);
    }
    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify({
        theme: resolver.pack.id,
        projects: resolved.map(({ identity }) => ({
          project: identity.project,
          member: identity.member,
          label: identity.label,
          slot: identity.slot,
          color: identity.projectColor,
          source: identity.source,
        })),
      })}\n`);
      return;
    }
    const interactive = process.stdout.isTTY === true;
    const tmux = tmuxFacts(process.env);
    const capability = graphicsCapability(process.env, tmux);
    const frame = tmux?.ok ? wrapForTmux : (command) => command;
    const graphical = interactive && (
      capability === GRAPHICS_CAPABILITY.ANIMATION ||
      capability === GRAPHICS_CAPABILITY.STATIC
    );
    if (interactive && !graphical) {
      process.stderr.write(
        `familiar: no graphics capability (${capability})${describeTmux(tmux)} — showing captions only, no art\n`
      );
    }

    const useColor = cliColor({ color });
    const cells = resolved.map(({ identity }) => {
      const colors = identityColors(identity, resolver.tone);
      const swatch = cliSwatch(identity.projectColor ?? colors.base, { color: useColor });
      const name = useColor ? `${BOLD}${identity.project}${RESET}` : identity.project;
      // resolve() proved the member's assets exist. Idle is what a roster shows,
      // as it is for `theme show`; --state asks for another pose.
      const png = graphical
        ? readFileSync(assetsFor(resolver.pack, identity.member, resolver.tone.mode)[state].terminal)
        : null;
      return {
        lines: [
          `  ${swatch}  ${name}`,
          `      ${identity.label} · slot ${identity.slot} · ${identity.source}`,
        ],
        png,
        cols: png ? boxFor(png, viewRows).cols : 0,
      };
    });
    const gutter = 4;
    const width = interactive ? process.stdout.columns : undefined;
    // The sprite is part of the cell's width: a wide member must not overhang the
    // caption column beside it.
    const { cellWidth, perRow } = gridPlan(cells.map((c) => c.lines), {
      width, gutter, minCellWidth: Math.max(0, ...cells.map((c) => c.cols)),
    });

    process.stdout.write(`\n  ${resolver.pack.id} — ${resolver.pack.label}\n\n`);
    if (cells.length === 0) {
      process.stdout.write('  (no projects: pass directories, or pin paths in identities.yaml)\n\n');
    }
    for (let start = 0; start < cells.length; start += perRow) {
      const row = cells.slice(start, start + perRow);
      if (graphical) {
        // The caption's two-space indent is where the sprite's box starts too, so
        // the art sits over its own name; each advance is one whole cell.
        process.stdout.write('  ' + transmitAcross(
          row.map((c) => ({ png: c.png, cols: c.cols, advance: cellWidth + gutter })),
          { rows: viewRows, frame },
        ));
      }
      process.stdout.write(layoutRow(row.map((c) => c.lines), { cellWidth, gutter }).join('\n') + '\n\n');
    }
  } else if (command === 'niri focus') {
    // A bounded user click: no attention lock, no state, one socket exchange. The
    // integration is loaded only here so other commands never pay for it.
    const { positionals: [id] } = parseLeaf(rest, leafOptions);
    const { focusWorkspace, parseWorkspaceId } = await import('../integrations/niri/ipc.js');
    try {
      parseWorkspaceId(id);
    } catch (error) {
      throw usageError(error.message.replace(/^niri: /, ''), command);
    }
    await focusWorkspace(id, { socketPath: process.env.NIRI_SOCKET, timeoutMs: 2000 });
  } else if (command.startsWith('attention ')) {
    const { positionals } = parseLeaf(rest, leafOptions);
    await runAttentionCommand(command, positionals, {
      paths: resolvePaths(), stdin: readStdin, stdout: process.stdout, now,
    });
  } else if (command === 'statusline') {
    const { values } = parseLeaf(rest, leafOptions);
    // THE OTHER HALF OF THE TERMINAL RENDERER. The hook transmitted the image (invisibly, under
    // an id derived from the session). This prints the CELLS it lands in -- ordinary characters,
    // which claude-code's own layout engine places, wraps and scrolls. That is the whole reason
    // the cat stopped being an overlay: it is text now, and text cannot obscure text.
    //
    // It transmits nothing of its own. See src/render/term/statusline.js -- two processes
    // chunking graphics escapes into one fd is a corrupt escape stream. The one exception is
    // settling a provisional SessionStart image, which it does inside the hooks' own
    // terminal ownership and per-session transmit locks (settleStatusline below).
    const stdin = await readStdin();
    const payload = JSON.parse(stdin || '{}');
    const sessionId = payload.session_id;

    const ctx = await context();
    const { sessions } = await readSessions(ctx.paths.sessionsPath);
    const record = sessionId ? sessions[sessionId] : undefined;

    // RESOLVE THE INTENT FIRST — before running --with — because the cat's height decides how
    // much of the wrapped text fits beside it. Resolve one session only: a broken config in
    // ANOTHER project must not fault this status line.
    let intent;
    let visualFault;
    if (record) {
      const one = { [sessionId]: record };
      const { identities, spriteFor, animationFor, worldFor, faults } = await makePrepareSprites(ctx)(one);
      if (faults.has(sessionId)) {
        visualFault = `session ${sessionId}: ${faults.get(sessionId)}`;
      } else {
        // Keep the decay contract: polling must not show done/error forever. The theme's world
        // is proven lazily inside resolveAll, so a broken world throws here: it is the same
        // visual fault as a sprite failure (HUD on stdout, the fault on stderr), not a crash.
        try {
          const intentRecord = resolveAll({
            agents: one,
            identities,
            tone: ctx.tone,
            spriteFor,
            animationFor,
            worldFor,
            motionPolicy: ctx.motionPolicy,
          })[sessionId];
          intent = displayedIntent(intentRecord, now());
        } catch (error) {
          visualFault = `session ${sessionId}: ${error.message}`;
        }
      }
    }

    const wrapped = values.with ?? null;
    const rawOutput = wrapped ? runWrapped(wrapped, stdin) : null;

    // NO CAT IS NOT A FALLBACK, IT IS THE TRUTH. A session not on the bus has no identity yet
    // — the first hook has not fired, or it was evicted.
    //
    // BUT THE HUD STILL RENDERS, and this is the one place dropping --with changes existing
    // control flow. This branch used to print `rawOutput ?? ''`; with no --with that is null,
    // and printing it is a BLANK STATUS LINE for every session until its first hook fires.
    // No identity means no hue and no state — so the HUD renders uncoloured, with the state
    // slot reading as absent, at the full four rows (there is no cat here to fit against).
    if (!intent) {
      const output = wrapped ? rawOutput
        : hudLines({ intent: null, fields: readFields(payload), rows: 4 }).join('\n') + '\n';
      process.stdout.write(output);
      if (visualFault !== undefined) {
        process.stderr.write(`familiar: statusline: ${visualFault.replace(/[\r\n]+/g, ' ')}\n`);
      }
      return;
    }

    // The HUD is fitted to the number of rows the composed output will actually occupy: the
    // cat's height when there is a cat, and the full four when motion is off and there is not.
    // Field collection belongs inside the native branch: readFields performs a synchronous,
    // bounded git lookup, and --with replaces the HUD rather than paying to build unused fields.
    const hudRows = intent.motionPolicy === 'off' ? 4 : intent.sprite.rows;
    const text = wrapped
      ? rawOutput
      : hudLines({
        intent,
        // THE PROJECT IS THE IDENTITY'S, NOT THE DIRECTORY'S. identity.project is the repo the
        // familiar resolved — the thing that chose the slot, the hue and the member. In
        // ~/repo/packages/api, basename(cwd) is `api` while the identity is `repo`, and a HUD
        // labelled `api` beside an ember cat that means `repo` contradicts itself.
        fields: { ...readFields(payload), project: intent.identity.project },
        rows: hudRows,
      }).join('\n');

    const lines = composeForIntent({ intent, sessionId, rawOutput: text });
    process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));

    // After the line is written, so a failure here cannot blank it. The cells just printed
    // name an image a SessionStart hook may have sent to a screen the TUI is not showing.
    if (intent.motionPolicy !== 'off') {
      await settleStatusline({ record, intent, paths: ctx.paths });
    }
  } else if (command === 'install pets') {
    const { values } = parseLeaf(rest, leafOptions);
    if (values.out !== undefined && values['sync-projects']) {
      throw usageError('--sync-projects cannot be combined with --out', 'install pets');
    }
    // AN OFFLINE GENERATOR THAT HAPPENS TO LIVE IN THE CLI, like the compositor integration's own
    // rule generator.
    // It runs once, at install; nothing on the hook path imports it.
    //
    // ONE PET PER MEMBER. Codex 0.146 resolves `[tui] pet` through its normal config layers, so a
    // user-wide default and an override in a trusted project's `.codex/config.toml` can choose
    // different members. Config remains user-owned unless --sync-projects explicitly opts into
    // Familiar-managed local files; tracked project config is never rewritten.
    const paths = resolvePaths();
    const config = await loadConfig({ paths });
    if (config.motionPolicy === 'off') {
      throw new Error(
        'pets are disabled while motion is off; set motion to full or reduced to install Codex pets',
      );
    }
    const out = values.out !== undefined
      ? values.out
      : join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'pets');

    const ctx = await context({ paths, config });
    // SHIM (Task C9 replaces it): the default theme's pets only, until install pets
    // compiles every live theme's members under `familiar-<theme>--<member>`.
    const themeId = ctx.themes.themeId;
    await ctx.themes.load([themeId]);
    const pack = ctx.themes.packFor(themeId);
    const projectSync = values['sync-projects']
      ? await planCodexProjectSync({ catalog: ctx.catalog, pack, cwd: process.cwd() })
      : null;
    if (projectSync) reportTasksWarnings(projectSync.warnings);

    let written = 0;
    for (const [memberId, member] of pack.members) {
      // The SAME resolver every other surface uses — not a second path to the same PNGs. The
      // sprites codex renders are byte-for-byte the ones the terminal and the bar render.
      const assets = assetsFor(pack, memberId, ctx.tone.mode);
      const poses = Object.fromEntries(
        STATES.map((state) => [state, decodeRgba(readFileSync(assets[state].terminal))]),
      );
      const { set: animationSet } = await loadAnimationMember(pack, memberId);

      const id = `familiar-${memberId}`;
      const dir = join(out, id);
      mkdirSync(join(dir, 'assets'), { recursive: true });

      // INVALIDATE FIRST. Between here and the stamp write this pet is
      // half-replaced; without this unlink an interruption would leave the OLD
      // stamp vouching for a NEW, incomplete sheet — the one state the asset
      // gate cannot detect, because a stamp is exactly what it trusts.
      rmSync(join(dir, STAMP_FILE), { force: true });

      const sheet = encodeRgba(spritesheet({
        animationSet,
        roots: poses,
        anchor: member.anchor,
        motionPolicy: ctx.motionPolicy,
        readFrame: (path) => decodeRgba(readFileSync(path)),
      }));
      writeFileSync(join(dir, SPRITESHEET_PATH), sheet);
      writeFileSync(
        join(dir, 'pet.json'),
        JSON.stringify(petFile({
          id,
          displayName: member.label ?? memberId,
          description: member.persona ?? `familiar — ${member.label ?? memberId}`,
        }), null, 2) + '\n',
      );

      // PUBLISH LAST. The stamp is the only thing that says "this pet is
      // complete and belongs to this theme", so it is the last byte written.
      writeFileSync(join(dir, STAMP_FILE), JSON.stringify(stampFor({
        themeId,
        memberId,
        frame: FRAME,
        motionPolicy: ctx.motionPolicy,
        anchor: member.anchor ?? 'floor',
        sheet,
      }), null, 2) + '\n');
      written++;
    }

    if (projectSync) applyCodexProjectSync(projectSync);

    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify({
        written, out,
        sync: projectSync ? {
          configs: projectSync.configs.length,
          manual: projectSync.manual,
          missing: projectSync.missing,
          unpinnedSkip: projectSync.unpinnedSkip ?? null,
        } : null,
      })}\n`);
      return;
    }

    process.stdout.write(`wrote ${written} pets to ${out}\n`);
    if (!projectSync) {
      const userConfig = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
      process.stdout.write(
        'enable one with:  [tui] pet = "custom:familiar-<member>"\n' +
        `user-wide: ${userConfig}\n` +
        'project (trusted): <project>/.codex/config.toml\n',
      );
    }
    if (projectSync) {
      process.stdout.write(
        `synced ${projectSync.configs.length} project pet config`
        + `${projectSync.configs.length === 1 ? '' : 's'}\n`,
      );
      for (const { path, setting } of projectSync.manual) {
        process.stdout.write(`tracked project config left unchanged: ${path}\nadd manually:\n${setting}`);
      }
      for (const path of projectSync.missing) {
        process.stdout.write(`skipped missing identity path: ${path}\n`);
      }
      if (projectSync.unpinnedSkip) {
        const { path, reason } = projectSync.unpinnedSkip;
        process.stdout.write(`did not sync the current directory (${path}): ${reason}\n`);
      }
    }
  } else if (command === 'reap') {
    parseLeaf(rest, leafOptions);
    const { lines, ...result } = await reap({
      deps: { paths: resolvePaths(), relay: { reapRegistry, readSnapshot } },
    });
    for (const line of lines) process.stderr.write(`${line}\n`);
    if (lines.length) process.exitCode = 1;
    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const { reaped, awaiting, ended, pruned, swept } = result;
    if (reaped.length > 0) process.stdout.write(`reaped ${reaped.join(' ')}\n`);
    if (awaiting.length > 0) process.stdout.write(`awaiting ${awaiting.join(' ')}\n`);
    if (ended.length > 0) process.stdout.write(`ended ${ended.join(' ')}\n`);
    if (pruned > 0) process.stdout.write(`pruned ${pruned} transmission ledger(s)\n`);
    if (swept > 0) process.stdout.write(`swept ${swept} orphaned temp file(s)\n`);
  } else if (command === 'install opencode') {
    // The path-knowing installer lives in a sibling binary (bin/familiar-opencode) because the
    // portability seam forbids THIS file from naming the integration directory. Its output is
    // CAPTURED, not inherited: a synchronous spawnSync already has the child's complete stdout
    // and stderr in memory by the time it returns (no draining race, unlike the execFileSync it
    // replaces), which is what lets a --json invocation repackage it below. `--help` and a
    // failing install still get the child's own text verbatim, on the same streams, with the
    // same exit code as before -- only a SUCCESSFUL, non-help, --json run is reshaped.
    //
    // The options are validated HERE against the declared row before anything is forwarded,
    // the way every other leaf validates its own: an undeclared option is a usage error
    // (exit 2) from this binary, not a child failure (exit 1) relayed verbatim. Only the
    // declared options, in canonical `--name value` form, reach the child; its own parser
    // keeps guarding direct `familiar-opencode` invocations and the mutual exclusion.
    const bin = fileURLToPath(new URL('familiar-opencode', import.meta.url));
    const isHelp = rest[0] === '-h' || rest[0] === '--help';
    const forwarded = isHelp ? [rest[0]] : Object.entries(parseLeaf(rest, leafOptions).values)
      .flatMap(([name, value]) => [`--${name}`, value]);
    const result = spawnSync(process.execPath, [bin, ...forwarded], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0 || isHelp || mode !== 'json') {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 1;
      return;
    }
    // The wrapper's own two report lines ("wrote <path>", "left for you: <message>") become
    // the JSON shape every other command's success path uses.
    process.stdout.write(`${JSON.stringify({
      written: [...result.stdout.matchAll(/^wrote (.+)$/gm)].map((m) => m[1]),
      manual: [...result.stdout.matchAll(/^left for you: (.+)$/gm)].map((m) => m[1]),
    })}\n`);
  } else if (command === 'scheme set') {
    const { positionals, values } = parseLeaf(rest, leafOptions);
    // Validated against the declared enum, not a hand-kept list: the same row completion
    // offers dark/light from.
    const [{ name: schemeArgName, values: schemeValues }] = commandAt(['scheme', 'set']).args;
    if (!schemeValues.includes(positionals[0])) {
      throw usageError(
        `${schemeArgName} must be one of ${schemeValues.join(', ')}, got ${JSON.stringify(positionals[0])}`,
        'scheme set',
      );
    }
    // The portable escape hatch. Without it, a machine with no bar cannot produce
    // a scheme.json at all, and `familiar` refuses to run — which would make the
    // "no compositor, no bar" promise false.
    const paths = resolvePaths();
    const tone = {
      mode: positionals[0],
      satScale: values.sat === undefined ? 1.0 : Number(values.sat),
    };
    await writeTone(paths, tone);
    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify({
        scheme: tone.mode, saturation: tone.satScale, path: paths.schemePath,
      })}\n`);
      return;
    }
    process.stdout.write(
      `scheme ${tone.mode} · saturation ${tone.satScale}\n` +
      `wrote ${paths.schemePath}\n`,
    );
  } else if (command === 'theme preview') {
    const { positionals, values } = parseLeaf(rest, leafOptions);
    const memberId = positionals[0];

    const paths = resolvePaths();
    const { themeId: activeId } = await loadConfig({ paths });
    const themeId = values.theme ?? activeId;

    const rows = listThemes(paths);
    const row = rows.find((r) => r.id === themeId);
    if (!row) {
      throw new Error(
        `unknown theme "${themeId}" — available: ${rows.map((r) => r.id).join(', ') || '(none)'}`
      );
    }
    const pack = loadThemePackSync(row.dir);
    // schemeMode, not mode: the terminal colour scheme (dark|light), not the
    // --json/--pretty output mode main() already destructured as `mode`.
    const { mode: schemeMode } = await loadTone({ paths });

    if (values.state !== undefined && !STATES.includes(values.state)) {
      throw new Error(`unknown state "${values.state}" — one of: ${STATES.join(', ')}`);
    }
    const states = values.state === undefined ? STATES : [values.state];

    const member = memberOrThrow(pack, memberId);
    const assets = assetsFor(pack, memberId, schemeMode);

    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify({
        theme: themeId,
        member: { id: memberId, label: member.label, persona: member.persona, roles: member.roles },
        states: states.map((state) => ({ state, pose: member.poses[state] })),
      })}\n`);
      return;
    }

    const tmux = tmuxFacts(process.env);
    const capability = graphicsCapability(process.env, tmux);
    const frame = tmux?.ok ? wrapForTmux : (command) => command;
    const graphical = process.stdout.isTTY === true && (
      capability === GRAPHICS_CAPABILITY.ANIMATION ||
      capability === GRAPHICS_CAPABILITY.STATIC
    );
    process.stdout.write(`\n  ${member.label} · ${themeId} · roles ${rolesText(member.roles)}\n  ${member.persona}\n\n`);
    for (const state of states) {
      // Caption UNDER the art, for the same constant-box reason as the theme grid
      // below — see the note there. The pose text is long enough to wrap, which made
      // the mis-association worse here than anywhere else.
      // ALWAYS pass the env explicitly. preview IS the interactive process, so its own
      // environment is the right one — and saying so here means graphicsCapability() needs
      // no default, which is what stops any OTHER caller silently asking the wrong
      // process. A default that is correct in one branch and wrong in the other is a
      // default worth not having.
      // THE SAME HEIGHT THE EMITTER USES, from the same place: the theme's one row
      // count, carried onto every state's asset as assets[state].rows. A preview that
      // renders at a different height than the live terminal is not a preview.
      if (graphical) {
        process.stdout.write(transmit(readFileSync(assets[state].terminal), { rows: assets[state].rows, frame }));
      }
      process.stdout.write(`  ${state}: ${member.poses[state]}\n`);
    }
  } else if (command === 'theme add') {
    const { positionals } = parseLeaf(rest, leafOptions);
    const paths = resolvePaths();
    const { themeId: activeId } = await loadConfig({ paths });
    const result = await addTheme({ paths, source: positionals[0] });
    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify({
        id: result.id, dir: result.dir, members: result.members, active: result.id === activeId,
      })}\n`);
      return;
    }
    process.stdout.write(`installed theme '${result.id}' (${result.members} members) at ${result.dir}\n`);
    if (result.id !== activeId) {
      process.stdout.write(`activate with: set "theme: ${result.id}" in ${paths.configPath}\n`);
    }
  } else if (command === 'theme list') {
    parseLeaf(rest, leafOptions);
    // Deliberately NOT context(): a broken theme on disk must not stop you
    // LISTING what is on disk — that is exactly when you need the list. Each
    // pack is loaded independently and a failure is reported on its own row.
    const paths = resolvePaths();
    const { themeId: activeId } = await loadConfig({ paths });
    const rows = listThemes(paths);

    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify(rows.map((row) => {
        let pack = null, error = null;
        try { pack = loadThemePackSync(row.dir); } catch (err) { error = err.message; }
        return {
          id: row.id,
          active: row.id === activeId,
          source: row.shadowed ? 'user (shadows shipped)' : row.source,
          label: pack?.label ?? null,
          members: pack ? pack.members.size : null,
          description: pack?.description ?? null,
          error,
        };
      }))}\n`);
      return;
    }

    process.stdout.write('\n');
    for (const row of rows) {
      const status = row.id === activeId ? 'active' : '';
      let detail;
      try {
        const pack = loadThemePackSync(row.dir);
        const source = row.shadowed ? 'user (shadows shipped)' : row.source;
        // pack.label is required non-empty by parseThemePack, and pack.members
        // is a Map — hence .size, not .length.
        detail = `${pack.label.padEnd(16)}${String(pack.members.size).padStart(2)} members   ${source}`;
        if (pack.description) detail += `\n${' '.repeat(24)}${pack.description}`;
      } catch (error) {
        detail = `— unreadable: ${error.message}`;
      }
      if (row.source === 'user') {
        const read = readReceipt(paths, row.id);
        const receiptNote = read.verdict === 'validated'
          ? `validated ${read.receipt.installedAt.slice(0, 10)} from ${sanitize(read.receipt.source.kind === 'https' ? read.receipt.source.url : read.receipt.source.path)}`
          : read.verdict === 'invalid'
            ? `invalid receipt at ${sanitize(receiptPath(paths, row.id))} (${sanitize(read.reason)}) — remove it and reinstall the theme`
            : 'never validated (manual install)';
        detail += `\n${' '.repeat(24)}${receiptNote}`;
      }
      process.stdout.write(`  ${row.id.padEnd(12)}${status.padEnd(10)}${detail}\n`);
    }
    const staging = stagingStatus(paths);
    if (staging === 'occupied') {
      process.stdout.write('  theme add staging present — another add may be running; abandoned staging is cleaned by the next add\n');
    } else if (staging === 'not-a-directory') {
      process.stdout.write(`  ${join(paths.userThemesDir, '.staging')} is not a directory — remove it\n`);
    }
    process.stdout.write('\n');
  } else if (command === 'theme validate') {
    const { positionals } = parseLeaf(rest, leafOptions);
    const pack = await validateThemePack(resolve(positionals[0]));
    // `default` first, then every other role in the order the members declare them.
    const roles = [DEFAULT_ROLE, ...[...pack.byRole.keys()].filter((role) => role !== DEFAULT_ROLE)];
    const locales = pack.world === null ? null
      : [...pack.world.locales].map(([name, locale]) => ({ name, places: locale.places.length }));
    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify({
        id: pack.id, label: pack.label, members: pack.members.size, roles,
        defaultMember: defaultMember(pack), world: locales === null ? null : { locales },
        specVersion: pack.specVersion,
      })}\n`);
      return;
    }
    const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    process.stdout.write(
      `${pack.id} — ${pack.label}\n` +
      `  ${plural(pack.members.size, 'member')}; default member ${defaultMember(pack)}\n` +
      `  roles ${roles.map((role) => `${role} (${pack.byRole.get(role)})`).join(', ')}\n` +
      `  world ${locales === null ? 'none'
        : locales.map(({ name, places }) => `${name} (${plural(places, 'place')})`).join(', ')}\n` +
      `  conforms to spec-version ${pack.specVersion}\n`,
    );
  } else if (command === 'theme show') {
    const { positionals, values } = parseLeaf(rest, leafOptions);
    const paths = resolvePaths();
    const { themeId: activeId } = await loadConfig({ paths });
    const rows = listThemes(paths);

    // --rows lowers the render height so more of the roster fits on one screen.
    // It is a VIEW control and never touches the theme: pack.rows is the height
    // the surfaces ship at, and this must not be mistaken for changing it.
    //
    const rowsArg = values.rows;
    const wanted = positionals[0] ?? activeId;

    const row = rows.find((r) => r.id === wanted);
    if (!row) {
      throw new Error(
        `unknown theme "${wanted}" — available: ${rows.map((r) => r.id).join(', ') || '(none)'}`
      );
    }

    const pack = loadThemePackSync(row.dir);
    const ctxTone = await loadTone({ paths });
    // schemeMode, not mode: this is the terminal colour scheme (dark|light), not
    // the --json/--pretty output mode main() already destructured as `mode`.
    const { mode: schemeMode } = ctxTone;

    if (mode === 'json') {
      // The fault is the member's asset proof, the same one the text view draws from.
      const members = [...pack.members.values()].map((member) => {
        let fault = null;
        try {
          assetsFor(pack, member.id, schemeMode);
        } catch (error) {
          fault = error.message;
        }
        return { id: member.id, label: member.label, roles: member.roles, fault };
      });
      process.stdout.write(`${JSON.stringify({
        id: row.id, label: pack.label, source: row.source, shadowed: row.shadowed ?? false, members,
      })}\n`);
      return;
    }

    const interactive = process.stdout.isTTY === true;
    const tmux = tmuxFacts(process.env);
    const capability = graphicsCapability(process.env, tmux);
    const frame = tmux?.ok ? wrapForTmux : (command) => command;
    const graphical = interactive && (
      capability === GRAPHICS_CAPABILITY.ANIMATION ||
      capability === GRAPHICS_CAPABILITY.STATIC
    );

    // THIS VERB'S ENTIRE VALUE IS THE ART — README says `familiar theme show` renders
    // the theme's members WITH their art. Without graphics (a plain TERM, or a
    // tmux pane the probe refuses — and for tmux it says which setting) it silently
    // degrades to a bare member listing. `preview` stays quiet about this on
    // purpose (test/bin-familiar.test.js pins that); `theme` does not, because
    // a human judging whether a cast coheres as a set needs to know
    // they are looking at labels, not the set.
    if (interactive && !graphical) {
      process.stderr.write(
        `familiar: no graphics capability (${capability})${describeTmux(tmux)} — showing labels only, no art\n`
      );
    }

    // ROW_MIN/ROW_MAX come from pack.js — the SAME bound the parser enforces on a
    // theme's own `rows:`. A second hand-copied "1 and 40" here is exactly the
    // mirror-with-nothing-enforcing-it defect pack.js's own comment on these
    // constants names; box.js already imports them for the same reason.
    const viewRows = rowsArg === undefined ? pack.rows : Number(rowsArg);
    if (!Number.isInteger(viewRows) || viewRows < ROW_MIN || viewRows > ROW_MAX) {
      throw new Error(
        `--rows must be a whole number between ${ROW_MIN} and ${ROW_MAX} — got ${JSON.stringify(rowsArg)}`
      );
    }

    // The header names the DIRECTORY (row.id), not pack.id. themeDirFor resolves
    // by directory, so a pack whose theme.yaml disagrees is still reached by the
    // directory's name — printing pack.id would name something unreachable.
    process.stdout.write(`\n  ${row.id} — ${pack.label} · ${row.source}${row.shadowed ? ' (shadows shipped)' : ''}\n`);
    if (pack.description) process.stdout.write(`  ${pack.description}\n`);
    process.stdout.write('\n');

    // DECLARATION ORDER: the cast as its author wrote it. Since spec-version 2 a member
    // holds roles, not slots, so the caption names the roles a member answers to.
    const idWidth = Math.max(...[...pack.members.keys()].map((id) => id.length));
    for (const member of pack.members.values()) {
      // assetsFor + readFileSync + transmit live in ONE try per member. The build
      // workflow writes every member block up front and fills sprites one member at
      // a time, so every intermediate state of a theme under construction has more
      // members than sprite sets — assetsFor throwing on a faulted asset-root or a
      // missing <state>.png is the ORDINARY case this view exists to survive, not an
      // edge case. One bad member labels itself; the others still draw.
      let fault = null;
      let rendered = null;
      try {
        const assets = assetsFor(pack, member.id, schemeMode);
        if (graphical) {
          // A STRIP, NOT A GRID, and that is a property of transmit(): it sends
          // C=1 (the image does not move the cursor) and then advances by hand
          // with exactly `rows` newlines, so consecutive images always stack
          // vertically. Side by side would need a placement-capable
          // emitter that does not exist — see the spec's §1.2 and §9.
          rendered = transmit(readFileSync(assets.idle.terminal), { rows: viewRows, frame });
        }
      } catch (error) {
        fault = error.message;
      }

      // THE CAPTION GOES UNDER THE SPRITE, and the reason is that transmit() always
      // advances by the full `rows` regardless of how much of that box the art fills,
      // so a sleeping loaf leaves most of its box empty at the TOP. With the label
      // printed first, that empty space opens up between a label and the sprite it
      // names, and closes the gap to the sprite ABOVE it — every short pose captions
      // the wrong cat. Printing the caption afterwards puts it against the bottom of
      // a box of CONSTANT height, which is what makes the association read correctly
      // — for a floor-anchored member the art reaches that edge, and for a
      // center-anchored one the box does.
      if (rendered) process.stdout.write(rendered);

      process.stdout.write(
        `  ${member.label.padEnd(20)}${member.id.padEnd(idWidth)}  ${rolesText(member.roles)}`
        + `${fault === null ? '' : `  ${fault}`}\n`
      );
    }
    process.stdout.write('\n');
  } else if (command === 'theme sheet') {
    const { values } = parseLeaf(rest, leafOptions);
    // THE WHOLE THEME AT A GLANCE: one row per member, six poses across it, at whatever
    // height fits your screen. `theme` shows every member in ONE state and `preview`
    // shows one member in six — the sheet neither of them can draw is the one that puts
    // every member beside every state, and that is the view you want when judging
    // whether a roster reads as a set.
    //
    // Each row is composed into a SINGLE image before it is transmitted, because
    // transmit() stacks and cannot place (see contact.js). That also means --out can
    // hand back the exact same picture as a file, which is the only way to look at this
    // on a terminal without kitty graphics.
    const paths = resolvePaths();
    const { themeId: activeId } = await loadConfig({ paths });

    const { rows: rowsArg, theme: themeArg, member: memberArg, out: outArg } = values;

    const wanted = themeArg ?? activeId;
    const pack = loadThemePackSync(themeDirFor(paths, wanted));
    const ctxTone = await loadTone({ paths });
    // schemeMode, not mode: the terminal colour scheme (dark|light), not the
    // --json/--pretty output mode main() already destructured as `mode`.
    const { mode: schemeMode } = ctxTone;

    // The same bounds and the same meaning as `theme --rows`: a VIEW control that never
    // touches pack.rows. Default is the theme's own height, so an unflagged contact
    // sheet shows the art at the size the live surfaces ship it at.
    const viewRows = rowsArg === undefined ? pack.rows : Number(rowsArg);
    if (!Number.isInteger(viewRows) || viewRows < ROW_MIN || viewRows > ROW_MAX) {
      throw new Error(
        `--rows must be a whole number between ${ROW_MIN} and ${ROW_MAX} — got ${JSON.stringify(rowsArg)}`
      );
    }

    const ids = memberArg === undefined
      ? [...pack.members.keys()]
      : [memberOrThrow(pack, memberArg).id];

    // json with no --out has no file to describe and nothing worth rendering (a
    // sprite belongs in the terminal or in --out's PNG, never embedded in JSON) --
    // metadata only, before any image decoding runs.
    if (mode === 'json' && outArg === undefined) {
      process.stdout.write(`${JSON.stringify({ theme: pack.id, label: pack.label, members: ids, states: STATES })}\n`);
      return;
    }

    // ONE BOX FOR THE WHOLE SHEET, computed before anything is drawn. Members have
    // different canvas sizes, so scaling each to the same HEIGHT still leaves them
    // different widths — and columns that do not line up defeat the point of reading
    // down a column. Every frame is padded to the widest one instead.
    const FRAME_H = 128;   // composition height; the terminal scales the finished row
    const decoded = ids.map((id) => ({
      id,
      member: memberOrThrow(pack, id),
      frames: STATES.map((state) => {
        const assets = assetsFor(pack, id, schemeMode);
        return {
          ...scaleTo(decodeRgba(readFileSync(assets[state].terminal)), { height: FRAME_H }),
          anchor: memberOrThrow(pack, id).anchor,
        };
      }),
    }));
    const boxW = Math.max(...decoded.flatMap((row) => row.frames.map((f) => f.w)));
    const boxed = decoded.map((row) => ({
      ...row,
      frames: row.frames.map((f) => padTo(f, { width: boxW, height: FRAME_H })),
    }));

    if (outArg !== undefined) {
      const grid = composeGrid(boxed.map((row) => row.frames), { gap: 8, rowGap: 16 });
      writeFileSync(outArg, encodeRgba(grid));
      if (mode === 'json') {
        process.stdout.write(`${JSON.stringify({
          theme: pack.id, members: ids, states: STATES, out: outArg, width: grid.w, height: grid.h,
        })}\n`);
        return;
      }
      process.stdout.write(
        `\n  ${pack.id} — ${STATES.join(', ')}\n`
        + `  ${boxed.length} member${boxed.length === 1 ? '' : 's'} x ${STATES.length} states -> ${outArg} (${grid.w}x${grid.h})\n\n`
      );
      return;
    }

    const interactive = process.stdout.isTTY === true;
    const tmux = tmuxFacts(process.env);
    const capability = graphicsCapability(process.env, tmux);
    const frame = tmux?.ok ? wrapForTmux : (command) => command;
    const graphical = interactive && (
      capability === GRAPHICS_CAPABILITY.ANIMATION ||
      capability === GRAPHICS_CAPABILITY.STATIC
    );
    process.stdout.write(`\n  ${pack.id} — ${pack.label}\n  ${STATES.join('   ')}\n\n`);
    const captions = sheetRowCaptions(boxed);
    for (const [index, row] of boxed.entries()) {
      if (graphical) {
        process.stdout.write(transmit(encodeRgba(composeStrip(row.frames, { gap: 8 })), { rows: viewRows, frame }));
      }
      // Caption UNDER the art, same constant-box reason as `theme` — see the note there.
      process.stdout.write(captions[index]);
    }
    if (interactive && !graphical) {
      process.stderr.write(
        'familiar: this terminal does not advertise kitty graphics, so no art was drawn — '
        + 'use `--out FILE` to write the contact sheet as a PNG\n'
      );
    }
    process.stdout.write('\n');
  } else {
    throw new Error(`resolved command ${JSON.stringify(command)} is not implemented`);
  }
}
