// Тонкий адаптер над api.client PulseSync: проверяет, что нужные методы есть, и прячет их от логики очереди.

export function createPlayer(client) {
  if (typeof client?.addTrackToQueueById !== 'function') throw new Error('PulseSync не предоставляет API добавления трека в очередь');
  if (typeof client?.getQueueSnapshot !== 'function') throw new Error('PulseSync не предоставляет API чтения очереди');
  const ACTIVE = new Set(['playing', 'paused', 'buffering']);
  return {
    // Методы api.client в аддоне асинхронные (RPC в основной мир Яндекс Музыки): везде возвращают промисы, их нужно await.
    snapshot: async () => await client.getQueueSnapshot(),
    /**
     * Можно ли вставлять трек в очередь. PulseSync/Яндекс Музыка при вставке без активного контекста воспроизведения
     * (плеер только запустился, ничего не загружено) падают с NoCurrentContextExceptions в injectNext, и ошибка уходит
     * в error boundary интерфейса. Поймать её из аддона нельзя (она происходит позже, внутри плеера), поэтому вставляем,
     * только когда есть текущий трек в очереди и плеер реально его держит (играет, на паузе или буферизуется).
     */
    /** Почему вставлять пока нельзя (строка) или null, если можно. Причина нужна для диагностики. */
    insertBlocker: async () => {
      try {
        const queue = await client.getQueueSnapshot();
        const index = queue?.currentIndex;
        if (!Number.isInteger(index) || index < 0) return 'в очереди нет текущего трека (currentIndex=' + String(index) + ')';
        if (!Array.isArray(queue?.items) || !queue.items[index]) return 'текущий индекс не указывает на элемент очереди';
        if (typeof client.getPlayerSnapshot === 'function') {
          const state = await client.getPlayerSnapshot();
          if (!state?.track) return 'плеер не держит трек (track=null, status=' + String(state?.status) + ')';
          if (!ACTIVE.has(state.status) && state.isPlaying !== true) return 'плеер не активен (status=' + String(state.status) + ')';
        }
        return null;
      } catch (error) {
        return 'ошибка чтения состояния плеера: ' + (error instanceof Error ? error.message : String(error));
      }
    },
    async canInsert() { return (await this.insertBlocker()) === null; },
    /** Короткий безопасный срез состояния для лога: типы и первые id, без названий и обложек. */
    diagnostics: async () => {
      const out = {};
      try {
        const p = typeof client.getPlayerSnapshot === 'function' ? await client.getPlayerSnapshot() : undefined;
        out.player = p === undefined ? 'нет API' : p && {
          status: p.status, isPlaying: p.isPlaying, repeatMode: p.repeatMode, shuffle: p.shuffle,
          track: p.track ? { idType: typeof p.track.id, id: String(p.track.id).slice(0, 40), keys: Object.keys(p.track).slice(0, 20) } : null,
          progressType: p.progress === null ? 'null' : typeof p.progress, duration: p.duration,
        };
      } catch (error) { out.player = 'ошибка: ' + String(error); }
      try {
        const q = await client.getQueueSnapshot();
        out.queue = q && { currentIndex: q.currentIndex, length: Array.isArray(q.items) ? q.items.length : 'не массив',
          ids: Array.isArray(q.items) ? q.items.slice(Math.max(0, (q.currentIndex ?? 0) - 1), (q.currentIndex ?? 0) + 5).map(i => String(i?.id).slice(0, 40)) : [] };
      } catch (error) { out.queue = 'ошибка: ' + String(error); }
      return out;
    },
    // Состояние плеера нужно только виджету; без этих методов заявки работают как раньше.
    hasPlayerState: typeof client.getPlayerSnapshot === 'function',
    playerSnapshot: async () => await client.getPlayerSnapshot(),
    /** Команды пульта. skip и skip_ban для плеера одно и то же: бан записывает плагин. */
    control: async action => {
      const methods = { play: 'play', pause: 'pause', toggle: 'togglePlayPause', skip: 'next', skip_ban: 'next' };
      const name = methods[action];
      if (!name) throw new Error('Неизвестная команда: ' + action);
      if (typeof client[name] !== 'function') throw new Error('PulseSync не поддерживает ' + name);
      await client[name]();
    },
    onPlayerChange: listener => (typeof client.onPlayerSnapshotChange === 'function' ? client.onPlayerSnapshotChange(listener) : null),
    // addTrackToQueueById не подтверждает вставку; await нужен на случай, если вернётся промис с ошибкой.
    addNext: async (trackId, albumId) => { await client.addTrackToQueueById(trackId, { albumId, position: 'next' }); },
  };
}
