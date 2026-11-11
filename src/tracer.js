// Журнал смены треков: для разбора «почему трек пропустился». Ничего не решает и не меняет, только пишет в лог (api.logger).
// На каждую смену трека: что играло (позиция/длительность), что заиграло, чем вызвана смена, что стоит в очереди дальше,
// чьи это заявки. Причина определяется так:
//   доигран                  — позиция дошла почти до конца (обычный переход);
//   команда <action> #<id>   — аддон сам выполнил команду пульта в последние несколько секунд;
//   не от аддона             — смену сделал пользователь в плеере или сам плеер (недоступный трек, ошибка загрузки, конец очереди).
// Команды пульта пишутся отдельной строкой в момент исполнения, до смены трека.

import { durationOf, normalizeTrackId, positionOf } from './nowplaying.js';

export const COMMAND_WINDOW_MS = 6000; // смену трека после нашей команды skip считаем её следствием
export const END_TOLERANCE_MS = 5000;
const SHORT_PLAY_MS = 3000; // трек оборвался почти сразу после старта: подозрительно (не загрузился?)

const sec = ms => Math.round(ms / 100) / 10;

function brief(t) {
  return t && { id: t.id, title: t.title, position: sec(t.positionMs) + ' с', duration: sec(t.durationMs) + ' с', playing: t.playing };
}

export function summarizeQueue(q, ahead = 6) {
  if (!q || !Array.isArray(q.items)) return null;
  const i = Number.isInteger(q.currentIndex) ? q.currentIndex : -1;
  const id = e => String(e?.id ?? '').slice(0, 40);
  return { index: i, length: q.items.length, current: i >= 0 ? id(q.items[i]) : null, ahead: q.items.slice(i + 1, i + 1 + ahead).map(id) };
}

function fromSnapshot(snapshot) {
  const id = normalizeTrackId(snapshot?.track?.id);
  if (!id) return null;
  const durationMs = durationOf(snapshot);
  const t = snapshot.track;
  return {
    id, durationMs, positionMs: positionOf(snapshot, durationMs), playing: snapshot.isPlaying === true,
    title: [t.title, t.version].filter(v => typeof v === 'string' && v).join(' '),
  };
}

export function createTracer({ log = {}, now = Date.now, queue = async () => null, owns = () => null, status = () => ({}) } = {}) {
  const logger = { info() {}, warn() {}, ...log };
  let prev = null; // последний виденный трек
  let lastCommand = null; // {id, action, at}
  let busy = false;

  const safeQueue = async () => { try { return summarizeQueue(await queue()); } catch (e) { return { error: String(e) }; } };

  return {
    /** Аддон сейчас выполнит команду пульта. Вызывать до исполнения. */
    async noteCommand(command) {
      lastCommand = { id: command.id, action: command.action, at: now() };
      if (command.action !== 'skip' && command.action !== 'skip_ban') {
        logger.info('Команда пульта: ' + command.action, { commandId: command.id, current: brief(prev) });
        return;
      }
      logger.warn('Команда пульта: пропуск (' + command.action + ')', {
        commandId: command.id, skipping: brief(prev), ours: prev && owns(prev.id), queue: await safeQueue(), addon: status(),
      });
    },

    /** Снимок плеера (после каждого изменения/по таймеру). Смена трека пишется один раз. */
    async observe(snapshot) {
      const cur = fromSnapshot(snapshot);
      if (!cur) {
        // трек пропал: пишем один раз, когда он был
        if (!prev) return;
      } else if (prev && prev.id === cur.id) {
        prev = cur; // тот же трек: обновляем позицию
        return;
      }
      if (busy) return;
      busy = true;
      try {
        const from = prev;
        prev = cur;
        if (!from) return; // первое наблюдение
        const ended = from.durationMs > 0 && from.durationMs - from.positionMs <= Math.min(END_TOLERANCE_MS, from.durationMs * 0.2);
        const viaCommand = lastCommand && now() - lastCommand.at <= COMMAND_WINDOW_MS && (lastCommand.action === 'skip' || lastCommand.action === 'skip_ban');
        let reason;
        if (ended) reason = 'доигран';
        else if (viaCommand) reason = 'команда ' + lastCommand.action + ' #' + lastCommand.id;
        else if (from.positionMs < SHORT_PLAY_MS) reason = 'не от аддона: трек оборвался через ' + sec(from.positionMs) + ' с после старта (не загрузился или недоступен?)';
        else reason = 'не от аддона (пользователь в плеере или сам плеер)';
        const entry = {
          reason, from: brief(from), to: brief(cur), fromOurs: owns(from.id), toOurs: cur ? owns(cur.id) : null,
          queue: await safeQueue(), addon: status(),
        };
        (ended ? logger.info : logger.warn)('Смена трека: ' + (from.title || from.id) + ' → ' + (cur ? cur.title || cur.id : 'ничего') + ' — ' + reason, entry);
      } finally {
        busy = false;
      }
    },
  };
}
