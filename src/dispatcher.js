// Логика выдачи заявок плееру. Жизненный цикл заявки:
//   OC /next → вставка следующей в очередь PulseSync → трек стал текущим (/started) →
//   трек доигран (/played: награда выполняется) либо пропущен/прерван (/failed: баллы возвращаются).
// «Доигран» = позиция дошла почти до конца; перемотки допустимы, пропуск — нет.
// Всё внешнее (OC, плеер, часы) приходит снаружи, поэтому модуль проверяется обычным node.

import { durationOf, normalizeTrackId, positionOf } from './nowplaying.js';

export const START_TIMEOUT_MS = 30 * 60 * 1000;
// Вставка «следующим» не подтверждается самим SDK, а очередь «Моей волны» может вытеснить вставленный трек:
// после вставки проверяем, что он стоит в очереди после текущего, и повторяем вставку, если нет.
export const VERIFY_GRACE_MS = 1500;
export const MAX_INSERT_ATTEMPTS = 3;
export const END_TOLERANCE_MS = 5000;

/** За сколько до конца трек считается доигранным (для коротких треков — не более 20% длительности). */
export const endTolerance = durationMs => Math.min(END_TOLERANCE_MS, durationMs * 0.2);

// id элемента очереди бывает «трек» или «трек:альбом» (вставленный и ещё не загруженный элемент): сравниваем по номеру трека.
const idOf = entry => normalizeTrackId(entry?.id);

/** Трек стал текущим: индекс сдвинулся относительно момента вставки и на нём лежит ожидаемый trackId. */
export function isStarted(snapshot, active) {
  const index = snapshot?.currentIndex;
  if (!Number.isInteger(index) || index === active.startIndex || !Array.isArray(snapshot?.items)) return false;
  return idOf(snapshot.items[index]) === active.item.trackId;
}

const message = error => (error instanceof Error ? error.message : String(error));

/**
 * trackCompletion=false — у PulseSync нет API состояния плеера: следить за доигрыванием нечем,
 * и награда выполняется на старте трека, как раньше.
 */
export function createDispatcher({ client, player, now = Date.now, startTimeoutMs = START_TIMEOUT_MS, trackCompletion = true, notify = () => {}, log = {} }) {
  const logger = { info() {}, warn() {}, error() {}, ...log };
  let stopped = false;
  let busy = false;
  let phase = 'idle'; // idle | waiting: заявка вставлена в очередь плеера, ждём её старта
  let active = null; // {item, startIndex, at}
  let playing = null; // {item, durationMs, positionMs}: трек играет, ждём доигрывания
  let adopted = !trackCompletion; // после перезапуска аддона подхватываем играющую заявку один раз
  const reports = []; // неотправленные подтверждения {kind: started|played|failed, item, reason}: уходят строго по порядку
  let connected = null;
  let lastError = '';
  let waitingForPlayer = false;
  let lastBlocker = null;
  // Без метода canInsert (в тестах, в старых адаптерах) считаем, что вставлять можно.
  const canInsert = async () => (typeof player.canInsert === 'function' ? await player.canInsert() : true);

  function setConnected(ok, error) {
    lastError = ok ? '' : message(error);
    if (connected === ok) return;
    connected = ok;
    notify({ type: 'connection', connected: ok, error: lastError });
  }

  const report = (kind, item, reason) => reports.push({ kind, item, reason });

  async function send({ kind, item, reason }) {
    if (kind === 'started') await client.started(item.id);
    else if (kind === 'played') await client.played(item.id);
    else await client.failed(item.id, reason);
  }

  async function flush() {
    while (reports.length) {
      const r = reports[0];
      try {
        await send(r);
        reports.shift();
        setConnected(true);
        notify({ type: r.kind, item: r.item, reason: r.reason });
      } catch (error) {
        if (error && error.retryable === false) {
          // OC уже не принимает это подтверждение (заявки нет или статус не тот): повтор ничего не изменит.
          reports.shift();
          logger.error('OC отклонил подтверждение заявки', { id: r.item.id, kind: r.kind, error: message(error) });
          notify({ type: 'dropped', item: r.item, kind: r.kind, error: message(error) });
          continue;
        }
        setConnected(false, error);
        return; // порядок важен: следующие подтверждения ждут
      }
    }
  }

  /** Играющая заявка закончилась (трек сменился): доигран ли он? */
  function finishPlaying() {
    if (!playing) return;
    const { item, durationMs, positionMs } = playing;
    playing = null;
    if (durationMs > 0 && durationMs - positionMs <= endTolerance(durationMs)) report('played', item);
    else report('failed', item, 'трек пропущен');
  }

  function onStarted(item) {
    finishPlaying(); // новый трек стал текущим — предыдущий закончился
    report('started', item);
    if (trackCompletion) playing = { item, durationMs: 0, positionMs: 0 };
    else report('played', item);
  }

  async function adopt() {
    let items;
    try {
      items = await client.playing();
      setConnected(true);
    } catch (error) {
      setConnected(false, error);
      return;
    }
    let currentId = null;
    try { currentId = normalizeTrackId((await player.playerSnapshot())?.track?.id); } catch { /* считаем, что трек неизвестен */ }
    for (const item of items) {
      if (!playing && !item.invalid && currentId === item.trackId) {
        const snapshot = await player.playerSnapshot();
        const durationMs = durationOf(snapshot);
        playing = { item, durationMs, positionMs: positionOf(snapshot, durationMs) };
        logger.info('Подхвачена играющая заявка после перезапуска', { id: item.id });
      } else {
        report('failed', item, 'плеер был перезапущен, трек не отслеживается');
      }
    }
    adopted = true;
  }

  async function insert(item) {
    if (item.invalid) { report('failed', item, item.invalid); return; }
    let startIndex = -1;
    try {
      const snapshot = await player.snapshot();
      if (Number.isInteger(snapshot?.currentIndex)) startIndex = snapshot.currentIndex;
    } catch (error) {
      report('failed', item, 'не удалось прочитать очередь плеера: ' + message(error));
      return;
    }
    // Состояние выставляем до вставки: PulseSync может вызвать onQueueChange синхронно.
    phase = 'waiting';
    active = { item, startIndex, at: now(), attempts: 1, lastInsertAt: now() };
    try {
      await player.addNext(item.trackId, item.albumId);
      logger.info('Заявка вставлена следующей', { id: item.id, trackId: item.trackId });
    } catch (error) {
      phase = 'idle';
      active = null;
      report('failed', item, 'не удалось добавить трек в очередь: ' + message(error));
    }
  }

  let reinserting = false;

  function failWaiting(reason) {
    report('failed', active.item, reason);
    phase = 'idle';
    active = null;
  }

  /**
   * Пока заявка ждёт старта: трек должен стоять в очереди после текущего. Если его там нет (вытеснила «Моя волна»,
   * перестроилась очередь), вставляем снова, не чаще раза в VERIFY_GRACE_MS и не более MAX_INSERT_ATTEMPTS раз.
   * Если трек стоит где-то дальше в очереди, повторно не вставляем: так он не сыграет дважды.
   */
  async function verifyQueued(snapshot) {
    if (stopped || phase !== 'waiting' || !active || reinserting) return;
    const index = snapshot?.currentIndex;
    if (!Number.isInteger(index) || !Array.isArray(snapshot?.items)) return;
    if (snapshot.items.slice(index + 1).some(entry => idOf(entry) === active.item.trackId)) return;
    if (now() - active.lastInsertAt < VERIFY_GRACE_MS) return;
    if (active.attempts >= MAX_INSERT_ATTEMPTS) {
      failWaiting('плеер не удержал трек в очереди (очередь его вытеснила)');
      return;
    }
    logger.warn('Трек не стоит в очереди после текущего', typeof player.diagnostics === 'function' ? await player.diagnostics() : undefined);
    reinserting = true;
    active.attempts += 1;
    active.lastInsertAt = now();
    try {
      await player.addNext(active.item.trackId, active.item.albumId);
      logger.info('Трек не найден в очереди, вставлен повторно', { id: active.item.id, attempt: active.attempts });
    } catch (error) {
      if (active) failWaiting('не удалось добавить трек в очередь: ' + message(error));
    } finally {
      reinserting = false;
    }
  }

  async function readQueue() {
    try { return await player.snapshot(); } catch { return null; }
  }

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      await flush();
      if (reports.length) return; // пока подтверждения не ушли, новую заявку не берём: OC отдал бы ту же с resend
      if (!adopted) {
        await adopt();
        if (!adopted) return;
        await flush();
        if (reports.length) return;
      }
      if (phase === 'waiting') {
        await verifyQueued(await readQueue());
        if (phase === 'waiting' && now() - active.at > startTimeoutMs) failWaiting('трек не начал играть вовремя');
        await flush();
        return;
      }
      // Пока в плеере нет загруженного трека, заявку не берём вовсе: она остаётся в очереди OC, а не зависает «отданной».
      waitingForPlayer = !(await canInsert());
      if (waitingForPlayer) {
        const why = typeof player.insertBlocker === 'function' ? await player.insertBlocker() : '';
        if (why !== lastBlocker) {
          lastBlocker = why;
          logger.warn('Вставка отложена: ' + why, typeof player.diagnostics === 'function' ? await player.diagnostics() : undefined);
        }
        return;
      }
      lastBlocker = null;
      let next;
      try {
        next = await client.next();
        setConnected(true);
      } catch (error) {
        setConnected(false, error);
        return;
      }
      if (stopped || !next.item) return;
      await insert(next.item);
      await flush();
    } catch (error) {
      logger.error('Сбой цикла выдачи заявок', error);
    } finally {
      busy = false;
    }
  }

  /** Вызывать на каждое изменение очереди PulseSync: подтверждает старт вставленного трека. */
  function observe(snapshot) {
    if (stopped || phase !== 'waiting') return Promise.resolve();
    if (!isStarted(snapshot, active)) {
      return verifyQueued(snapshot).then(() => (reports.length ? tick() : undefined));
    }
    const { item } = active;
    phase = 'idle';
    active = null;
    onStarted(item);
    return tick();
  }

  /** Вызывать на каждое изменение состояния плеера: следит за позицией играющей заявки. */
  function observePlayer(snapshot) {
    if (stopped || !playing) return Promise.resolve();
    const id = normalizeTrackId(snapshot?.track?.id);
    if (!id) return Promise.resolve();
    if (id !== playing.item.trackId) {
      finishPlaying(); // играет уже другой трек
      return tick();
    }
    const durationMs = durationOf(snapshot);
    if (durationMs > 0) playing.durationMs = durationMs;
    playing.positionMs = positionOf(snapshot, playing.durationMs);
    if (playing.durationMs > 0 && playing.positionMs > 0 && playing.durationMs - playing.positionMs <= endTolerance(playing.durationMs)) {
      report('played', playing.item);
      playing = null;
      return tick();
    }
    return Promise.resolve();
  }

  return {
    tick,
    observe,
    observePlayer,
    stop() { stopped = true; },
    status: () => ({ phase, waitingForPlayer, connected, lastError, activeId: active?.item.id ?? null, attempts: active?.attempts ?? 0, playingId: playing?.item.id ?? null, pendingReports: reports.length, nextReport: reports[0]?.kind ?? null }),
  };
}
