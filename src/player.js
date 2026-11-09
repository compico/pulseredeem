// Тонкий адаптер над api.client PulseSync: проверяет, что нужные методы есть, и прячет их от логики очереди.

export function createPlayer(client) {
  if (typeof client?.addTrackToQueueById !== 'function') throw new Error('PulseSync не предоставляет API добавления трека в очередь');
  if (typeof client?.getQueueSnapshot !== 'function') throw new Error('PulseSync не предоставляет API чтения очереди');
  return {
    snapshot: () => client.getQueueSnapshot(),
    // Состояние плеера нужно только виджету; без этих методов заявки работают как раньше.
    hasPlayerState: typeof client.getPlayerSnapshot === 'function',
    playerSnapshot: () => client.getPlayerSnapshot(),
    onPlayerChange: listener => (typeof client.onPlayerSnapshotChange === 'function' ? client.onPlayerSnapshotChange(listener) : null),
    // addTrackToQueueById не подтверждает вставку; await нужен на случай, если вернётся промис с ошибкой.
    addNext: async (trackId, albumId) => { await client.addTrackToQueueById(trackId, { albumId, position: 'next' }); },
  };
}
