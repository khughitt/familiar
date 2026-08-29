import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePlugin, installOpencode } from '../src/install/opencode.js';

test('mergePlugin: appends to an empty config', () => {
  const out = mergePlugin('{}', '/abs/plugin.tsx');
  assert.deepEqual(JSON.parse(out).plugin, ['/abs/plugin.tsx']);
});

test('mergePlugin: preserves and extends an existing array', () => {
  const out = mergePlugin('{ "plugin": ["/other.js"] }', '/abs/plugin.tsx');
  assert.deepEqual(JSON.parse(out).plugin, ['/other.js', '/abs/plugin.tsx']);
});

test('mergePlugin: idempotent — no duplicate entry', () => {
  const once = mergePlugin('{}', '/abs/plugin.tsx');
  const twice = mergePlugin(once, '/abs/plugin.tsx');
  assert.deepEqual(JSON.parse(twice).plugin, ['/abs/plugin.tsx']);
});

test('mergePlugin: tolerates JSONC comments and trailing commas', () => {
  const src = '{\n  // familiar\n  "plugin": ["/other.js"],\n}';
  const out = mergePlugin(src, '/abs/plugin.tsx');
  assert.deepEqual(JSON.parse(out).plugin, ['/other.js', '/abs/plugin.tsx']);
});

test('mergePlugin: non-array plugin is refused', () => {
  assert.throws(() => mergePlugin('{ "plugin": "one.js" }', '/abs/p.tsx'), /must be an array/);
});

test('mergePlugin: unparseable JSONC is refused', () => {
  assert.throws(() => mergePlugin('{ "plugin": [ ', '/abs/p.tsx'), /unparseable/);
});

test('mergePlugin: a null root is refused (not silently rewritten to {})', () => {
  assert.throws(() => mergePlugin('null', '/abs/p.tsx'), /root must be a JSON object/);
});

test('mergePlugin: an array root is refused', () => {
  assert.throws(() => mergePlugin('["/other.js"]', '/abs/p.tsx'), /root must be a JSON object/);
});

test('mergePlugin: a blank string is refused (a present-but-empty config is malformed, not "missing")', () => {
  assert.throws(() => mergePlugin('', '/abs/p.tsx'), /root must be a JSON object/);
});

test('mergePlugin: a whitespace-only string is refused', () => {
  assert.throws(() => mergePlugin('   \n\t', '/abs/p.tsx'), /root must be a JSON object/);
});

test('installOpencode: writes both files on success', () => {
  const files = { '/cfg/tui.json': '{}', '/cfg/opencode.json': '{ "plugin": [] }' };
  const writes = {};
  installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    serverPluginPath: '/abs/plugin.js',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  assert.deepEqual(JSON.parse(writes['/cfg/tui.json']).plugin, ['/abs/sprite.tsx']);
  assert.deepEqual(JSON.parse(writes['/cfg/opencode.json']).plugin, ['/abs/plugin.js']);
});

test('installOpencode: a bad file aborts BOTH writes', () => {
  const files = { '/cfg/tui.json': '{}', '/cfg/opencode.json': '{ "plugin": "bad" }' };
  const writes = {};
  assert.throws(() => installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    serverPluginPath: '/abs/plugin.js',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  }), /\/cfg\/opencode\.json:.*must be an array/);
  assert.deepEqual(writes, {}); // nothing written
});

test('installOpencode: a present-but-blank file aborts BOTH writes', () => {
  const files = { '/cfg/tui.json': '   \n', '/cfg/opencode.json': '{ "plugin": [] }' };
  const writes = {};
  assert.throws(() => installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    serverPluginPath: '/abs/plugin.js',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  }), /\/cfg\/tui\.json:.*root must be a JSON object/);
  assert.deepEqual(writes, {}); // a blank existing config is malformed -> nothing written
});

test('installOpencode: undefined is not missing and aborts BOTH writes', () => {
  const writes = {};
  assert.throws(() => installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    serverPluginPath: '/abs/plugin.js',
    read: () => undefined,
    writeAtomic: (p, text) => { writes[p] = text; },
  }), /\/cfg\/tui\.json:.*read\(\) must return a string or null, found undefined/);
  assert.deepEqual(writes, {});
});

test('installOpencode: missing files (read -> null) are created fresh', () => {
  const writes = {};
  installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    serverPluginPath: '/abs/plugin.js',
    read: () => null,           // both absent — only null means "missing"
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  assert.deepEqual(JSON.parse(writes['/cfg/tui.json']).plugin, ['/abs/sprite.tsx']);
  assert.deepEqual(JSON.parse(writes['/cfg/opencode.json']).plugin, ['/abs/plugin.js']);
});

test('installOpencode: an existing .jsonc config is refused, not shadowed by a new .json', () => {
  const files = { '/cfg/opencode.jsonc': '{\n  // mine\n  "plugin": []\n}' };
  const writes = {};
  const result = installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    serverPluginPath: '/abs/plugin.js',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  // The original guard still holds: no opencode.json is created beside the .jsonc.
  assert.equal(writes['/cfg/opencode.json'], undefined);
  assert.equal(result.manual.length, 1);
  assert.match(result.manual[0], /\/cfg\/opencode\.jsonc: add "\/abs\/plugin\.js" to its "plugin" array by hand/);
});

test('installOpencode: a .jsonc beside a .json is refused as ambiguous', () => {
  const files = {
    '/cfg/tui.json': '{}',
    '/cfg/tui.jsonc': '{}',
    '/cfg/opencode.json': '{ "plugin": [] }',
  };
  const writes = {};
  const result = installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    serverPluginPath: '/abs/plugin.js',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  assert.equal(writes['/cfg/tui.json'], undefined);   // familiar does not guess which one opencode reads
  assert.match(result.manual[0], /\/cfg\/tui\.json and \/cfg\/tui\.jsonc both exist/);
});

// REGRESSION, from the physical-Mac terminal gate. A `.jsonc` on ONE config used to abort the other,
// so a hand-maintained opencode.jsonc left tui.json unwritten and the sprite RENDERER unregistered.
// The two files are independent; a hand-off takes only its own file out of the run.
test('installOpencode: a .jsonc hand-off leaves the OTHER file written', () => {
  const files = { '/cfg/tui.jsonc': '{}', '/cfg/opencode.json': '{ "plugin": [] }' };
  const writes = {};
  const result = installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    serverPluginPath: '/abs/plugin.js',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  assert.deepEqual(JSON.parse(writes['/cfg/opencode.json']).plugin, ['/abs/plugin.js']);
  assert.deepEqual(result.written, ['/cfg/opencode.json']);
  assert.equal(writes['/cfg/tui.json'], undefined);
  assert.match(result.manual[0], /\/cfg\/tui\.jsonc/);
});

// The all-or-nothing rule that REMAINS: a config this tool cannot parse is not a hand-off, and it
// must not leave the pair half-updated.
test('installOpencode: a malformed config still aborts before anything is written', () => {
  const files = { '/cfg/tui.json': '{ this is not json' };
  const writes = {};
  assert.throws(() => installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    serverPluginPath: '/abs/plugin.js',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  }), /\/cfg\/tui\.json/);
  assert.deepEqual(writes, {});   // opencode.json is mergeable, but nothing is written
});
