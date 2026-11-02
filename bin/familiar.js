// The CLI's front door: it parses the command line, prints help and completion, and
// routes. Each command's implementation loads only when that command runs. `observe` runs
// on every hook event, and a SessionEnd runs under relay's tightest teardown budget, so it
// is routed here to src/observe/run.js alone; every other command lives in
// familiar-commands.js, whose static graph (the theme contract, YAML, install and render
// modules) costs more than a teardown can spend on loading. `statusline` is polled for
// every open session, so its render cache is checked here and familiar-commands.js loads
// only on a miss. Keep this file's own imports to what parsing and routing need.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BOLD, fg, RESET } from '../src/render/term/sgr.js';
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

export function usageError(message, help) {
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

// Every leaf's options and positional bounds come from the same declared row
// completion and the conformance test read -- one source, not a hand-kept mirror.
export function leafOptionsFor(command) {
  const cmd = commandAt(command.split(' '));
  return { options: parseArgsOptions(cmd), ...positionalBounds(cmd), help: command };
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

Also reads agy's status-line input (product: antigravity).

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

export function readStdin() {
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

// Faults exit 1; success or staleness exits 0. Its stderr lines are relay's diagnostics.
async function observeCommand(args) {
  parseLeaf(args, leafOptionsFor('observe'));
  const [{ observe }, { paths }, relay, { defaultProcessOps }] = await Promise.all([
    import('../src/observe/run.js'),
    import('../src/bus/paths.js'),
    import('relay'),
    import('../src/bus/proc.js'),
  ]);
  const result = await observe({ text: await readStdin(), deps: {
    paths: paths(), relay: { readSnapshot: relay.readSnapshot }, relayProcess: relay.createProcessOps(),
    renderProcess: defaultProcessOps, adapterFor: relay.adapterFor,
  } });
  for (const line of result.lines) process.stderr.write(`${line}\n`);
  process.exitCode = result.exitCode;
}

// Claude Code polls this every refreshInterval for every open session, so its hit path loads
// only the HUD fields and the render cache (src/render/term/render-cache.js says what the key
// covers). The renderer, and with it the theme contract and YAML, loads on a miss. --with
// output belongs to an arbitrary command that nothing can key, so it is never cached.
async function statuslineCommand(args) {
  const { values } = parseLeaf(args, leafOptionsFor('statusline'));
  const stdin = await readStdin();
  const payload = JSON.parse(stdin || '{}');
  const wrapped = values.with ?? null;
  const [{ now }, { paths }, { readFields }, cache] = await Promise.all([
    import('../src/clock.js'),
    import('../src/bus/paths.js'),
    import('../src/render/term/statusfields.js'),
    import('../src/render/term/render-cache.js'),
  ]);
  const at = now();
  // Field collection makes a bounded git call and a claim lookup; --with replaces the HUD
  // rather than paying for fields it would not show.
  const fields = wrapped === null ? readFields(payload) : null;
  const p = paths();
  const sessionId = payload.session_id;
  const keyed = wrapped === null && typeof sessionId === 'string' && sessionId !== '';
  const key = keyed ? cache.renderKey({ paths: p, sessionId, fields }) : null;
  const cachePath = key === null ? null : cache.renderCachePath(p.stateDir, sessionId);
  if (key !== null) {
    const hit = cache.readRender(cachePath, key, at);
    if (hit !== null) {
      process.stdout.write(hit);
      return;
    }
  }

  const { renderStatusline } = await import('./familiar-commands.js');
  const { output, fault, expiresAt, settle } = await renderStatusline({ stdin, payload, wrapped, fields, at });
  process.stdout.write(output);
  if (fault !== null) process.stderr.write(`familiar: statusline: ${fault}\n`);
  if (settle !== null) await settle();
  // Only a clean line is cached: a fault is said again on the next poll. A line whose image is
  // still provisional was never keyed (renderKey), so its settle is retried every poll.
  if (key !== null && fault === null) {
    await cache.writeRender(cachePath, { key, output, renderedAt: at, until: cache.validUntil(at, expiresAt) });
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
    else if (resolved.command === 'observe') await observeCommand(resolved.args);
    else if (resolved.command === 'statusline') await statuslineCommand(resolved.args);
    else {
      const { main } = await import('./familiar-commands.js');
      await main({ ...resolved, color, mode });
    }
  } catch (error) {
    process.exitCode = reportCommandError(error, resolved, { mode });
  }
}

export function reportCosmeticError(error, { write = (line) => process.stderr.write(line) } = {}) {
  write(`familiar: ${error.message}\n`);
}
