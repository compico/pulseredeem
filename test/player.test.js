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
