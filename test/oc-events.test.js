import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcEvents, wsUrl } from '../src/oc-events.js';

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.onclose?.(); }
  // со стороны сервера
  open() { this.onopen?.(); }
  say(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

function fakeTimers() {
  const list = [];
  return { list, set: (fn, ms) => { const t = { fn, ms }; list.push(t); return t; }, clear: t => { const i = list.indexOf(t); if (i >= 0) list.splice(i, 1); } };
}

function make(extra = {}) {
  FakeWS.all = [];
  const tm = fakeTimers();
  const log = { events: [], opens: 0, closes: 0 };
  const ev = createOcEvents({
    WebSocketImpl: FakeWS, url: 'ws://127.0.0.1:8000/plugins/music/ws', topics: ['queue', 'commands'],
    onEvent: (t, d) => log.events.push([t, d]), onOpen: () => log.opens++, onClose: () => log.closes++,
    setTimeoutFn: tm.set, clearTimeoutFn: tm.clear, ...extra,
  });
  return { ev, tm, log };
}

test('wsUrl', () => {
  assert.equal(wsUrl('http://127.0.0.1:8000'), 'ws://127.0.0.1:8000/plugins/music/ws');
  assert.equal(wsUrl('http://localhost:9'), 'ws://localhost:9/plugins/music/ws');
});

test('канал считается открытым после подтверждения всех подписок; события доходят', () => {
  const { ev, log } = make();
  const ws = FakeWS.all[0];
  assert.equal(ev.isOpen(), false);
  ws.open();
  assert.deepEqual(ws.sent, [{ t: 'sub', topic: 'queue' }, { t: 'sub', topic: 'commands' }]);
  ws.say({ t: 'hello', plugin: 'music' });
  ws.say({ t: 'sub', topic: 'queue', ok: true });
  assert.equal(ev.isOpen(), false, 'ещё не все подписки подтверждены');
  ws.say({ t: 'sub', topic: 'commands', ok: true });
  assert.equal(ev.isOpen(), true);
  assert.equal(log.opens, 1);
  ws.say({ t: 'event', topic: 'queue', data: { items: [] }, seq: 1, retained: true });
  ws.say({ t: 'event', topic: 'commands', data: { id: 5, action: 'skip' }, seq: 2 });
  assert.deepEqual(log.events.map(e => e[0]), ['queue', 'commands']);
});

test('отклонённая подписка не открывает канал; мусорные кадры игнорируются', () => {
  const { ev, log } = make();
  const ws = FakeWS.all[0];
  ws.open();
  ws.say({ t: 'sub', topic: 'queue', ok: true });
  ws.say({ t: 'sub', topic: 'commands', ok: false, error: 'unknown topic' });
  ws.onmessage({ data: 'not json' });
  ws.onmessage({ data: 42 });
  assert.equal(ev.isOpen(), false);
  assert.equal(log.opens, 0);
});

test('обрыв: onClose, переподключение с нарастающей паузой, повторное открытие', () => {
  const { ev, tm, log } = make();
  const up = ws => { ws.open(); ws.say({ t: 'sub', topic: 'queue', ok: true }); ws.say({ t: 'sub', topic: 'commands', ok: true }); };
  up(FakeWS.all[0]);
  FakeWS.all[0].close();
  assert.equal(ev.isOpen(), false);
  assert.equal(log.closes, 1);
  const retry = tm.list.find(t => t.ms === 1000);
  assert.ok(retry, 'повтор через 1 с');
  tm.list.splice(tm.list.indexOf(retry), 1); retry.fn();
  assert.equal(FakeWS.all.length, 2);
  // сервер недоступен: пауза растёт 2 с, 4 с…
  FakeWS.all[1].close();
  assert.ok(tm.list.find(t => t.ms === 2000));
  const r2 = tm.list.find(t => t.ms === 2000); tm.list.splice(tm.list.indexOf(r2), 1); r2.fn();
  FakeWS.all[2].close();
  assert.ok(tm.list.find(t => t.ms === 4000));
  const r3 = tm.list.find(t => t.ms === 4000); tm.list.splice(tm.list.indexOf(r3), 1); r3.fn();
  up(FakeWS.all[3]);
  assert.equal(ev.isOpen(), true);
  assert.equal(log.opens, 2);
  // успешное подключение сбрасывает паузу
  FakeWS.all[3].close();
  assert.ok(tm.list.find(t => t.ms === 1000));
});

test('stop закрывает соединение и не переподключается; без WebSocket — тихо отключён', () => {
  const { ev, tm } = make();
  ev.stop();
  assert.equal(tm.list.filter(t => t.ms >= 1000 && t.ms < 25000).length, 0);
  const n = FakeWS.all.length;
  assert.equal(FakeWS.all.length, n);
  const none = createOcEvents({ WebSocketImpl: undefined, url: 'ws://x', topics: ['queue'], onEvent() {} });
  assert.equal(none.isOpen(), false);
});

test('конструктор бросает — это обрыв с повтором, а не исключение наружу', () => {
  const tm = fakeTimers();
  const Bad = function () { throw new Error('blocked'); };
  const ev = createOcEvents({ WebSocketImpl: Bad, url: 'ws://x', topics: ['queue'], onEvent() {}, setTimeoutFn: tm.set, clearTimeoutFn: tm.clear });
  assert.equal(ev.isOpen(), false);
  assert.ok(tm.list.some(t => t.ms === 1000));
});
