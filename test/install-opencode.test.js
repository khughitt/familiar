import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePlugin, installOpencode, legacyServerPlugin } from '../src/install/opencode.js';

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

test('installOpencode: writes only tui.json on success', () => {
  const files = { '/cfg/tui.json': '{}', '/cfg/opencode.json': '{ "plugin": [] }' };
  const writes = {};
  installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  assert.deepEqual(JSON.parse(writes['/cfg/tui.json']).plugin, ['/abs/sprite.tsx']);
  assert.equal(writes['/cfg/opencode.json'], undefined);
});

test('installOpencode: a bad file aborts BOTH writes', () => {
  const files = { '/cfg/tui.json': '{}', '/cfg/opencode.json': '{ "plugin": "bad" }' };
  const writes = {};
  assert.throws(() => installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
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
    read: () => null,           // both absent — only null means "missing"
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  assert.deepEqual(JSON.parse(writes['/cfg/tui.json']).plugin, ['/abs/sprite.tsx']);
  assert.equal(writes['/cfg/opencode.json'], undefined);
});

test('installOpencode: an empty server .jsonc is preserved without a manual handoff', () => {
  const files = { '/cfg/opencode.jsonc': '{\n  // mine\n  "plugin": []\n}' };
  const writes = {};
  const result = installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  // The original guard still holds: no opencode.json is created beside the .jsonc.
  assert.equal(writes['/cfg/opencode.json'], undefined);
  assert.deepEqual(result.manual, []);
  assert.deepEqual(result.written, ['/cfg/tui.json']);
  assert.equal(writes['/cfg/opencode.jsonc'], undefined);
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
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  assert.equal(writes['/cfg/tui.json'], undefined);   // familiar does not guess which one opencode reads
  assert.match(result.manual[0], /\/cfg\/tui\.json and \/cfg\/tui\.jsonc both exist/);
});

// REGRESSION, from the physical-Mac terminal gate. A `.jsonc` on ONE config used to abort the other,
// so a hand-maintained opencode.jsonc left tui.json unwritten and the sprite RENDERER unregistered.
// The two files are independent; a hand-off takes only its own file out of the run.
test('installOpencode: a TUI .jsonc hand-off does not rewrite an unchanged server config', () => {
  const files = { '/cfg/tui.jsonc': '{}', '/cfg/opencode.json': '{ "plugin": [] }' };
  const writes = {};
  const result = installOpencode({
    configDir: '/cfg',
    tuiPluginPath: '/abs/sprite.tsx',
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  });
  assert.equal(writes['/cfg/opencode.json'], undefined);
  assert.deepEqual(result.written, []);
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
    read: (p) => files[p] ?? null,
    writeAtomic: (p, text) => { writes[p] = text; },
  }), /\/cfg\/tui\.json/);
  assert.deepEqual(writes, {});   // opencode.json is mergeable, but nothing is written
});

test('legacyServerPlugin checks the checkout package and never guesses from its name', () => {
  const entry = '/pets-x/integrations/opencode/plugin.js';
  for (const name of ['familiar', 'relay', 'other']) {
    assert.equal(legacyServerPlugin(entry, { readFile: (path) => {
      assert.equal(path, '/pets-x/package.json');
      return JSON.stringify({ name });
    } }), name === 'familiar' ? 'familiar' : 'other');
  }
  for (const value of [null, 'broken JSON']) {
    assert.equal(legacyServerPlugin(entry, { readFile: () => value }), 'unknown');
  }
  assert.equal(legacyServerPlugin(entry, { readFile: () => { throw new Error('unreadable'); } }), 'unknown');
  for (const other of [null, 4, 'integrations/opencode/plugin.js', '/repo/other.js']) {
    assert.equal(legacyServerPlugin(other, { readFile: () => assert.fail('must not read unrelated entries') }), 'other');
  }
});

for (const owner of ['familiar', 'relay', 'unknown']) {
  test(`installOpencode: server JSONC only needs manual retirement for familiar or unknown entries (${owner})`, () => {
    const entry = '/pets-x/integrations/opencode/plugin.js';
    const original = `{ // preserve comments\n "plugin": [${JSON.stringify(entry)},],\n}\n`;
    const files = { '/cfg/opencode.jsonc': original,
      '/pets-x/package.json': owner === 'unknown' ? null : JSON.stringify({ name: owner }) };
    const writes = {};
    const result = installOpencode({ configDir: '/cfg', tuiPluginPath: '/abs/sprite.tsx',
      read: (path) => files[path] ?? null, writeAtomic: (path, text) => { writes[path] = text; },
    });
    assert.deepEqual(result.written, ['/cfg/tui.json']);
    assert.equal(writes['/cfg/opencode.jsonc'], undefined);
    assert.equal(writes['/cfg/opencode.json'], undefined);
    assert.deepEqual(result.messages, []);
    assert.equal(result.manual.length, owner === 'relay' ? 0 : 1);
    if (owner !== 'relay') assert.ok(result.manual[0].includes(entry));
  });
}

test('installOpencode: malformed server JSONC aborts before writing the TUI', () => {
  for (const text of ['{ "plugin": [', '{ "plugin": "bad" }', ' ', 'null']) {
    const writes = {};
    assert.throws(() => installOpencode({ configDir: '/cfg', tuiPluginPath: '/abs/sprite.tsx',
      read: (path) => path === '/cfg/opencode.jsonc' ? text : null,
      writeAtomic: (path, content) => { writes[path] = content; },
    }), /\/cfg\/opencode\.jsonc:/);
    assert.deepEqual(writes, {});
  }
});

test('installOpencode: server JSON and JSONC together remain ambiguous', () => {
  const writes = {};
  const result = installOpencode({ configDir: '/cfg', tuiPluginPath: '/abs/sprite.tsx',
    read: (path) => path.startsWith('/cfg/opencode.') ? '{}' : null,
    writeAtomic: (path, text) => { writes[path] = text; },
  });
  assert.deepEqual(result.written, ['/cfg/tui.json']);
  assert.match(result.manual[0], /opencode\.json and .*opencode\.jsonc both exist/);
});
