import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher, isStarted } from '../src/dispatcher.js';
import { OcError } from '../src/oc-client.js';

const item = (id, trackId = String(id * 10), extra = {}) => ({ id, trackId, albumId: '1', user: 'u', ...extra });

function setup({ items = [], snapshot, addNext, startTimeoutMs } = {}) {
  const s = { queue: [...items], calls: [], inserted: [], events: [], t: 0, netDown: false, reportErr: null,
    snap: snapshot || { currentIndex: 0, items: [{ id: 'cur' }] } };
  const client = {
    async next() { s.calls.push('next'); if (s.netDown) throw new OcError('down'); return { item: s.queue[0] ?? null, resend: false }; },
    async started(id) { s.calls.push('started:' + id); if (s.reportErr) throw s.reportErr; s.queue.shift(); },
    async failed(id, reason) { s.calls.push('failed:' + id); s.lastReason = reason; if (s.reportErr) throw s.reportErr; s.queue.shift(); },
  };
  const player = { snapshot: () => s.snap, addNext: addNext ? (...a) => addNext(s, ...a) : async (t, a) => { s.inserted.push([t, a]); } };
  s.d = createDispatcher({ client, player, now: () => s.t, startTimeoutMs, notify: e => s.events.push(e) });
  return s;
}
const playing = (idx, id) => ({ currentIndex: idx, items: Array.from({ length: idx + 1 }, (_, i) => ({ id: i === idx ? id : 'x' + i })) });

test('isStarted needs a moved index and the expected track', () => {
  const a = { startIndex: 0, item: { trackId: '10' } };
  assert.equal(isStarted(playing(1, '10'), a), true);
  assert.equal(isStarted(playing(0, '10'), a), false);
  assert.equal(isStarted(playing(1, '99'), a), false);
  assert.equal(isStarted({ currentIndex: 1 }, a), false);
  assert.equal(isStarted(null, a), false);
});

test('happy path: insert next, confirm on start', async () => {
  const s = setup({ items: [item(1)] });
  await s.d.tick();
  assert.deepEqual(s.inserted, [['10', '1']]);
  assert.equal(s.d.status().phase, 'waiting');
  await s.d.observe(playing(1, '10'));
  assert.deepEqual(s.calls, ['next', 'started:1', 'next']); // после подтверждения сразу берём следующую
  assert.equal(s.d.status().phase, 'idle');
  assert.equal(s.events.at(-1).type, 'started');
});

test('FIFO: second request is not fetched until the first starts', async () => {
  const s = setup({ items: [item(1), item(2)] });
  await s.d.tick(); await s.d.tick(); await s.d.tick();
  assert.equal(s.calls.filter(c => c === 'next').length, 1);
  assert.equal(s.inserted.length, 1);
  await s.d.observe(playing(1, '10'));
  await s.d.tick();
  assert.deepEqual(s.inserted.map(i => i[0]), ['10', '20']);
});

test('other track or unchanged index does not confirm', async () => {
  const s = setup({ items: [item(1)] });
  await s.d.tick();
  await s.d.observe(playing(1, '999'));
  await s.d.observe(playing(0, '10'));
  assert.equal(s.d.status().phase, 'waiting');
  assert.ok(!s.calls.includes('started:1'));
});

test('queue change fired synchronously during insertion is not lost', async () => {
  const s = setup({ items: [item(1)], addNext: async (st) => { await st.d.observe(playing(1, '10')); } });
  await s.d.tick();
  await s.d.tick();
  assert.ok(s.calls.includes('started:1'));
});

test('insertion error reports failed and the queue moves on', async () => {
  const s = setup({ items: [item(1)], addNext: async () => { throw new Error('boom'); } });
  await s.d.tick();
  assert.deepEqual(s.calls, ['next', 'failed:1']);
  assert.match(s.lastReason, /boom/);
  assert.equal(s.d.status().phase, 'idle');
});

test('snapshot read error reports failed', async () => {
  const s = setup({ items: [item(1)] });
  const bad = createDispatcher({ client: { next: async () => ({ item: item(1) }), started: async () => {}, failed: async (id, r) => { s.lastReason = r; } }, player: { snapshot() { throw new Error('nosnap'); }, addNext: async () => {} } });
  await bad.tick();
  assert.match(s.lastReason, /nosnap/);
});

test('invalid item is rejected without touching the player', async () => {
  const s = setup({ items: [{ id: 7, user: 'u', invalid: 'bad track' }] });
  await s.d.tick();
  assert.deepEqual(s.calls, ['next', 'failed:7']);
  assert.equal(s.inserted.length, 0);
  assert.equal(s.lastReason, 'bad track');
});

test('start timeout fails the request', async () => {
  const s = setup({ items: [item(1)], startTimeoutMs: 1000 });
  await s.d.tick();
  s.t = 500; await s.d.tick();
  assert.ok(!s.calls.includes('failed:1'));
  s.t = 1501; await s.d.tick();
  assert.ok(s.calls.includes('failed:1'));
  assert.equal(s.d.status().phase, 'idle');
});

test('unsent confirmation is retried and nothing is inserted twice', async () => {
  const s = setup({ items: [item(1), item(2)] });
  await s.d.tick();
  s.reportErr = new OcError('down');
  await s.d.observe(playing(1, '10'));
  assert.equal(s.d.status().pendingReport, 'started');
  await s.d.tick();
  assert.equal(s.calls.filter(c => c === 'next').length, 1);
  assert.equal(s.inserted.length, 1);
  s.reportErr = null;
  await s.d.tick();
  assert.equal(s.d.status().pendingReport, null);
  assert.deepEqual(s.calls.filter(c => c.startsWith('started')).length >= 3, true);
  assert.equal(s.inserted.length, 2); // следующая заявка взята только после подтверждения первой
});

test('non-retryable report error drops the confirmation', async () => {
  const s = setup({ items: [item(1)] });
  await s.d.tick();
  s.reportErr = new OcError('gone', { status: 404, retryable: false });
  await s.d.observe(playing(1, '10'));
  assert.equal(s.d.status().pendingReport, null);
  assert.equal(s.events.at(-1).type, 'dropped');
});

test('connection events fire only on change; polling continues after outage', async () => {
  const s = setup({ items: [] });
  s.netDown = true;
  await s.d.tick(); await s.d.tick();
  s.netDown = false;
  await s.d.tick(); await s.d.tick();
  assert.deepEqual(s.events.filter(e => e.type === 'connection').map(e => e.connected), [false, true]);
});

test('stop disables everything', async () => {
  const s = setup({ items: [item(1)] });
  s.d.stop();
  await s.d.tick();
  assert.deepEqual(s.calls, []);
});

test('concurrent ticks do not double-fetch', async () => {
  const s = setup({ items: [item(1)] });
  await Promise.all([s.d.tick(), s.d.tick(), s.d.tick()]);
  assert.equal(s.calls.filter(c => c === 'next').length, 1);
});
