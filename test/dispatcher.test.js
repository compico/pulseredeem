import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher, isStarted, endTolerance } from '../src/dispatcher.js';
import { OcError } from '../src/oc-client.js';

const item = (id, trackId = String(id * 10), extra = {}) => ({ id, trackId, albumId: '1', user: 'u', ...extra });
const qsnap = (idx, id) => ({ currentIndex: idx, items: Array.from({ length: idx + 1 }, (_, i) => ({ id: i === idx ? id : 'x' + i })) });
// Снимок плеера: позиция и длительность в секундах, как в PulseSync.
const ps = (trackId, pos, dur = 200, isPlaying = true) => ({ isPlaying, track: { id: trackId, durationMs: dur * 1000 }, progress: { position: pos, duration: dur } });

// Маленькая модель плагина OC: статусы и порядок выдачи как у настоящего.
function setup({ items = [], addNext, startTimeoutMs, trackCompletion, playerSnap, adoptFail, canInsert } = {}) {
  const s = { plugin: items.map(i => ({ ...i, status: i.invalid ? 'queued' : 'queued' })), calls: [], inserted: [], events: [], t: 0, netDown: false, reportErr: null, lastReason: {},
    snap: { currentIndex: 0, items: [{ id: 'cur' }] }, player: playerSnap ?? ps('cur', 10) };
  const find = id => s.plugin.find(i => i.id === id);
  const client = {
    async next() {
      s.calls.push('next'); if (s.netDown) throw new OcError('down');
      const it = s.plugin.find(i => i.status === 'sent') || s.plugin.find(i => i.status === 'queued');
      if (!it) return { item: null, resend: false };
      const resend = it.status === 'sent'; it.status = 'sent'; return { item: it, resend };
    },
    async started(id) { s.calls.push('started:' + id); if (s.reportErr) throw s.reportErr; find(id).status = 'playing'; },
    async played(id) { s.calls.push('played:' + id); if (s.reportErr) throw s.reportErr; find(id).status = 'played'; },
    async failed(id, reason) { s.calls.push('failed:' + id); s.lastReason[id] = reason; if (s.reportErr) throw s.reportErr; find(id).status = 'failed'; },
    async playing() { s.calls.push('playing'); if (adoptFail && s.adoptDown) throw new OcError('down'); return s.plugin.filter(i => i.status === 'playing'); },
  };
  const player = { snapshot: () => s.snap, playerSnapshot: () => s.player, ...(canInsert ? { canInsert: () => s.ready } : {}), addNext: addNext ? (...a) => addNext(s, ...a) : async (t, a) => { s.inserted.push([t, a]); } };
  s.d = createDispatcher({ client, player, now: () => s.t, startTimeoutMs, trackCompletion, notify: e => s.events.push(e) });
  s.status = id => find(id).status;
  return s;
}
// Первая заявка: вставлена и стала текущей (играет).
async function startFirst(s, trackId = '10') { await s.d.tick(); await s.d.observe(qsnap(1, trackId)); }

test('isStarted needs a moved index and the expected track', () => {
  const a = { startIndex: 0, item: { trackId: '10' } };
  assert.equal(isStarted(qsnap(1, '10'), a), true);
  assert.equal(isStarted(qsnap(0, '10'), a), false);
  assert.equal(isStarted(qsnap(1, '99'), a), false);
  assert.equal(isStarted({ currentIndex: 1 }, a), false);
  assert.equal(isStarted(null, a), false);
});

test('endTolerance is 5 s, but at most 20% of a short track', () => {
  assert.equal(endTolerance(200000), 5000);
  assert.equal(endTolerance(10000), 2000);
});

test('reward is committed only when the track is played to the end', async () => {
  const s = setup({ items: [item(1)] });
  await startFirst(s);
  assert.equal(s.status(1), 'playing');
  assert.ok(!s.calls.includes('played:1'), 'на старте награду не выполняем');
  await s.d.observePlayer(ps('10', 100));
  assert.equal(s.status(1), 'playing');
  await s.d.observePlayer(ps('10', 196));
  assert.equal(s.status(1), 'played');
  assert.ok(s.events.some(e => e.type === 'played'));
});

test('skipping before the end refunds (player moved to another track)', async () => {
  const s = setup({ items: [item(1)] });
  await startFirst(s);
  await s.d.observePlayer(ps('10', 60));
  await s.d.observePlayer(ps('77', 0));
  assert.equal(s.status(1), 'failed');
  assert.match(s.lastReason[1], /пропущен/);
});

test('seeks forward and back and a pause are fine, only reaching the end counts', async () => {
  const s = setup({ items: [item(1)] });
  await startFirst(s);
  for (const snap of [ps('10', 10), ps('10', 150), ps('10', 20), ps('10', 20, 200, false), ps('10', 190, 200, false), ps('10', 21)]) await s.d.observePlayer(snap);
  assert.equal(s.status(1), 'playing');
  await s.d.observePlayer(ps('10', 197));
  assert.equal(s.status(1), 'played');
});

test('snapshots without a track or from nothing-playing are ignored', async () => {
  const s = setup({ items: [item(1)] });
  await s.d.observePlayer(ps('10', 5)); // ничего не играет
  await startFirst(s);
  await s.d.observePlayer({ track: null });
  await s.d.observePlayer(undefined);
  await s.d.observePlayer(ps('local-file', 1));
  assert.equal(s.status(1), 'playing');
});

test('the next request is fetched while the previous one plays, one at a time (FIFO)', async () => {
  const s = setup({ items: [item(1), item(2), item(3)] });
  await startFirst(s);                                // 1 играет, 2 вставлена и ждёт старта
  assert.deepEqual(s.inserted.map(i => i[0]), ['10', '20']);
  await s.d.tick(); await s.d.tick();
  assert.equal(s.calls.filter(c => c === 'next').length, 2, 'пока вторая ждёт старта, третью не берём');
  await s.d.observePlayer(ps('10', 197));             // 1 доиграла
  assert.equal(s.status(1), 'played');
  await s.d.observe(qsnap(2, '20'));                  // 2 стала текущей → берём третью
  assert.equal(s.status(2), 'playing');
  assert.deepEqual(s.inserted.map(i => i[0]), ['10', '20', '30']);
});

test('queue change to the next track before the previous one finished refunds the previous one first', async () => {
  const s = setup({ items: [item(1), item(2)] });
  await startFirst(s);
  await s.d.observePlayer(ps('10', 50));
  await s.d.observe(qsnap(2, '20')); // пропустили вручную: очередь сменилась раньше, чем снимок плеера
  assert.equal(s.status(1), 'failed');
  assert.equal(s.status(2), 'playing');
  assert.ok(s.calls.indexOf('failed:1') < s.calls.indexOf('started:2'), 'порядок подтверждений сохраняется');
});

test('other track or unchanged index does not confirm the start', async () => {
  const s = setup({ items: [item(1)] });
  await s.d.tick();
  await s.d.observe(qsnap(1, '999'));
  await s.d.observe(qsnap(0, '10'));
  assert.equal(s.d.status().phase, 'waiting');
  assert.ok(!s.calls.includes('started:1'));
});

test('queue change fired synchronously during insertion is not lost', async () => {
  const s = setup({ items: [item(1)], addNext: async (st) => { await st.d.observe(qsnap(1, '10')); } });
  await s.d.tick(); await s.d.tick();
  assert.ok(s.calls.includes('started:1'));
});

test('insertion error refunds and the queue moves on', async () => {
  const s = setup({ items: [item(1)], addNext: async () => { throw new Error('boom'); } });
  await s.d.tick();
  assert.equal(s.status(1), 'failed');
  assert.match(s.lastReason[1], /boom/);
  assert.equal(s.d.status().phase, 'idle');
});

test('invalid item is rejected without touching the player', async () => {
  const s = setup({ items: [{ id: 7, user: 'u', invalid: 'bad track' }] });
  await s.d.tick();
  assert.equal(s.status(7), 'failed');
  assert.equal(s.inserted.length, 0);
  assert.equal(s.lastReason[7], 'bad track');
});

test('snapshot read error refunds', async () => {
  const s = setup({ items: [item(1)] });
  s.snap = null;
  const d = createDispatcher({ client: { next: async () => ({ item: item(1) }), playing: async () => [], failed: async (id, r) => { s.lastReason.x = r; }, started: async () => {}, played: async () => {} }, player: { snapshot() { throw new Error('nosnap'); }, playerSnapshot: () => null, addNext: async () => {} } });
  await d.tick();
  assert.match(s.lastReason.x, /nosnap/);
});

test('start timeout refunds', async () => {
  const s = setup({ items: [item(1)], startTimeoutMs: 1000 });
  await s.d.tick();
  s.t = 500; await s.d.tick();
  assert.ok(!s.calls.includes('failed:1'));
  s.t = 1501; await s.d.tick();
  assert.equal(s.status(1), 'failed');
});

test('unsent confirmations are retried in order and nothing is inserted twice', async () => {
  const s = setup({ items: [item(1), item(2)] });
  await s.d.tick();
  s.reportErr = new OcError('down');
  await s.d.observe(qsnap(1, '10'));
  await s.d.observePlayer(ps('10', 197)); // started ещё не ушёл, а played уже готов
  assert.deepEqual([s.d.status().pendingReports, s.d.status().nextReport], [2, 'started']);
  await s.d.tick();
  assert.equal(s.calls.filter(c => c === 'next').length, 1, 'пока подтверждения не ушли, новую не берём');
  s.reportErr = null;
  await s.d.tick();
  assert.equal(s.status(1), 'played');
  assert.ok(s.calls.lastIndexOf('started:1') < s.calls.lastIndexOf('played:1'), 'started строго раньше played');
  assert.equal(s.inserted.length, 2, 'следующая взята только после подтверждений');
});

test('a non-retryable report is dropped and the following ones still go out', async () => {
  const s = setup({ items: [item(1)] });
  await s.d.tick();
  s.reportErr = new OcError('gone', { status: 404, retryable: false });
  await s.d.observe(qsnap(1, '10'));
  s.reportErr = null;
  await s.d.observePlayer(ps('10', 197));
  assert.equal(s.d.status().pendingReports, 0);
  assert.equal(s.events.filter(e => e.type === 'dropped').length, 1, 'отклонённый started снят, не зациклен');
  assert.equal(s.status(1), 'played', 'следующие подтверждения всё равно уходят');
});

test('connection events fire only on change; polling continues after an outage', async () => {
  const s = setup({ items: [] });
  await s.d.tick(); // подхват (/playing) успешен → связь есть
  s.netDown = true;
  await s.d.tick(); await s.d.tick();
  s.netDown = false;
  await s.d.tick(); await s.d.tick();
  assert.deepEqual(s.events.filter(e => e.type === 'connection').map(e => e.connected), [true, false, true]);
});

test('stop disables everything; concurrent ticks do not double-fetch', async () => {
  const s = setup({ items: [item(1)] });
  await Promise.all([s.d.tick(), s.d.tick(), s.d.tick()]);
  assert.equal(s.calls.filter(c => c === 'next').length, 1);
  s.d.stop();
  await s.d.observePlayer(ps('10', 197)); await s.d.tick();
  assert.equal(s.calls.filter(c => c === 'next').length, 1);
});

// --- перезапуск аддона ---

test('after a restart a still-playing request is adopted and can complete', async () => {
  const s = setup({ items: [item(1)], playerSnap: ps('10', 100) });
  s.plugin[0].status = 'playing';
  await s.d.tick();
  assert.equal(s.d.status().playingId, 1);
  assert.equal(s.status(1), 'playing');
  await s.d.observePlayer(ps('10', 198));
  assert.equal(s.status(1), 'played');
});

test('after a restart a request whose track is no longer playing is refunded', async () => {
  const s = setup({ items: [item(1)], playerSnap: ps('99', 5) });
  s.plugin[0].status = 'playing';
  await s.d.tick();
  assert.equal(s.status(1), 'failed');
  assert.match(s.lastReason[1], /перезапущен/);
});

test('an adopted request that was already at the end counts as played once the next track starts', async () => {
  const s = setup({ items: [item(1), item(2)], playerSnap: ps('10', 198) });
  s.plugin[0].status = 'playing';
  await s.d.tick(); // 1 подхвачена, 2 вставлена
  await s.d.observe(qsnap(2, '20'));
  assert.equal(s.status(1), 'played');
});

test('adoption failure blocks polling until OC answers', async () => {
  const s = setup({ items: [item(1)], adoptFail: true });
  s.adoptDown = true;
  await s.d.tick();
  assert.ok(!s.calls.includes('next'), 'пока не знаем, что играло, новую заявку не берём');
  s.adoptDown = false;
  await s.d.tick();
  assert.ok(s.calls.includes('next'));
});

test('without player state the reward is committed on start (old behaviour)', async () => {
  const s = setup({ items: [item(1)], trackCompletion: false });
  await s.d.tick();
  assert.ok(!s.calls.includes('playing'), 'подхватывать нечего');
  await s.d.observe(qsnap(1, '10'));
  assert.equal(s.status(1), 'played');
  assert.equal(s.d.status().playingId, null);
});

test('nothing is fetched or inserted while the player has no loaded track', async () => {
  const s = setup({ items: [item(1)], canInsert: true });
  s.ready = false;
  await s.d.tick(); await s.d.tick();
  assert.ok(!s.calls.includes('next'), 'заявка остаётся в очереди OC, а не «отдана»');
  assert.equal(s.inserted.length, 0);
  assert.equal(s.status(1), 'queued');
  assert.equal(s.d.status().waitingForPlayer, true);
  s.ready = true;
  await s.d.tick();
  assert.equal(s.inserted.length, 1);
  assert.equal(s.d.status().waitingForPlayer, false);
});

test('adoption and confirmations still work while the player is idle', async () => {
  const s = setup({ items: [item(1)], canInsert: true, playerSnap: ps('10', 198) });
  s.ready = false;
  s.plugin[0].status = 'playing';
  await s.d.tick();
  assert.equal(s.d.status().playingId, 1);
  await s.d.observePlayer(ps('10', 198));
  assert.equal(s.status(1), 'played', 'возврат/выполнение награды не зависит от готовности вставки');
});
