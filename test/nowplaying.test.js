import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrackId, durationOf, positionOf, toNowPlaying, createNowPlayingPublisher } from '../src/nowplaying.js';

const snap = (over = {}) => ({
  isPlaying: true,
  track: { id: '55', title: 'Song', version: 'Live', artists: [{ name: 'A' }, { name: 'B' }, {}], coverUri: 'avatars.yandex.net/x/%%', durationMs: 200000 },
  progress: { position: 10, duration: 200 },
  ...over,
});

test('normalizeTrackId', () => {
  assert.equal(normalizeTrackId('123'), '123');
  assert.equal(normalizeTrackId('123:456'), '123');
  for (const bad of ['', 'abc', '12 3', '1:', ':1', null, undefined, '1'.repeat(21)]) assert.equal(normalizeTrackId(bad), null);
});

test('durationOf prefers durationMs then seconds', () => {
  assert.equal(durationOf(snap()), 200000);
  assert.equal(durationOf({ track: { duration: 90 } }), 90000);
  assert.equal(durationOf({ duration: 30, track: {} }), 30000);
  assert.equal(durationOf({ progress: { duration: 12 }, track: {} }), 12000);
  assert.equal(durationOf({ track: { durationMs: -1 } }), 0);
  assert.equal(durationOf(null), 0);
});

test('positionOf detects units', () => {
  assert.equal(positionOf(snap(), 200000), 10000);                                   // секунды, длительность прогресса в секундах
  assert.equal(positionOf(snap({ progress: { position: 10000, duration: 200000 } }), 200000), 10000); // миллисекунды
  assert.equal(positionOf({ progress: 42 }, 200000), 42000);                          // число, похоже на секунды
  assert.equal(positionOf({ progress: 42000 }, 200000), 42000);                       // число, похоже на мс
  assert.equal(positionOf({ progress: 42 }, 0), 42000);                               // длительности нет — секунды
  assert.equal(positionOf({ progress: { position: 999, duration: 200 } }, 200000), 200000); // не больше длительности
  for (const bad of [null, undefined, {}, { progress: { position: -1 } }, { progress: NaN }, { progress: 'x' }]) assert.equal(positionOf(bad, 1000), 0);
});

test('toNowPlaying maps a snapshot', () => {
  assert.deepEqual(toNowPlaying(snap()), { trackId: '55', title: 'Song Live', artists: ['A', 'B'], cover: 'avatars.yandex.net/x/%%', durationMs: 200000, positionMs: 10000, playing: true });
  assert.equal(toNowPlaying(snap({ isPlaying: false })).playing, false);
  assert.equal(toNowPlaying(snap({ isPlaying: 'yes' })).playing, false);
  assert.equal(toNowPlaying(snap({ track: { id: 'local-file' } })), null);
  assert.equal(toNowPlaying({ track: null }), null);
  assert.equal(toNowPlaying(undefined), null);
  assert.equal(toNowPlaying(snap({ track: { id: '7', artists: 'nope', coverUri: 5 } })).cover, '');
});

function pub({ fail = false } = {}) {
  const s = { sent: [], t: 0, fail };
  const client = { async nowPlaying(b) { if (s.fail) throw new Error('down'); s.sent.push(b); } };
  s.p = createNowPlayingPublisher({ client, player: {}, now: () => s.t, heartbeatMs: 5000, log: { warn: (...a) => (s.warns = [...(s.warns || []), a]) } });
  return s;
}

test('sends first state, then only on change or heartbeat', async () => {
  const s = pub();
  await s.p.update(snap());
  s.t = 1000; await s.p.update(snap({ progress: { position: 11, duration: 200 } })); // идёт как ожидалось
  assert.equal(s.sent.length, 1);
  s.t = 5000; await s.p.update(snap({ progress: { position: 15, duration: 200 } })); // heartbeat
  assert.equal(s.sent.length, 2);
});

test('sends immediately on pause, track change, seek and stop', async () => {
  const s = pub();
  await s.p.update(snap());
  s.t = 100; await s.p.update(snap({ isPlaying: false }));
  assert.equal(s.sent.length, 2);
  s.t = 200; await s.p.update(snap({ isPlaying: false, track: { ...snap().track, id: '56' } }));
  assert.equal(s.sent.length, 3);
  s.t = 300; await s.p.update(snap({ isPlaying: false, track: { ...snap().track, id: '56' }, progress: { position: 120, duration: 200 } }));
  assert.equal(s.sent.length, 4);
  s.t = 400; await s.p.update({ track: null });
  assert.deepEqual(s.sent.at(-1), { trackId: '' });
  s.t = 500; await s.p.update({ track: null });
  assert.equal(s.sent.length, 5);
});

test('a failing OC is retried at most once per heartbeat and warned once', async () => {
  const s = pub({ fail: true });
  await s.p.update(snap()); s.t = 100; await s.p.update(snap()); s.t = 4999; await s.p.update(snap());
  assert.equal(s.warns.length, 1);
  s.fail = false; s.t = 5000; await s.p.update(snap());
  assert.equal(s.sent.length, 1);
});

test('stop disables sending; overlapping updates are ignored', async () => {
  const s = pub();
  await Promise.all([s.p.update(snap()), s.p.update(snap())]);
  assert.equal(s.sent.length, 1);
  s.p.stop(); s.t = 99999; await s.p.update(snap({ isPlaying: false }));
  assert.equal(s.sent.length, 1);
});

test('a throwing player snapshot is logged, not thrown', async () => {
  const warns = [];
  const p = createNowPlayingPublisher({ client: { nowPlaying: async () => { throw new Error('must not be called'); } }, player: { playerSnapshot() { throw new Error('boom'); } }, log: { warn: (...a) => warns.push(a) } });
  await p.update();
  assert.equal(warns.length, 1);
});
