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
  assert.equal(p.snapshot().currentIndex, 2);
  const bad = createPlayer({ getQueueSnapshot() {}, addTrackToQueueById: async () => { throw new Error('x'); } });
  await assert.rejects(bad.addNext('1'), /x/);
});

test('canInsert needs a loaded current track (inserting into an idle player crashes the host UI)', () => {
  const mk = (queue, state) => createPlayer({ getQueueSnapshot: () => queue, addTrackToQueueById() {}, ...(state === undefined ? {} : { getPlayerSnapshot: () => state }) });
  const q = { currentIndex: 0, items: [{ id: '1' }] };
  const playing = { status: 'playing', isPlaying: true, track: { id: '1' } };
  assert.equal(mk(q, playing).canInsert(), true);
  assert.equal(mk(q, { ...playing, status: 'paused', isPlaying: false }).canInsert(), true);
  assert.equal(mk(q, { ...playing, status: 'buffering', isPlaying: false }).canInsert(), true);
  assert.equal(mk(q).canInsert(), true, 'без API состояния плеера решает очередь');
  for (const bad of [null, undefined, {}, { currentIndex: null, items: [] }, { currentIndex: -1, items: [{ id: '1' }] }, { currentIndex: 0, items: [] }, { currentIndex: 3, items: [{ id: '1' }] }, { currentIndex: 0 }]) {
    assert.equal(mk(bad, playing).canInsert(), false, JSON.stringify(bad));
  }
  for (const idle of [{ status: 'idle', isPlaying: false, track: null }, { status: 'stopped', isPlaying: false, track: { id: '1' } }, { status: 'ended', isPlaying: false, track: { id: '1' } }, null]) {
    assert.equal(mk(q, idle).canInsert(), false, JSON.stringify(idle));
  }
  const broken = createPlayer({ getQueueSnapshot() { throw new Error('x'); }, addTrackToQueueById() {} });
  assert.equal(broken.canInsert(), false);
});
