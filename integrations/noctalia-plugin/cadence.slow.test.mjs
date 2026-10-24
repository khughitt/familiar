// The widget's sustained cost over a night: an unseen request pulses at 200 ms until it
// is seen, so eight hours stay at or under five scheduled updates a second. Slow: it
// runs every one of those updates through the production widget under the pinned Luau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, nativeEvent, traceAttention } from '../../test/helpers/attention.js';
import { runLuau } from '../../test/helpers/luau.mjs';
import { reduceTopology } from '../niri/topology.js';

const HOME = '/home/tester';
const STATE = `${HOME}/.local/state/familiar`;
const BOOT = '11111111-1111-4111-8111-111111111111';
const SOCKET = '/run/user/1000/niri.wayland-1.sock';
const T0 = 1_000_000;
const bytesOf = (value) => `${JSON.stringify(value, null, 2)}\n`;

test('an unseen request overnight costs at most five widget updates a second', () => {
  const t = traceAttention({ start: T0 - 100_000 });
  const r = createRegistry({ now: () => t.now });
  t.observe([]);
  const event = nativeEvent('codex', 'PermissionRequest', { session: 'a' });
  r.apply(event);
  t.observe(r.rows(), event);
  t.desktop({ focused: '10', origins: { 'codex:a': '21' } });
  const topology = reduceTopology(null, { WorkspacesChanged: { workspaces: [
    { id: 20, idx: 1, name: null, output: 'HDMI-A-1', is_urgent: false, is_active: true, is_focused: false, active_window_id: 1 },
    { id: 21, idx: 2, name: null, output: 'HDMI-A-1', is_urgent: false, is_active: false, is_focused: false, active_window_id: 1 },
    { id: 10, idx: 1, name: null, output: 'DP-1', is_urgent: false, is_active: true, is_focused: true, active_window_id: 1 },
  ] } }, { now: T0, instanceId: 'coordinator-1', epoch: { bootId: BOOT, desktopSession: SOCKET } });
  const health = { schema: 1, instanceId: 'coordinator-1', epoch: { bootId: BOOT, desktopSession: SOCKET }, owner: { pid: 77, start: '1' }, writtenAt: T0 };
  const files = {
    '/proc/sys/kernel/random/boot_id': `${BOOT}\n`,
    [`${STATE}/attention.json`]: bytesOf(t.state),
    [`${STATE}/niri-workspaces.json`]: bytesOf(topology),
    [`${STATE}/attention-health.json`]: bytesOf(health),
  };
  const decoded = { [bytesOf(t.state)]: t.state, [bytesOf(topology)]: topology, [bytesOf(health)]: health };
  const [night] = runLuau(`
    for path, bytes in fixture("files") do Host.files[path] = bytes end
    for bytes, value in fixture("decoded") do Host.decoded[bytes] = value end
    Host.env.HOME = "${HOME}"
    Host.env.NIRI_SOCKET = "${SOCKET}"
    local service = Host.service()
    local b = Host.widget("HDMI-A-1")
    Host.advance(1000)
    service.alive = false
    Host.compareRenders = false
    local start = b.updates
    Host.advance(8 * 3600000)
    emit({ updates = b.updates - start, interval = b.interval })
  `, { fixtures: { files, decoded }, timeoutMs: 300_000 }).emitted;
  assert.equal(night.interval, 200);
  assert.ok(night.updates <= 144_000, `${night.updates} updates overnight`);
  assert.ok(night.updates >= 143_000, 'the unseen request keeps its slow pulse until seen');
});
