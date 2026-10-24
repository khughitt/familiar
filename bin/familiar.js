import { loadContext as context, makePrepareSprites } from '../src/observe/context.js';
export { makePrepareSprites } from '../src/observe/context.js';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
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
import { BOLD, fg, RESET, sanitize } from '../src/render/term/sgr.js';
import { reapRegistry, readSnapshot, adapterFor, createProcessOps as createRelayProcessOps } from 'relay';
import { observe, reconcile } from '../src/observe/run.js';
import { runAttentionCommand } from '../src/attention/commands.js';
import { readSessions, writeSessions } from '../src/bus/sessions.js';
import { pruneTerminalOwners, withTerminal } from '../src/render/term/terminal-owner.js';
import { withLock } from '../src/bus/lock.js';
import { defaultProcessOps } from '../src/bus/proc.js';
import { resolveIdentity, resolveAll } from '../src/bus/resolve.js';
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
import { readJson } from '../src/bus/store.js';
import { GRAPHICS_CAPABILITY, graphicsCapability } from '../src/render/term/capability.js';
import { transmit, transmitAcross } from '../src/render/term/kitty.js';
import { boxFor } from '../src/render/term/box.js';
import { composeStrip, composeGrid, scaleTo, padTo } from '../src/render/term/contact.js';
import {
  loadThemePack, loadThemePackSync, memberOrThrow, defaultMemberForSlot, ROW_MIN, ROW_MAX,
  assetsFor, SLOT_COUNT, STATES, loadAnimationMember, validateThemePack, decodeRgba, encodeRgba,
} from 'familiar-theme';
import {
  FAMILIES, ROOT_LEAVES, commandAt, parseArgsOptions, stripGlobals, candidates, completionScript,
} from '../src/commands.js';

export function cliColor({ stream = process.stdout, env = process.env, color = 'auto' } = {}) {
  if (color === 'never') return false;
  if (color === 'always') return true;
  return stream.isTTY === true && (env.NO_COLOR === undefined || env.NO_COLOR === '');
}

export function cliSwatch(hex, { color = cliColor() } = {}) {
  return color ? `${fg(hex)}███${RESET}` : hex;
}

const HELP_FLAGS = new Set(['-h', '--help']);

function usageError(message, help) {
  return Object.assign(new Error(message), { help });
}

// minPositionals/maxPositionals for a declared command's args: required ones set the
// floor, a variadic arg lifts the ceiling to unbounded, and an argless command is 0/0
// -- the same defaults parseLeaf already had.
function positionalBounds(cmd) {
  const args = cmd?.args ?? [];
  return {
    minPositionals: args.filter((a) => a.required).length,
    maxPositionals: args.some((a) => a.variadic) ? Infinity : args.length,
  };
}

export function resolveCommand(argv) {
  if (argv.length === 0 || HELP_FLAGS.has(argv[0])) return { command: null, args: [], help: 'root' };
  const [first, second, ...tail] = argv;
  const children = FAMILIES.get(first);
  if (children) {
    if (second === undefined || HELP_FLAGS.has(second)) return { command: null, args: [], help: first };
    if (!children.has(second)) throw usageError(`unknown ${first} command ${JSON.stringify(second)}`, first);
    const command = `${first} ${second}`;
    if (HELP_FLAGS.has(tail[0])) return command === 'install opencode'
      ? { command, args: [tail[0]], help: null }
      : { command, args: [], help: command };
    return { command, args: tail, help: null };
  }
  if (!ROOT_LEAVES.has(first)) throw usageError(`unknown command ${JSON.stringify(first)}`, 'root');
  if (HELP_FLAGS.has(second)) return { command: first, args: [], help: first };
  return { command: first, args: argv.slice(1), help: null };
}

export function parseLeaf(args, {
  options = {}, minPositionals = 0, maxPositionals = minPositionals, help,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true, tokens: true });
  } catch (error) {
    let message = error.message;
    if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') message = message.split('. ')[0];
    if (error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && message.includes('argument is ambiguous')) {
      const option = message.match(/Option '(--[^']+)'/)?.[1];
      if (option) message = `${option} requires a value`;
    }
    throw usageError(message, help);
  }
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (typeof token.value === 'string' && (token.value === '' || token.value.startsWith('-'))) {
      throw usageError(`--${token.name} requires a value`, help);
    }
    if (seen.has(token.name)) throw usageError(`duplicate --${token.name} flag`, help);
    seen.add(token.name);
  }
  if (parsed.positionals.length < minPositionals || parsed.positionals.length > maxPositionals) {
    const found = parsed.positionals[maxPositionals];
    throw usageError(found === undefined ? `missing required argument for ${help}`
      : `unexpected argument ${JSON.stringify(found)}`, help);
  }
  return parsed;
}

const HELP = {
  root: `familiar — your coding agent gets a face

Usage:
  familiar <command> [options]

Explore
  whoami [PATH]                Show this project's familiar identity
  projects [DIR...]            Show every project's familiar, coloured, pinned or hashed
  theme list                   List installed themes
  theme add SOURCE             Install a theme from an HTTPS URL or local directory
  theme validate DIR           Prove a theme directory conforms
  theme show [ID]              Show a theme's twelve members
  theme preview MEMBER         Preview one member and its states
  theme sheet                  Show every member across every state

Set up
  scheme set dark|light        Set the terminal colour scheme
  install pets                 Install the active theme as Codex pets
  install opencode             Install the OpenCode integration
  setup claude-code            Print Claude Code integration settings
  setup relay                  Print familiar's relay observer entries

Runtime
  observe                      Project relay's registry into presentation state
  statusline                   Render the Claude Code status line
  reap                         Prune relay's registry and reconcile presentation

Desktop
  niri focus ID                Focus a Niri workspace by its stable ID
  attention status             Print the desktop attention view
  attention dismiss ID...      Dismiss attention episodes and diagnostics by ID
  attention popup              Serve one familiar popup control request

Examples:
  familiar whoami
  familiar theme preview ginger --state working
  familiar scheme set dark

Run \`familiar <command> --help\` for details.
`,
  whoami: `Show a project's familiar identity.

Usage:
  familiar whoami [PATH]

Arguments:
  PATH            Project path; defaults to the current directory

Examples:
  familiar whoami
  familiar whoami /path/to/project
`,
  projects: `Show every project's familiar, in a grid.

Usage:
  familiar projects [DIR...] [--rows N] [--state STATE]

Arguments:
  DIR             Project directories; default to the paths pinned in identities.yaml.
                  Files are skipped, so a glob over a directory of checkouts works

Options:
  --rows N        Draw each sprite N rows tall instead of the theme's height
  --state STATE   Draw that pose instead of idle

Each cell draws the project's familiar over its name, member, slot, and whether a
project colour, a pin or the project's hash chose the slot. Columns fill the terminal
width; a pipe gets one, and a terminal without kitty graphics gets the captions alone.

Examples:
  familiar projects
  familiar projects ~/src/*
  familiar projects --rows 3 ~/src/*
  familiar projects --state working
`,
  theme: `Browse and inspect themes.

Usage:
  familiar theme <command>

Commands:
  list                   List installed themes
  add SOURCE             Install a theme
  validate DIR           Prove a theme directory conforms
  show [ID]              Show a theme's twelve members
  preview MEMBER         Preview one member and its states
  sheet                  Show every member across every state

Examples:
  familiar theme list
  familiar theme show cats
`,
  'theme add': `Install a theme from an HTTPS URL or local directory.

Usage
  familiar theme add SOURCE

Arguments
  SOURCE          An https:// git URL, or a local theme directory

Only the pack (theme.yaml, licence files, member sprites) is staged,
validated and promoted atomically; an install receipt records the source. Private repos: clone with git, then
add the clone's directory.

Examples
  familiar theme add ./familiar-cats
  familiar theme add ./my-theme`,
  'theme validate': `Prove a theme directory conforms.

Usage:
  familiar theme validate DIR

Arguments:
  DIR             Theme directory

Examples:
  familiar theme validate themes/cats
`,
  'theme list': `List shipped and user-installed themes.

Usage:
  familiar theme list

Examples:
  familiar theme list
  NO_COLOR=1 familiar theme list
`,
  'theme show': `Show a theme's twelve members.

Usage:
  familiar theme show [ID] [--rows N]

Arguments:
  ID              Theme id; defaults to the active theme

Options:
  --rows N        Terminal row height

Examples:
  familiar theme show
  familiar theme show cats --rows 2
`,
  'theme preview': `Preview one member and its states.

Usage:
  familiar theme preview MEMBER [--theme ID] [--state STATE]

Arguments:
  MEMBER          Theme member id

Options:
  --theme ID      Theme id; defaults to the active theme
  --state STATE   Show one state

Examples:
  familiar theme preview ginger
  familiar theme preview ginger --state working
`,
  'theme sheet': `Show every member across every state.

Usage:
  familiar theme sheet [--theme ID] [--member ID] [--rows N] [--out FILE]

Options:
  --theme ID      Theme id; defaults to the active theme
  --member ID     Show one member
  --rows N        Terminal row height
  --out FILE      Write a PNG instead of terminal art

Examples:
  familiar theme sheet --rows 2
  familiar theme sheet --member ginger --out ginger.png
`,
  scheme: `Set Familiar's terminal colour scheme.

Usage:
  familiar scheme set dark|light [--sat N]

Commands:
  set dark|light          Set mode and saturation

Examples:
  familiar scheme set dark
  familiar scheme set light --sat 0.8
`,
  'scheme set': `Set Familiar's terminal colour scheme.

Usage:
  familiar scheme set dark|light [--sat N]

Arguments:
  dark|light      Terminal colour mode

Options:
  --sat N         Positive saturation scale

Examples:
  familiar scheme set dark
  familiar scheme set light --sat 0.8
`,
  install: `Install Familiar integrations.

Usage:
  familiar install <command>

Commands:
  pets            Install the active theme as Codex pets
  opencode        Install the OpenCode integration

Examples:
  familiar install pets
  familiar install opencode
`,
  'install pets': `Compile the active theme into Codex native pets.

Usage:
  familiar install pets [--out DIR] [--sync-projects]

Options:
  --out DIR          Write pets to DIR
  --sync-projects    Select a pet in this project and each identities.yaml path entry

Motion policies:
  full             Duration-sample canonical animation clips where available
  reduced          Install static state roots in every occupied cell
  off              refuses installation and writes no pet files

Without --sync-projects, this command does not change the user-owned [tui] pet setting;
it installs the pet files and prints how to select one.

--sync-projects writes <project>/.codex/config.toml for the current repository and for
each identities.yaml path entry, and adds that file to the repository's local exclusions.
It never rewrites a tracked config, an unmanaged one, or the user-wide config.

Examples:
  familiar install pets
  familiar install pets --sync-projects
  familiar install pets --out ./pets
`,
  setup: `Print agent integration settings.

Usage:
  familiar setup <agent>

Commands:
  claude-code     Print Claude Code integration settings
  relay           Print familiar's relay observer entries

Examples:
  familiar setup claude-code
  familiar setup relay
`,
  'setup claude-code': `Print Claude Code integration settings.

Usage:
  familiar setup claude-code

Prints JSON for you to merge into Claude Code settings; it never reads or writes those settings.

Examples:
  familiar setup claude-code
`,
  'setup relay': `Print familiar's relay observer entries.

Usage:
  familiar setup relay

Prints JSON for you to merge into relay's subscribers.json; it writes nothing.

Examples:
  familiar setup relay
`,
  observe: `Project relay's registry into presentation state.

Usage:
  familiar observe

Reads one relay observer envelope on stdin. Faults exit 1; success or staleness exits 0.
`,
  statusline: `Render the Claude Code status line.

Usage:
  familiar statusline [--with CMD]

Options:
  --with CMD      Wrap another status-line command

Examples:
  familiar statusline
  familiar statusline --with "printf ready"
`,
  niri: `Niri desktop actions.

Usage:
  familiar niri <command>

Commands:
  focus ID        Focus a Niri workspace by its stable ID

Run \`familiar niri <command> --help\` for details.
`,
  'niri focus': `Focus a Niri workspace by its stable ID.

Usage:
  familiar niri focus ID

Arguments:
  ID              The workspace's stable Niri ID (a decimal integer), not its index

Speaks to the compositor at NIRI_SOCKET. An already focused workspace is left as it is.
Prints nothing on success; Niri's acknowledgement does not confirm the focus moved.

Examples:
  familiar niri focus 21
`,
  attention: `Desktop attention: which agents need you, shared by the popup, the bar and toasts.

Usage:
  familiar attention <command>

Commands:
  status          Print the desktop attention view
  dismiss ID...   Dismiss attention episodes and diagnostics by ID
  popup           Serve one familiar popup control request

Run \`familiar attention <command> --help\` for details.
`,
  'attention status': `Print the desktop attention view.

Usage:
  familiar attention status

Prints one JSON document in any output mode: the saved attention state plus the
coordinator's health, read live. It changes nothing.

Examples:
  familiar attention status
`,
  'attention dismiss': `Dismiss attention episodes and diagnostics by ID.

Usage:
  familiar attention dismiss ID...

Arguments:
  ID              An episode or diagnostic ID from \`attention status\`

Hides those alerts and cancels their queued popups and toasts. It never answers a
request, grants an approval or stops an agent. Prints {"dismissedIds", "missingIds"}.

Examples:
  familiar attention dismiss e12 e14
`,
  'attention popup': `Serve one familiar popup control request.

Usage:
  familiar attention popup

Reads one JSON request (at most 65536 bytes) on stdin and writes one JSON reply:
  {"op":"initialise","consumerId":ID,"ids":[...]}   history at attachment
  {"op":"claim","consumerId":ID}                    reserve the next moment to play
  {"op":"finish","consumerId":ID,"token":T,"outcome":O}
O is delivered, failed, suppressed or interrupted. A bad request exits 1.
`,
  reap: `Prune relay's registry and reconcile presentation.

Usage:
  familiar reap

Examples:
  familiar reap
  familiar reap && familiar statusline
`,
};

const HELP_ACCENT = '#5f87af';
const HELP_HEADINGS = new Set([
  'Usage:', 'Explore', 'Set up', 'Runtime', 'Desktop', 'Commands:', 'Arguments:', 'Options:', 'Examples:',
]);

export function renderHelp(key, { color = false } = {}) {
  const text = HELP[key];
  if (text === undefined) throw new Error(`no help for resolved command ${JSON.stringify(key)}`);
  if (!color) return text;
  return text.split('\n').map((line) => HELP_HEADINGS.has(line)
    ? `${BOLD}${fg(HELP_ACCENT)}${line}${RESET}` : line).join('\n');
}

// Bound stdin reads when the sender does not close its pipe.
const STDIN_EOF_TIMEOUT_MS = 5_000;

// A PINNABLE CLOCK, for the decay tests only. Nothing in production sets this; without it
// testing the 8s done and 30s error expiries would require real sleeps.
const now = () => (process.env.FAMILIAR_NOW_MS ? Number(process.env.FAMILIAR_NOW_MS) : Date.now());

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => { clearTimeout(timer); resolve(data); };
    const timer = setTimeout(done, STDIN_EOF_TIMEOUT_MS);
    timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

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

// The `theme sheet` caption row. Exported and pure because it now makes a
// choice: a member holds several slots but the swatch takes one colour.
export function sheetRowCaptions(rows, tone) {
  const slotText = rows.map((row) => row.member.slots.join(','));
  // Width once, from the widest list. `padStart(2)` was right when every member
  // held exactly one slot; a member holding 1,2,3 would shove every other row's
  // label three columns right.
  const width = Math.max(...slotText.map((text) => text.length));
  return rows.map((row, index) => {
    // slots[0] is the member's primary identity — the same first-declared-wins
    // rule as bySlot, read from the member's end instead of the slot's.
    const swatch = cliSwatch(identityColors({ slot: row.member.slots[0], projectColor: null }, tone).base);
    return `  ${slotText[index].padStart(width)}  ${swatch}  `
      + `${row.member.label.padEnd(20)}${row.id}\n`;
  });
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
        projectKey, project, remote, repoRoot, repositoryRoot, projectColor, catalog, pack,
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

async function main({ command, args: rest, color, mode }) {
  // Every leaf's options and positional bounds come from the same declared row
  // completion and the conformance test read -- one source, not a hand-kept mirror.
  const cmd = commandAt(command.split(' '));
  const leafOptions = { options: parseArgsOptions(cmd), ...positionalBounds(cmd), help: command };
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
  } else if (command === 'observe') {
    parseLeaf(rest, leafOptions);
    const result = await observe({ text: await readStdin(), deps: {
      paths: resolvePaths(), relay: { readSnapshot }, relayProcess: createRelayProcessOps(),
      renderProcess: defaultProcessOps, adapterFor,
    } });
    for (const line of result.lines) process.stderr.write(`${line}\n`);
    process.exitCode = result.exitCode;
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
      const { identities, spriteFor, animationFor, faults } = await makePrepareSprites(ctx)(one);
      if (faults.has(sessionId)) {
        visualFault = `session ${sessionId}: ${faults.get(sessionId)}`;
      } else {
        // Keep the decay contract: polling must not show done/error forever.
        const intentRecord = resolveAll({
          agents: one,
          identities,
          tone: ctx.tone,
          spriteFor,
          animationFor,
          motionPolicy: ctx.motionPolicy,
        })[sessionId];
        intent = displayedIntent(intentRecord, now());
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
    const projectSync = values['sync-projects']
      ? await planCodexProjectSync({ catalog: ctx.catalog, pack: ctx.pack, cwd: process.cwd() })
      : null;
    if (projectSync) reportTasksWarnings(projectSync.warnings);

    let written = 0;
    for (const [memberId, member] of ctx.pack.members) {
      // The SAME resolver every other surface uses — not a second path to the same PNGs. The
      // sprites codex renders are byte-for-byte the ones the terminal and the bar render.
      const assets = assetsFor(ctx.pack, memberId, ctx.tone.mode);
      const poses = Object.fromEntries(
        STATES.map((state) => [state, decodeRgba(readFileSync(assets[state].terminal))]),
      );
      const { set: animationSet } = await loadAnimationMember(ctx.pack, memberId);

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
        themeId: ctx.themeId,
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
    // Validated against the declared enum, not a hand-kept list: cmd is
    // commandAt(['scheme', 'set']), the same row completion offers dark/light from.
    const [{ name: schemeArgName, values: schemeValues }] = cmd.args;
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
        member: { id: memberId, label: member.label, persona: member.persona, slots: member.slots },
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
    process.stdout.write(`\n  ${member.label} · ${themeId} · slot${member.slots.length === 1 ? '' : 's'} ${member.slots.join(', ')}\n  ${member.persona}\n\n`);
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
    const covered = pack.bySlot.size;
    if (mode === 'json') {
      process.stdout.write(`${JSON.stringify({
        id: pack.id, label: pack.label, members: pack.members.size,
        slotsCovered: covered, slotCount: SLOT_COUNT, specVersion: pack.specVersion,
      })}\n`);
      return;
    }
    process.stdout.write(
      `${pack.id} — ${pack.label}\n` +
      `  ${pack.members.size} member${pack.members.size === 1 ? '' : 's'}, ` +
      `${covered}/${SLOT_COUNT} slots covered\n` +
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
      const slots = [];
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        let member = null, fault = null;
        try {
          member = memberOrThrow(pack, defaultMemberForSlot(pack, slot));
        } catch (error) {
          fault = error.message;
        }
        slots.push({ slot, member: member ? { id: member.id, label: member.label } : null, fault });
      }
      process.stdout.write(`${JSON.stringify({
        id: row.id, label: pack.label, source: row.source, shadowed: row.shadowed ?? false, slots,
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
    // the twelve slots WITH their art. Without graphics (a plain TERM, or a
    // tmux pane the probe refuses — and for tmux it says which setting) it silently
    // degrades to a bare slot listing. `preview` stays quiet about this on
    // purpose (test/bin-familiar.test.js pins that); `theme` does not, because
    // a human judging whether twelve familiars cohere as a set needs to know
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

    // SLOT ORDER, not member order. The slot is the stable identity a project
    // hashes to; a theme is that identity's inhabitants. Walking the slots is
    // also what surfaces a gap as a gap rather than a shorter list.
    const useColor = cliColor({ color });
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      // A REAL SWATCH, not the text "hue 22/62". identityColors({ slot, projectColor: null }, tone) is
      // the same ramp every other surface paints this slot with, so the strip
      // shows the colour the bar and the border actually use rather than a
      // second opinion computed here. sgr.js exports fg(hex) and no background
      // setter, hence a block glyph rather than a filled cell.
      const swatch = cliSwatch(identityColors({ slot, projectColor: null }, ctxTone).base, { color: useColor });

      // defaultMemberForSlot THROWS on an empty slot, and a half-built theme is
      // precisely when this view earns its keep — so the gap is caught, labelled,
      // and the grid keeps going. A theme must fill all twelve; showing WHICH one
      // is missing beats refusing to draw any of them.
      //
      // assetsFor + readFileSync + transmit live in THIS SAME try, not after it.
      // The build workflow writes all twelve member blocks up front and fills
      // sprites one member at a time, so every intermediate state of a theme
      // under construction has twelve members and fewer than twelve sprite
      // sets — assetsFor throwing on a faulted asset-root or a missing
      // <state>.png is the ORDINARY case this view exists to survive, not an
      // edge case. One bad slot labels itself; the other eleven still draw.
      let member = null;
      let fault = null;
      let rendered = null;
      try {
        member = memberOrThrow(pack, defaultMemberForSlot(pack, slot));
        if (graphical) {
          const assets = assetsFor(pack, member.id, schemeMode);
          // A STRIP, NOT A GRID, and that is a property of transmit(): it sends
          // C=1 (the image does not move the cursor) and then advances by hand
          // with exactly `rows` newlines, so consecutive images always stack
          // vertically. Twelve side by side would need a placement-capable
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
        `  ${String(slot).padStart(2)}  ${swatch}  ` +
        `${(member?.label ?? '(no member)').padEnd(20)}${fault ?? member?.id}\n`
      );
    }
    process.stdout.write('\n');
  } else if (command === 'theme sheet') {
    const { values } = parseLeaf(rest, leafOptions);
    // THE WHOLE THEME AT A GLANCE: one row per member, six poses across it, at whatever
    // height fits your screen. `theme` shows twelve members in ONE state and `preview`
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
      ? [...Array(SLOT_COUNT).keys()].map((slot) => defaultMemberForSlot(pack, slot))
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
    const captions = sheetRowCaptions(boxed, ctxTone);
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

// Status-line failures are cosmetic; observer faults must reach relay.
const COSMETIC_COMMANDS = new Set(['statusline']);
export function reportCommandError(error, resolved, {
  write = (line) => process.stderr.write(line),
  mode = 'pretty',
} = {}) {
  const cosmetic = COSMETIC_COMMANDS.has(resolved?.command);
  if (resolved?.command === 'reap' && error.help === undefined) {
    write(`familiar: reap: ${error.code ? `${error.code}: ` : ''}${error.message.replace(/[\r\n]+/g, ' ')}\n`);
    return 1;
  }
  if (!cosmetic && error.help === undefined && mode === 'json') {
    write(`${JSON.stringify({ error: { kind: 'familiar', detail: error.message } })}\n`);
    return 1;
  }
  reportCosmeticError(error, { write });
  if (error.help !== undefined) {
    const target = error.help === 'root' ? 'familiar --help' : `familiar ${error.help} --help`;
    write(`Run '${target}' for help.\n`);
  }
  return cosmetic ? 0 : (error.help !== undefined ? 2 : 1);
}

function printCompletion(argv) {
  const shell = process.env.FAMILIAR_COMPLETE;
  if (argv[0] !== '--') {
    process.stdout.write(completionScript(shell));
    return;
  }
  const words = argv.slice(1);
  const index = Number(process.env.FAMILIAR_COMPLETE_INDEX);
  for (const [value, description] of candidates(words, index)) {
    process.stdout.write(`${value}\t${description ?? ''}\n`);
  }
}

// Called by the bin/familiar launcher. It is an export rather than an
// invoked-as-main guard because the launcher imports this file, so argv[1] names
// the launcher and never this path.
export async function run(argv = process.argv.slice(2)) {
  // Completion never touches config or the bus, and it is checked before globals are
  // stripped: the words it is asked to complete are the raw shell words, `--` and all.
  if (process.env.FAMILIAR_COMPLETE) return printCompletion(argv);

  let resolved = null;
  let mode = 'pretty';
  try {
    const stripped = stripGlobals(argv, process.env, usageError);
    mode = stripped.mode;
    const color = stripped.color;
    let rest = stripped.argv;

    // -V/--version is a root concept only: it is checked before resolving a
    // command, so `-V` after a family name reaches resolveCommand and fails as
    // an ordinary unknown option instead of printing the version.
    if (rest[0] === '-V' || rest[0] === '--version') {
      const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
      process.stdout.write(`familiar ${pkg.version}\n`);
      return;
    }

    // `help <words…>` routes to the same help resolveCommand gives `<words…> --help`;
    // with no words, `familiar help` is `familiar --help`.
    if (rest[0] === 'help') rest = [...rest.slice(1), '--help'];

    resolved = resolveCommand(rest);
    if (resolved.help) process.stdout.write(renderHelp(resolved.help, { color: cliColor({ color }) }));
    else await main({ ...resolved, color, mode });
  } catch (error) {
    process.exitCode = reportCommandError(error, resolved, { mode });
  }
}

export function reportCosmeticError(error, { write = (line) => process.stderr.write(line) } = {}) {
  write(`familiar: ${error.message}\n`);
}
