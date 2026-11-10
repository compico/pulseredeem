// Тонкий адаптер над api.client PulseSync: проверяет, что нужные методы есть, и прячет их от логики очереди.

export function createPlayer(client) {
  if (typeof client?.addTrackToQueueById !== 'function') throw new Error('PulseSync не предоставляет API добавления трека в очередь');
  if (typeof client?.getQueueSnapshot !== 'function') throw new Error('PulseSync не предоставляет API чтения очереди');
  const ACTIVE = new Set(['playing', 'paused', 'buffering']);
  return {
    snapshot: () => client.getQueueSnapshot(),
    /**
     * Можно ли вставлять трек в очередь. PulseSync/Яндекс Музыка при вставке без активного контекста воспроизведения
     * (плеер только запустился, ничего не загружено) падают с NoCurrentContextExceptions в injectNext, и ошибка уходит
     * в error boundary интерфейса. Поймать её из аддона нельзя (она происходит позже, внутри плеера), поэтому вставляем,
     * только когда есть текущий трек в очереди и плеер реально его держит (играет, на паузе или буферизуется).
     */
    canInsert: () => {
      try {
        const queue = client.getQueueSnapshot();
        const index = queue?.currentIndex;
        if (!Number.isInteger(index) || index < 0 || !Array.isArray(queue?.items) || !queue.items[index]) return false;
        if (typeof client.getPlayerSnapshot === 'function') {
          const state = client.getPlayerSnapshot();
          if (!state?.track) return false;
          if (!ACTIVE.has(state.status) && state.isPlaying !== true) return false;
        }
        return true;
      } catch {
        return false;
      }
    },
    // Состояние плеера нужно только виджету; без этих методов заявки работают как раньше.
    hasPlayerState: typeof client.getPlayerSnapshot === 'function',
    playerSnapshot: () => client.getPlayerSnapshot(),
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
