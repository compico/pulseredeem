// Логика выдачи заявок плееру: взять заявку из OC → вставить следующей в очередь PulseSync →
// дождаться, что трек стал текущим → подтвердить в OC. Всё внешнее (OC, плеер, часы) приходит снаружи.

export const START_TIMEOUT_MS = 30 * 60 * 1000;

/** Трек стал текущим: индекс сдвинулся относительно момента вставки и на нём лежит ожидаемый trackId. */
export function isStarted(snapshot, active) {
  const index = snapshot?.currentIndex;
  if (!Number.isInteger(index) || index === active.startIndex || !Array.isArray(snapshot?.items)) return false;
  return String(snapshot.items[index]?.id ?? '') === active.item.trackId;
}

const message = error => (error instanceof Error ? error.message : String(error));

export function createDispatcher({ client, player, now = Date.now, startTimeoutMs = START_TIMEOUT_MS, notify = () => {}, log = {} }) {
  const logger = { info() {}, warn() {}, error() {}, ...log };
  let stopped = false;
  let busy = false;
  let phase = 'idle'; // idle | waiting
  let active = null; // {item, startIndex, at}
  let pending = null; // неотправленное подтверждение {kind, item, reason}
  let connected = null;
  let lastError = '';

  function setConnected(ok, error) {
    lastError = ok ? '' : message(error);
    if (connected === ok) return;
    connected = ok;
    notify({ type: 'connection', connected: ok, error: lastError });
  }

  async function flush() {
    if (!pending) return;
    const { kind, item, reason } = pending;
    try {
      if (kind === 'started') await client.started(item.id);
      else await client.failed(item.id, reason);
      pending = null;
      setConnected(true);
      notify({ type: kind, item, reason });
    } catch (error) {
      if (error && error.retryable === false) {
        // OC уже не принимает это подтверждение (заявки нет или статус не тот): повтор ничего не изменит.
        pending = null;
        logger.error('OC отклонил подтверждение заявки', { id: item.id, kind, error: message(error) });
        notify({ type: 'dropped', item, kind, error: message(error) });
      } else {
        setConnected(false, error);
      }
    }
  }

  async function insert(item) {
    if (item.invalid) { pending = { kind: 'failed', item, reason: item.invalid }; return; }
    let startIndex = -1;
    try {
      const snapshot = player.snapshot();
      if (Number.isInteger(snapshot?.currentIndex)) startIndex = snapshot.currentIndex;
    } catch (error) {
      pending = { kind: 'failed', item, reason: 'не удалось прочитать очередь плеера: ' + message(error) };
      return;
    }
    // Состояние выставляем до вставки: PulseSync может вызвать onQueueChange синхронно.
    phase = 'waiting';
    active = { item, startIndex, at: now() };
    try {
      await player.addNext(item.trackId, item.albumId);
      logger.info('Заявка вставлена следующей', { id: item.id, trackId: item.trackId });
    } catch (error) {
      phase = 'idle';
      active = null;
      pending = { kind: 'failed', item, reason: 'не удалось добавить трек в очередь: ' + message(error) };
    }
  }

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      if (pending) {
        await flush();
        if (pending) return; // пока подтверждение не ушло, новую заявку не берём: OC отдал бы ту же с resend
      }
      if (phase === 'waiting') {
        if (now() - active.at > startTimeoutMs) {
          pending = { kind: 'failed', item: active.item, reason: 'трек не начал играть вовремя' };
          phase = 'idle';
          active = null;
          await flush();
        }
        return;
      }
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

  /** Вызывать на каждое изменение очереди PulseSync. */
  function observe(snapshot) {
    if (stopped || phase !== 'waiting' || !isStarted(snapshot, active)) return Promise.resolve();
    pending = { kind: 'started', item: active.item };
    phase = 'idle';
    active = null;
    return tick();
  }

  return {
    tick,
    observe,
    stop() { stopped = true; },
    status: () => ({ phase, connected, lastError, activeId: active?.item.id ?? null, pendingReport: pending?.kind ?? null }),
  };
}
