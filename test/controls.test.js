import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../src/controls.js';
import { createPlayer } from '../src/player.js';
import { createOcClient } from '../src/oc-client.js';

function setup({ commands = [], doneFail = false, controlFail = null } = {}) {
  const s = { done: [], ran: [], events: [], warns: 0, commands };
  const client = {
    async commands() { if (s.down) throw new Error('down'); return s.commands; },
    async commandDone(id) { if (doneFail) throw new Error('x'); s.done.push(id); },
  };
  const player = { async control(a) { if (controlFail) throw controlFail; s.ran.push(a); } };
  s.c = createController({ client, player, notify: e => s.events.push(e), log: { warn: () => s.warns++ } });
  return s;
}

test('commands are acknowledged before they run, in order', async () => {
  const s = setup({ commands: [{ id: 1, action: 'pause' }, { id: 2, action: 'skip' }] });
  await s.c.tick();
  assert.deepEqual(s.done, [1, 2]);
  assert.deepEqual(s.ran, ['pause', 'skip']);
});

test('a command that could not be acknowledged is not executed', async () => {
  const s = setup({ commands: [{ id: 1, action: 'skip' }], doneFail: true });
  await s.c.tick();
  assert.deepEqual(s.ran, []);
});

test('a failing player action is reported and does not stop the next command', async () => {
  const s = setup({ commands: [{ id: 1, action: 'skip' }], controlFail: new Error('no next') });
  await s.c.tick();
  assert.equal(s.events[0].type, 'command-failed');
  assert.match(s.events[0].error, /no next/);
});

test('OC outage is warned about once and recovers', async () => {
  const s = setup({ commands: [{ id: 1, action: 'play' }] });
  s.down = true;
  await s.c.tick(); await s.c.tick();
  assert.equal(s.warns, 1);
  s.down = false;
  await s.c.tick();
  assert.deepEqual(s.ran, ['play']);
});

test('stop and overlapping ticks', async () => {
  const s = setup({ commands: [{ id: 1, action: 'play' }] });
  await Promise.all([s.c.tick(), s.c.tick()]);
  assert.deepEqual(s.ran.length >= 1, true);
  s.c.stop();
  const n = s.ran.length;
  await s.c.tick();
  assert.equal(s.ran.length, n);
});

test('player.control maps actions to PulseSync methods', async () => {
  const calls = [];
  const m = n => () => { calls.push(n); };
  const p = createPlayer({ getQueueSnapshot() {}, addTrackToQueueById() {}, play: m('play'), pause: m('pause'), togglePlayPause: m('toggle'), next: m('next') });
  for (const a of ['play', 'pause', 'toggle', 'skip', 'skip_ban']) await p.control(a);
  assert.deepEqual(calls, ['play', 'pause', 'toggle', 'next', 'next']);
  await assert.rejects(p.control('format'), /Неизвестная/);
  const bare = createPlayer({ getQueueSnapshot() {}, addTrackToQueueById() {} });
  await assert.rejects(bare.control('pause'), /не поддерживает/);
});

test('client.commands validates and sorts; played/playing/commandDone hit the right routes', async () => {
  const calls = [];
  const res = body => ({ ok: true, status: 200, json: async () => body });
  const fetch = async (url, init) => {
    calls.push([init.method, url.replace('http://127.0.0.1:8000/plugins/music/api', ''), init.body && JSON.parse(init.body)]);
    if (url.endsWith('/commands')) return res({ commands: [{ id: 9, action: 'skip' }, { id: 3, action: 'pause' }, { id: 5, action: 'rm -rf' }, { id: 'x', action: 'play' }, null, { id: 0, action: 'play' }] });
    if (url.endsWith('/playing')) return res({ items: [{ id: 4, trackId: '40' }, { id: 5, trackId: 'bad' }] });
    return res({ ok: true });
  };
  const c = createOcClient({ fetch });
  assert.deepEqual(await c.commands(), [{ id: 3, action: 'pause' }, { id: 9, action: 'skip' }]);
  const pl = await c.playing();
  assert.equal(pl[0].trackId, '40');
  assert.ok(pl[1].invalid);
  await c.played(4); await c.commandDone(3);
  assert.deepEqual(calls.slice(2), [['POST', '/played', { id: 4 }], ['POST', '/commands/done', { id: 3 }]]);
  const bad = createOcClient({ fetch: async () => res({}) });
  await assert.rejects(bad.commands(), /неожиданный/);
  await assert.rejects(bad.playing(), /неожиданный/);
});
