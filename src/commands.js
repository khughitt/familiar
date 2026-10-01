// The declared surface, one entry per command; bin/familiar.js derives FAMILIES and
// ROOT_LEAVES from it, parseLeaf reads each command's options here, and completion
// walks it.
export const COMMANDS = [
  { path: ['whoami'], summary: "Show this project's familiar identity", args: [{ name: 'path', value: 'path', required: false }] },
  { path: ['projects'], summary: "Show every project's familiar, pinned or hashed", args: [{ name: 'dir', value: 'path', required: false, variadic: true }],
    options: [{ names: ['--rows'], value: 'int' }, { names: ['--state'], value: 'string' }] },
  { path: ['theme'], summary: 'Themes: list, add, validate, show, preview, sheet' },
  { path: ['theme', 'list'], summary: 'List installed themes' },
  { path: ['theme', 'add'], summary: 'Install a theme from an HTTPS URL or local directory', args: [{ name: 'source', value: 'string', required: true }] },
  { path: ['theme', 'validate'], summary: 'Prove a theme directory conforms', args: [{ name: 'dir', value: 'path', required: true }] },
  { path: ['theme', 'show'], summary: "Show a theme's twelve members", args: [{ name: 'id', value: 'string', required: false }], options: [{ names: ['--rows'], value: 'int' }] },
  { path: ['theme', 'preview'], summary: 'Preview one member and its states', args: [{ name: 'member', value: 'string', required: true }],
    options: [{ names: ['--theme'], value: 'string' }, { names: ['--state'], value: 'string' }] },
  { path: ['theme', 'sheet'], summary: 'Show every member across every state',
    options: [{ names: ['--rows'], value: 'int' }, { names: ['--theme'], value: 'string' }, { names: ['--member'], value: 'string' }, { names: ['--out'], value: 'path' }] },
  { path: ['scheme'], summary: 'The terminal colour scheme' },
  { path: ['scheme', 'set'], summary: 'Set the terminal colour scheme', args: [{ name: 'scheme', value: 'enum', values: ['dark', 'light'], required: true }], options: [{ names: ['--sat'], value: 'string' }] },
  { path: ['install'], summary: 'Install the active theme into a harness' },
  { path: ['install', 'pets'], summary: 'Install the active theme as Codex pets', options: [{ names: ['--out'], value: 'path' }, { names: ['--sync-projects'], value: 'none' }] },
  { path: ['install', 'opencode'], summary: 'Install the OpenCode integration', options: [{ names: ['--project-dir'], value: 'path' }, { names: ['--config-dir'], value: 'path' }] },
  { path: ['setup'], summary: "Print a harness's integration settings" },
  { path: ['setup', 'claude-code'], summary: 'Print Claude Code integration settings', protocol: 'harness settings document: stdout is the JSON settings file in any mode' },
  { path: ['setup', 'codex'], summary: 'Print Codex integration settings', protocol: 'harness settings document: stdout is the JSON settings file in any mode' },
  { path: ['hook'], summary: 'Record an agent lifecycle event', protocol: 'harness hook: reads the harness payload on stdin',
    args: [{ name: 'event', value: 'string', required: true }], options: [{ names: ['--agent'], value: 'string' }, { names: ['--trace'], value: 'path' }] },
  { path: ['statusline'], summary: 'Render the Claude Code status line', protocol: 'Claude Code status line: stdout is the rendered line', options: [{ names: ['--with'], value: 'string' }] },
  { path: ['reap'], summary: 'Remove sessions whose agent has exited' },
];

export const FAMILIES = new Map(COMMANDS.filter((c) => c.path.length === 1 && COMMANDS.some((d) => d.path.length === 2 && d.path[0] === c.path[0]))
  .map((c) => [c.path[0], new Set(COMMANDS.filter((d) => d.path.length === 2 && d.path[0] === c.path[0]).map((d) => d.path[1]))]));
export const ROOT_LEAVES = new Set(COMMANDS.filter((c) => c.path.length === 1 && !FAMILIES.has(c.path[0])).map((c) => c.path[0]));
export const COLORS = ['auto', 'always', 'never'];

export function commandAt(path) {
  return COMMANDS.find((c) => c.path.length === path.length && c.path.every((p, i) => p === path[i])) ?? null;
}

export function parseArgsOptions(cmd) {
  return Object.fromEntries((cmd.options ?? []).map((o) => [o.names[0].slice(2), { type: o.value === 'none' ? 'boolean' : 'string', multiple: o.repeatable ?? false }]));
}

/** Strip --json/--pretty/--color from anywhere; returns { argv, mode, color } or throws a usage error. */
export function stripGlobals(argv, env, usageError) {
  let mode = null, color = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--pretty') { const m = a.slice(2); if (mode && mode !== m) throw usageError('--json and --pretty are mutually exclusive', 'root'); mode = m; }
    else if (a === '--color') { color = argv[++i]; if (!COLORS.includes(color)) throw usageError(`--color must be one of ${COLORS.join(', ')}, got ${JSON.stringify(color ?? '')}`, 'root'); }
    else rest.push(a);
  }
  mode ??= env.FAMILIAR_FORMAT ?? 'pretty';
  if (!['json', 'pretty'].includes(mode)) throw usageError(`FAMILIAR_FORMAT must be json or pretty, got ${JSON.stringify(mode)}`, 'root');
  color ??= env.FAMILIAR_COLOR ?? 'never';
  if (!COLORS.includes(color)) throw usageError(`FAMILIAR_COLOR must be one of ${COLORS.join(', ')}`, 'root');
  return { argv: rest, mode, color };
}

const GLOBAL_FLAGS = new Set(['--json', '--pretty', '-h', '--help', '-V', '--version']);
export function candidates(words, index) {
  const before = [], word = words[index] ?? '';
  for (let i = 1; i < index; i++) { if (GLOBAL_FLAGS.has(words[i])) continue; if (words[i] === '--color') { i++; continue; } before.push(words[i]); }
  let cmd = null;
  for (let n = Math.min(2, before.length); n > 0; n--) { cmd = commandAt(before.slice(0, n)); if (cmd) break; }
  const depth = cmd ? cmd.path.length : 0;
  const matching = (pairs) => pairs.filter(([v]) => v.startsWith(word));
  if (word.startsWith('-')) return matching((cmd?.options ?? []).flatMap((o) => o.names.map((n) => [n, ''])));
  const children = COMMANDS.filter((c) => c.path.length === depth + 1 && (cmd ? cmd.path : []).every((p, i) => c.path[i] === p));
  if (children.length) return matching([...children.map((c) => [c.path.at(-1), c.summary]), ...(depth === 0 ? [['help', "Print a command's help"]] : [])]);
  const names = new Set((cmd?.options ?? []).flatMap((o) => o.names));
  const valued = new Set((cmd?.options ?? []).filter((o) => o.value !== 'none').flatMap((o) => o.names));
  let filled = 0;
  for (let i = 0; i < before.length; i++) {
    if (names.has(before[i])) { if (valued.has(before[i])) i++; continue; }
    filled++;
  }
  const positional = (cmd?.args ?? [])[filled - depth];
  return matching(positional?.values ? positional.values.map((v) => [v, '']) : []);
}

export function completionScript(shell) {
  if (shell === 'zsh') return `#compdef familiar\n_familiar() {\n  local -a c\n  c=("\${(@f)$(FAMILIAR_COMPLETE=zsh FAMILIAR_COMPLETE_INDEX=$((CURRENT-1)) familiar -- "\${words[@]}" 2>/dev/null)}")\n  c=("\${c[@]//$'\\t'/:}")\n  [[ -n $c ]] && _describe 'familiar' c\n}\ncompdef _familiar familiar\n`;
  return `_familiar() {\n  local IFS=$'\\n'\n  COMPREPLY=($(FAMILIAR_COMPLETE=bash FAMILIAR_COMPLETE_INDEX=$COMP_CWORD familiar -- "\${COMP_WORDS[@]}" 2>/dev/null | cut -f1))\n}\ncomplete -F _familiar familiar\n`;
}
