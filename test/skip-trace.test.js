import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcher } from '../src/dispatcher.js';
import { createController } from '../src/controls.js';
import { createTracer, summarizeQueue } from '../src/tracer.js';

// Снимок плеера: позиция и длительность в секундах, как в PulseSync.
const ps = (trackId, pos, dur = 200, isPlaying = true) => trackId === null
  ? { isPlaying: false, status: 'idle', track: null }
  : { isPlaying, status: isPlaying ? 'playing' : 'paused', track: { id: trackId, title: 'T' + trackId, durationMs: dur * 1000 }, progress: { position: pos, duration: dur } };

// Мир: плагин OC (заявки), очередь и плеер PulseSync. Всё, что аддон делает с плеером, записывается.
function world({ requests = [], current = null } = {}) {
  const w = {
    oc: requests.map(r => ({ ...r, status: 'queued' })),
    queue: current ? [{ id: current }] : [], index: current ? 0 : -1,
    player: current ? ps(current, 5) : ps(null),
    controls: [], inserts: [], logs: [], commands: [], reports: [],
  };
  const find = id => w.oc.find(r => r.id === id);
  const client = {
    async next() {
      const it = w.oc.find(r => r.status === 'sent') || w.oc.find(r => r.status === 'queued');
      if (!it) return { item: null, resend: false };
      const resend = it.status === 'sent'; it.status = 'sent'; return { item: it, resend };
    },
    async started(id) { w.reports.push('started:' + id); find(id).status = 'playing'; },
    async played(id) { w.reports.push('played:' + id); find(id).status = 'played'; },
    async failed(id, reason) { w.reports.push('failed:' + id + ':' + reason); find(id).status = 'failed'; },
    async playing() { return w.oc.filter(r => r.status === 'playing'); },
    async commands() { return w.commands.splice(0); },
    async commandDone() {},
  };
  const player = {
    snapshot: async () => ({ currentIndex: w.index, items: w.queue.map(x => ({ ...x })) }),
    playerSnapshot: async () => w.player,
    canInsert: async () => w.index >= 0 && !!w.player.track,
    insertBlocker: async () => (w.index >= 0 && w.player.track ? null : 'плеер ничего не держит'),
    addNext: async trackId => { w.inserts.push(trackId); w.queue.splice(w.index + 1, 0, { id: trackId }); },
    control: async a => { w.controls.push(a); },
  };
  // «Плеер» переключает трек сам: как это делает Яндекс Музыка при окончании/пропуске.
  w.play = (trackId, pos = 0) => {
    const at = w.queue.findIndex(x => x.id === trackId);
    if (at >= 0) w.index = at; else { w.queue.push({ id: trackId }); w.index = w.queue.length - 1; }
    w.player = ps(trackId, pos);
  };
  w.seek = pos => { w.player = ps(w.player.track.id, pos); };
  const log = { info: (m, o) => w.logs.push({ level: 'info', m, o }), warn: (m, o) => w.logs.push({ level: 'warn', m, o }), error() {} };
  w.t = 1_000_000;
  w.dispatcher = createDispatcher({ client, player, now: () => w.t, log, notify: () => {} });
  w.tracer = createTracer({ log, now: () => w.t, queue: async () => ({ currentIndex: w.index, items: w.queue }), owns: id => w.dispatcher.owns(id), status: () => w.dispatcher.status() });
  w.controller = createController({ client, player, log, onCommand: c => w.tracer.noteCommand(c) });
  // Одна «секунда» работы аддона: то же, что делает main.tsx
  w.step = async (ms = 1000) => {
    w.t += ms;
    const snap = w.player;
    await w.tracer.observe(snap);
    await w.dispatcher.observePlayer(snap);
    await w.dispatcher.observe(await player.snapshot());
    await w.controller.tick();
    await w.dispatcher.tick();
  };
  return w;
}
const req = (id, trackId) => ({ id, trackId, albumId: '1', user: 'u' + id });
const changes = w => w.logs.filter(l => l.m.startsWith('Смена трека'));

test('несколько заказов и запуск плеера: аддон сам ничего не пропускает и вставляет по одному треку', async () => {
  const w = world({ requests: [req(1, '101'), req(2, '102'), req(3, '103')] });
  for (let i = 0; i < 5; i++) await w.step(); // плеер ещё не запущен: вставлять некуда
  assert.deepEqual(w.inserts, [], 'пока плеер пуст, заявки ждут в OC');
  assert.deepEqual(w.oc.map(r => r.status), ['queued', 'queued', 'queued']);

  w.queue = [{ id: '900' }]; w.index = 0; w.player = ps('900', 3); // пользователь запустил Яндекс Музыку
  for (let i = 0; i < 5; i++) await w.step();
  assert.deepEqual(w.inserts, ['101'], 'вставлена только первая заявка, остальные ждут');
  assert.equal(w.oc[1].status, 'queued');

  // 900 доигрывает, начинается 101
  w.seek(197); await w.step(); w.play('101', 0); await w.step(); await w.step();
  assert.ok(w.reports.includes('started:1'));
  assert.deepEqual(w.inserts, ['101', '102'], 'вторая заявка вставляется только когда первая стала текущей');

  w.seek(198); await w.step(); w.play('102', 0); await w.step(); await w.step();
  w.seek(199); await w.step(); w.play('103', 0); await w.step(); await w.step();
  assert.deepEqual(w.inserts, ['101', '102', '103']);
  assert.deepEqual(w.controls, [], 'аддон не вызывал ни play, ни pause, ни skip');
  assert.ok(w.reports.includes('played:1') && w.reports.includes('played:2'));
  // все смены — доигранные треки, ни одной «не от аддона»
  assert.ok(changes(w).length >= 3);
  assert.ok(changes(w).every(c => c.o.reason === 'доигран'), JSON.stringify(changes(w).map(c => c.o.reason)));
});

test('команда skip: журнал называет команду, пропускаемый трек, очередь и следующий трек', async () => {
  const w = world({ requests: [req(1, '101'), req(2, '102')], current: '900' });
  await w.step(); await w.step();
  w.play('101', 0); await w.step(); await w.step(); // заявка 1 играет, заявка 2 вставлена следующей
  w.seek(40); await w.step();
  w.commands.push({ id: 77, action: 'skip' });
  await w.step();
  assert.deepEqual(w.controls, ['skip']);
  const cmd = w.logs.find(l => l.m.startsWith('Команда пульта: пропуск'));
  assert.ok(cmd, 'команда залогирована до исполнения');
  assert.equal(cmd.o.commandId, 77);
  assert.equal(cmd.o.skipping.id, '101');
  assert.equal(cmd.o.skipping.position, '40 с');
  assert.deepEqual(cmd.o.ours, { request: 1, user: 'u1', state: 'playing' });
  assert.ok(cmd.o.queue.ahead.includes('102'), 'в очереди виден следующий трек');

  w.play('102', 0); await w.step(); // плеер переключился в ответ на команду
  const ch = changes(w).at(-1);
  assert.equal(ch.level, 'warn');
  assert.equal(ch.o.reason, 'команда skip #77');
  assert.equal(ch.o.from.id, '101');
  assert.equal(ch.o.to.id, '102');
  assert.deepEqual(ch.o.fromOurs, { request: 1, user: 'u1', state: 'playing' });
  assert.ok(ch.o.toOurs && ch.o.toOurs.request === 2);
  // заявку 1 пропустили — это же видно в журнале диспетчера
  assert.ok(w.logs.some(l => l.m.startsWith('Заявка не доиграна') && l.o.id === 1 && l.o.positionMs < l.o.durationMs));
  assert.ok(w.reports.some(r => r.startsWith('failed:1:')));
});

test('смена без нашей команды: причина «не от аддона», подозрение на недоступный трек при обрыве сразу после старта', async () => {
  const w = world({ requests: [req(1, '101'), req(2, '102'), req(3, '103')], current: '900' });
  await w.step(); await w.step();
  w.play('101', 0); await w.step(); await w.step();
  w.seek(1); await w.step();
  w.play('102', 0); await w.step(); // трек 101 оборвался через 1 с — команды не было
  const a = changes(w).at(-1);
  assert.equal(a.level, 'warn');
  assert.match(a.o.reason, /^не от аддона: трек оборвался через 1 с/);
  assert.equal(a.o.from.id, '101');
  assert.equal(w.controls.length, 0);

  w.seek(60); await w.step();
  w.play('103', 0); await w.step(); // пользователь переключил в середине
  const b = changes(w).at(-1);
  assert.match(b.o.reason, /^не от аддона \(пользователь/);
  assert.equal(b.o.queue.length >= 1, true);
});

test('команда старше окна не приписывается смене трека', async () => {
  const w = world({ requests: [], current: '900' });
  await w.step();
  w.seek(30); await w.step();
  w.commands.push({ id: 5, action: 'skip' }); await w.step();
  w.t += 20_000;
  w.play('901', 0); await w.step();
  assert.match(changes(w).at(-1).o.reason, /^не от аддона/);
});

test('summarizeQueue: индекс, текущий и следующие', () => {
  assert.equal(summarizeQueue(null), null);
  assert.deepEqual(summarizeQueue({ currentIndex: 1, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] }, 2), { index: 1, length: 4, current: 'b', ahead: ['c', 'd'] });
});
