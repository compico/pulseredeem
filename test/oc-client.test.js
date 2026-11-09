import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcClient, normalizeBaseUrl, parseItem, OcError } from '../src/oc-client.js';

const res = (status, body, badJson) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (badJson) throw new Error('bad'); return body; } });
const mk = (handler) => { const calls = []; const fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); }; return { calls, client: createOcClient({ fetch }) }; };

test('normalizeBaseUrl accepts only http loopback', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/x'), 'http://127.0.0.1:8000');
  assert.equal(normalizeBaseUrl('http://localhost:8000'), 'http://localhost:8000');
  for (const bad of ['https://127.0.0.1:8000', 'http://example.com', 'http://u:p@127.0.0.1', 'nope', '', null]) assert.equal(normalizeBaseUrl(bad), null);
  assert.throws(() => createOcClient({ fetch() {}, baseUrl: 'http://evil.test' }));
});

test('parseItem', () => {
  assert.equal(parseItem(null), null);
  assert.deepEqual(parseItem({ id: 3, trackId: '55', albumId: '7', user: 'bob' }), { id: 3, trackId: '55', albumId: '7', user: 'bob' });
  assert.equal(parseItem({ id: 3, trackId: '55', albumId: 'x' }).albumId, undefined);
  assert.match(parseItem({ id: 3, trackId: '5; drop' }).invalid, /trackId/);
  assert.match(parseItem({ id: 3 }).invalid, /trackId/);
  for (const bad of [{ trackId: '1' }, { id: 0, trackId: '1' }, { id: 1.5, trackId: '1' }, 'x']) assert.throws(() => parseItem(bad), OcError);
});

test('next returns item and resend flag', async () => {
  const { client, calls } = mk(() => res(200, { item: { id: 1, trackId: '9' }, resend: true }));
  const r = await client.next();
  assert.equal(r.item.trackId, '9'); assert.equal(r.resend, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/plugins/music/api/next');
  assert.equal(calls[0].init.method, 'GET');
});

test('next with empty queue', async () => {
  const { client } = mk(() => res(200, { item: null }));
  assert.deepEqual(await client.next(), { item: null, resend: false });
});

test('started and failed send the expected JSON', async () => {
  const { client, calls } = mk(() => res(200, {}));
  await client.started(4);
  await client.failed(5, 'x'.repeat(500));
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/plugins/music/api/started');
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 4 });
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(calls[1].init.body).reason.length, 200);
});

test('error classification', async () => {
  for (const [status, retryable] of [[400, false], [404, false], [409, false], [500, true], [503, true]]) {
    const { client } = mk(() => res(status, {}));
    await assert.rejects(client.started(1), e => e instanceof OcError && e.status === status && e.retryable === retryable);
  }
  await assert.rejects(mk(() => { throw new Error('ECONNREFUSED'); }).client.next(), e => e.retryable && /недоступен/.test(e.message));
  await assert.rejects(mk(() => res(200, null, true)).client.next(), e => e instanceof OcError);
  await assert.rejects(mk(() => res(200, null)).client.next(), OcError);
});
