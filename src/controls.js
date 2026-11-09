// Исполнение команд пульта (пауза, пропуск…). Плагин OC держит короткую очередь команд, аддон забирает их раз в секунду.
// Команда подтверждается в OC ДО исполнения: исполнится не более одного раза (двойной пропуск хуже потерянного).

export function createController({ client, player, notify = () => {}, log = {} }) {
  const logger = { warn() {}, error() {}, ...log };
  let stopped = false;
  let busy = false;
  let failing = false;

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      let commands;
      try {
        commands = await client.commands();
        failing = false;
      } catch (error) {
        if (!failing) logger.warn('Не удалось получить команды из OC', error instanceof Error ? error.message : error);
        failing = true;
        return;
      }
      for (const command of commands) {
        if (stopped) return;
        try { await client.commandDone(command.id); } catch { continue; } // не приняли — не исполняем, повторим на следующем опросе
        try {
          await player.control(command.action);
          notify({ type: 'command', action: command.action });
        } catch (error) {
          logger.error('Команда не выполнена', { action: command.action, error: error instanceof Error ? error.message : String(error) });
          notify({ type: 'command-failed', action: command.action, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      busy = false;
    }
  }

  return { tick, stop() { stopped = true; } };
}
