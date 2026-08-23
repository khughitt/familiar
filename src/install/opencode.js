import { join } from 'node:path';
import { parse, printParseErrorCode } from 'jsonc-parser';

// opencode config files are JSONC (comments, trailing commas), so we cannot merge with
// JSON.parse. jsonc-parser is fault-tolerant, so a returned value alone is not success —
// we pass an error accumulator and refuse the file if it recorded any problem.
//
// `jsoncText` is passed through VERBATIM — no `|| '{}'` blank fallback. A MISSING file is the
// caller's job (installOpencode maps read()===null to the literal '{}'); by the time text reaches
// here, an empty or whitespace-only string means a PRESENT-but-blank config, which is malformed and
// must be refused, not silently rewritten into a fresh {} (design §5). `allowEmptyContent: true` is
// deliberate: WITHOUT it, jsonc-parser records a `ValueExpected` error for blank/whitespace input,
// so a blank file would throw the generic "unparseable JSONC" below; WITH it, blank input parses to
// `undefined` with NO error, and the non-object-root guard rejects it with the specific, friendly
// "an empty/blank file" message. A genuinely truncated file (e.g. `{ "plugin": [`) still records a
// CloseBracket/CloseBrace error and is refused as unparseable — `allowEmptyContent` only affects the
// wholly-empty case, nothing else.
export function mergePlugin(jsoncText, absPath) {
  const errors = [];
  const config = parse(jsoncText, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length) {
    throw new Error(`unparseable JSONC: ${errors.map((e) => printParseErrorCode(e.error)).join(', ')}`);
  }
  // Parseable is not the same as valid. A root that is `undefined` (blank file), `null`, an array,
  // or a scalar is a malformed opencode config — `config ?? {}` would silently rewrite it into `{}`
  // (or spread an array's indices into an object), corrupting the user's file. Refuse all of them.
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    const kind = config === undefined ? 'an empty/blank file' : config === null ? 'null' : Array.isArray(config) ? 'array' : typeof config;
    throw new Error(`config root must be a JSON object, found ${kind}`);
  }
  const obj = config;
  if ('plugin' in obj && !Array.isArray(obj.plugin)) {
    throw new Error(`"plugin" must be an array or absent, found ${typeof obj.plugin}`);
  }
  const plugin = Array.isArray(obj.plugin) ? obj.plugin.slice() : [];
  if (!plugin.includes(absPath)) plugin.push(absPath);
  return `${JSON.stringify({ ...obj, plugin }, null, 2)}\n`;
}

function readText(path, read) {
  const text = read(path);
  if (text !== null && typeof text !== 'string') {
    throw new Error(`${path}: read() must return a string or null, found ${typeof text}`);
  }
  return text;
}

// OPENCODE READS `<name>.json` OR `<name>.jsonc`, AND THIS INSTALLER WRITES ONLY THE FIRST.
// Ignoring the second is not harmless: a machine whose real config is `opencode.jsonc` used to get
// a brand-new `opencode.json` created beside it, which is either ignored or shadows the file the
// user actually maintains -- silently, either way. It was found on a real Mac, and it is not a
// macOS bug.
//
// The `.jsonc` case is REFUSED rather than merged. mergePlugin normalizes its output through
// JSON.stringify, so merging would rewrite the file as plain JSON and delete the comments that are
// the entire reason someone chose that extension. Refusing with the exact entry to add is the same
// answer `install pets` already gives for a tracked `.codex/config.toml`: do not rewrite a config
// this tool cannot reproduce faithfully, print what to add.
//
// Both present is ambiguous, so it is also refused. Familiar does not get to guess which file
// opencode is reading.
function resolveTarget(configDir, base, pluginPath, read) {
  const jsonPath = join(configDir, `${base}.json`);
  const jsoncPath = join(configDir, `${base}.jsonc`);
  const jsonText = readText(jsonPath, read);
  const jsoncText = readText(jsoncPath, read);

  if (jsonText !== null && jsoncText !== null) {
    throw new Error(
      `${jsonPath} and ${jsoncPath} both exist; opencode reads one of them and familiar will not `
      + 'guess which. Keep one and re-run.'
    );
  }
  if (jsoncText !== null) {
    throw new Error(
      `${jsoncPath}: add ${JSON.stringify(pluginPath)} to its "plugin" array by hand. Merging it `
      + 'here would rewrite the file as plain JSON and drop its comments.'
    );
  }
  return { path: jsonPath, text: jsonText };
}

// All-or-nothing: resolve BOTH targets and merge BOTH files in memory (either can throw) BEFORE
// writing either, so a malformed or unmergeable config never leaves the pair half-updated.
export function installOpencode({ configDir, tuiPluginPath, serverPluginPath, read, writeAtomic }) {
  const tui = resolveTarget(configDir, 'tui', tuiPluginPath, read);
  const config = resolveTarget(configDir, 'opencode', serverPluginPath, read);

  // Attach the source path at the orchestration boundary. mergePlugin stays a pure text transform,
  // while every user-facing refusal identifies WHICH of the two configs is malformed and why.
  const mergeAt = ({ path, text }, pluginPath) => {
    try { return mergePlugin(text === null ? '{}' : text, pluginPath); }
    catch (err) { throw new Error(`${path}: ${err.message}`); }
  };
  const tuiText = mergeAt(tui, tuiPluginPath);
  const configText = mergeAt(config, serverPluginPath);

  writeAtomic(tui.path, tuiText);
  writeAtomic(config.path, configText);
  return { tuiPath: tui.path, configPath: config.path };
}
