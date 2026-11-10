import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../src/player.js';

test('requires both PulseSync methods', () => {
  assert.throws(() => createPlayer({}), /добавления/);
  assert.throws(() => createPlayer({ addTrackToQueueById() {} }), /чтения/);
});
test('inserts as next and surfaces async errors', async () => {
  const calls = [];
  const p = createPlayer({ getQueueSnapshot: () => ({ currentIndex: 2 }), addTrackToQueueById: async (...a) => { calls.push(a); } });
  await p.addNext('5', '6');
  assert.deepEqual(calls, [['5', { albumId: '6', position: 'next' }]]);
  assert.equal((await p.snapshot()).currentIndex, 2);
  const bad = createPlayer({ getQueueSnapshot() {}, addTrackToQueueById: async () => { throw new Error('x'); } });
  await assert.rejects(bad.addNext('1'), /x/);
});

test('canInsert needs a loaded current track (inserting into an idle player crashes the host UI)', async () => {
  const mk = (queue, state) => createPlayer({ getQueueSnapshot: () => queue, addTrackToQueueById() {}, ...(state === undefined ? {} : { getPlayerSnapshot: () => state }) });
  const q = { currentIndex: 0, items: [{ id: '1' }] };
  const playing = { status: 'playing', isPlaying: true, track: { id: '1' } };
  assert.equal(await mk(q, playing).canInsert(), true);
  assert.equal(await mk(q, { ...playing, status: 'paused', isPlaying: false }).canInsert(), true);
  assert.equal(await mk(q, { ...playing, status: 'buffering', isPlaying: false }).canInsert(), true);
  assert.equal(await mk(q).canInsert(), true, 'без API состояния плеера решает очередь');
  for (const bad of [null, undefined, {}, { currentIndex: null, items: [] }, { currentIndex: -1, items: [{ id: '1' }] }, { currentIndex: 0, items: [] }, { currentIndex: 3, items: [{ id: '1' }] }, { currentIndex: 0 }]) {
    assert.equal(await mk(bad, playing).canInsert(), false, JSON.stringify(bad));
  }
  for (const idle of [{ status: 'idle', isPlaying: false, track: null }, { status: 'stopped', isPlaying: false, track: { id: '1' } }, { status: 'ended', isPlaying: false, track: { id: '1' } }, null]) {
    assert.equal(await mk(q, idle).canInsert(), false, JSON.stringify(idle));
  }
  const broken = createPlayer({ getQueueSnapshot() { throw new Error('x'); }, addTrackToQueueById() {} });
  assert.equal(await broken.canInsert(), false);
});

// Методы api.client в аддоне возвращают промисы (RPC): адаптер обязан их дожидаться.
test('async client: snapshots are awaited, insertBlocker and diagnostics see real data', async () => {
  const { createPlayer } = await import('../src/player.js');
  const queue = { currentIndex: 0, items: [{ id: '1' }, { id: '2:9' }] };
  const state = { status: 'playing', isPlaying: true, track: { id: '1' }, progress: null, duration: null };
  const client = {
    addTrackToQueueById: async () => {},
    getQueueSnapshot: () => new Promise(r => setTimeout(() => r(queue), 1)),
    getPlayerSnapshot: () => new Promise(r => setTimeout(() => r(state), 1)),
  };
  const p = createPlayer(client);
  assert.deepEqual(await p.snapshot(), queue);
  assert.equal((await p.playerSnapshot()).track.id, '1');
  assert.equal(await p.insertBlocker(), null);
  assert.equal(await p.canInsert(), true);
  const d = await p.diagnostics();
  assert.equal(d.queue.length, 2);
  assert.equal(d.player.track.idType, 'string');
});

test('async client: empty snapshots block insertion with a reason', async () => {
  const { createPlayer } = await import('../src/player.js');
  const p = createPlayer({ addTrackToQueueById: async () => {}, getQueueSnapshot: async () => ({}), getPlayerSnapshot: async () => ({}) });
  assert.match(await p.insertBlocker(), /currentIndex/);
  assert.equal(await p.canInsert(), false);
});
