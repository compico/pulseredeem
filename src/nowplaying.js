// «Сейчас играет» для виджета OC: превращает снимок плеера PulseSync в тело POST /nowplaying и решает, когда его слать.
// Единицы прогресса в типах SDK не описаны (в виджете PulseSync позиция в секундах), поэтому они определяются по длительности.

export const HEARTBEAT_MS = 5000; // плагин считает аддон мёртвым через 20 с тишины
const SEEK_TOLERANCE_MS = 2500; // расхождение с ожидаемой позицией, после которого считаем, что была перемотка

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** Идентификатор трека: «123» или «123:456» (трек:альбом) → «123»; иначе null. */
export function normalizeTrackId(id) {
  const m = /^(\d{1,20})(?::\d{1,20})?$/.exec(String(id ?? ''));
  return m ? m[1] : null;
}

/** Длительность трека в мс: durationMs, либо duration из трека/прогресса (секунды). */
export function durationOf(snapshot) {
  const track = snapshot?.track;
  if (finite(track?.durationMs) && track.durationMs > 0) return Math.round(track.durationMs);
  const seconds = [track?.duration, snapshot?.duration, snapshot?.progress?.duration].find(v => finite(v) && v > 0);
  return seconds ? Math.round(seconds * 1000) : 0;
}

/**
 * Позиция в мс. Если прогресс сам несёт duration, масштаб берём из отношения длительности трека к ней
 * (секунды дадут ×1000, миллисекунды ×1). Иначе — эвристика: значение заметно больше длительности в секундах — это мс.
 */
export function positionOf(snapshot, durationMs) {
  const progress = snapshot?.progress;
  const raw = finite(progress) ? progress : progress?.position;
  if (!finite(raw) || raw < 0) return 0;
  let scale;
  if (finite(progress?.duration) && progress.duration > 0 && durationMs > 0) scale = durationMs / progress.duration;
  else scale = durationMs > 0 && raw > (durationMs / 1000) * 2 ? 1 : 1000;
  const ms = Math.round(raw * scale);
  return durationMs > 0 ? Math.min(ms, durationMs) : ms;
}

/** Тело для POST /nowplaying или null, если у снимка нет пригодного трека (тогда шлём «ничего не играет»). */
export function toNowPlaying(snapshot) {
  const track = snapshot?.track;
  const trackId = normalizeTrackId(track?.id);
  if (!trackId) return null;
  const durationMs = durationOf(snapshot);
  const artists = Array.isArray(track.artists) ? track.artists.map(a => String(a?.name ?? '')).filter(Boolean) : [];
  const title = [track.title, track.version].filter(v => typeof v === 'string' && v).join(' ');
  return {
    trackId,
    title,
    artists,
    cover: typeof track.coverUri === 'string' ? track.coverUri : '',
    durationMs,
    positionMs: positionOf(snapshot, durationMs),
    playing: snapshot.isPlaying === true,
  };
}

/**
 * Рассылает состояние: сразу при смене трека/паузы/перемотки и раз в heartbeatMs в остальное время.
 * Ошибки сети не накапливаются: виджет сам покажет «ничего не играет», пока аддон не достучится.
 */
export function createNowPlayingPublisher({ client, player, now = Date.now, heartbeatMs = HEARTBEAT_MS, log = {} }) {
  const logger = { warn() {}, ...log };
  let last = null; // {key, positionMs, playing, at}
  let inflight = false;
  let stopped = false;
  let failing = false;
  let warnedUnusable = false;
  let retryAt = 0; // после сбоя не пытаемся чаще раза в heartbeatMs

  const expected = at => (last.playing ? last.positionMs + (at - last.at) : last.positionMs);

  async function push(body, key, at) {
    inflight = true;
    try {
      await client.nowPlaying(body ?? { trackId: '' });
      last = { key, positionMs: body?.positionMs ?? 0, playing: body?.playing === true, at };
      failing = false;
      retryAt = 0;
    } catch (error) {
      if (!failing) logger.warn('Не удалось отправить состояние плеера в OC', error instanceof Error ? error.message : error);
      failing = true;
      retryAt = at + heartbeatMs;
    } finally {
      inflight = false;
    }
  }

  /** Вызывать на каждое изменение плеера и по таймеру (heartbeat): сама решит, нужно ли слать. */
  async function update(snapshot) {
    if (stopped || inflight) return;
    if (snapshot === undefined) {
      try { snapshot = player.playerSnapshot(); } catch (error) {
        logger.warn('Не удалось прочитать состояние плеера', error instanceof Error ? error.message : error);
        return;
      }
    }
    const body = toNowPlaying(snapshot);
    if (!body && snapshot?.track && !warnedUnusable) {
      warnedUnusable = true;
      logger.warn('Трек плеера без пригодного id: виджет увидит «ничего не играет»', typeof player.diagnostics === 'function' ? player.diagnostics() : undefined);
    }
    if (body) warnedUnusable = false;
    const key = body ? body.trackId : '';
    const at = now();
    if (at < retryAt) return;
    const changed = !last || last.key !== key || (body ? body.playing !== last.playing : false)
      || (body ? Math.abs(body.positionMs - expected(at)) > SEEK_TOLERANCE_MS : false);
    if (changed || at - last.at >= heartbeatMs) await push(body, key, at);
  }

  return { update, stop() { stopped = true; } };
}
