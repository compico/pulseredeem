import { defineAddon, IconButton } from '@pulsesync/addon-sdk'
import addonConfig from '../addon.config.mjs'
import { createController } from './controls.js'
import { createDispatcher } from './dispatcher.js'
import { createNowPlayingPublisher } from './nowplaying.js'
import { createOcClient, DEFAULT_BASE_URL } from './oc-client.js'
import { createPlayer } from './player.js'

const POLL_MS = 3000
// Раз в секунду: опрос команд пульта, позиция играющей заявки и проверка публикатора состояния (он сам решает, слать ли).
const PUBLISH_CHECK_MS = 1000
const OC_HINT = 'Проверьте, что Overlay Composer запущен, плагин «Заявки на треки» установлен и ему выданы разрешения.'

// JSON без циклов и гигантов: обрезает глубину, длинные строки и массивы, чтобы строку можно было скопировать целиком.
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v
    if (typeof v === 'function') return '[function]'
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    if (depth <= 0) return Array.isArray(v) ? '[array ' + v.length + ']' : '[object]'
    seen.add(v)
    if (Array.isArray(v)) return v.slice(0, 12).map(x => walk(x, depth - 1)).concat(v.length > 12 ? ['…+' + (v.length - 12)] : [])
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v).slice(0, 40)) out[key] = walk((v as Record<string, unknown>)[key], depth - 1)
    return out
  }
  return JSON.stringify(walk(value, 5))
}
function safeTry(fn: () => unknown): unknown {
  try { return fn() } catch (error) { return 'ошибка: ' + (error instanceof Error ? error.message : String(error)) }
}

let showStatus: (() => void) | null = null

function StatusButton() {
  return (
    <IconButton
      icon="gift"
      label="Статус заявок"
      onClick={() => showStatus?.()}
    />
  )
}

export default defineAddon({
  id: addonConfig.id,
  name: addonConfig.name,
  slots: { playerBarButton: StatusButton },
  start(api) {
    const text = (e: unknown) => (e instanceof Error ? e.message : String(e))
    // Контейнеры уведомлений Яндекс Музыки монтируются не сразу: отказ показа не должен становиться необработанной ошибкой аддона.
    const toast = (kind: 'info' | 'error', message: string, options?: { durationMs?: number }) => {
      void Promise.resolve()
        .then(() => (kind === 'info' ? api.notifications.info(message, options) : api.notifications.error(message)))
        .catch(error => api.logger.warn('Уведомление не показано', text(error)))
    }
    let wasDisconnected = false

    let player
    try {
      player = createPlayer(api.client)
    } catch (error) {
      api.logger.error('PulseSync API недоступен', error)
      toast('error', text(error))
      return
    }

    const client = createOcClient({ fetch: api.net.fetch.bind(api.net), baseUrl: DEFAULT_BASE_URL, signal: api.signal })
    const dispatcher = createDispatcher({
      client,
      player,
      trackCompletion: player.hasPlayerState,
      log: api.logger,
      notify: event => {
        if (event.type === 'connection') {
          // «Связь есть» показываем только после обрыва: при обычном старте это шум.
          if (event.connected) {
            if (wasDisconnected) toast('info', 'PulseRedeem: связь с Overlay Composer восстановлена.', { durationMs: 4000 })
            wasDisconnected = false
          } else {
            wasDisconnected = true
            toast('error', 'PulseRedeem: ' + event.error + '. ' + OC_HINT)
          }
        } else if (event.type === 'started') {
          api.logger.info('Заявка запущена', { id: event.item.id })
        } else if (event.type === 'played') {
          api.logger.info('Заявка отыграна, награда выполнена', { id: event.item.id })
        } else if (event.type === 'failed') {
          toast('error', 'Заявка от ' + (event.item.user || 'зрителя') + ' отклонена: ' + event.reason + '. Баллы возвращены.')
        } else if (event.type === 'dropped') {
          toast('error', 'Overlay Composer не принял подтверждение заявки: ' + event.error)
        }
      },
    })

    showStatus = () => {
      const s = dispatcher.status()
      const line = s.connected === false ? 'нет связи с Overlay Composer: ' + s.lastError
        : s.waitingForPlayer ? 'в плеере ничего не загружено: заявки ждут, пока вы запустите трек'
        : s.playingId ? 'играет заявка #' + s.playingId + (s.phase === 'waiting' ? ', следующая ждёт очереди в плеере' : '')
        : s.phase === 'waiting' ? 'заявка #' + s.activeId + ' ждёт своей очереди в плеере'
        : s.connected ? 'связь есть, заявок нет' : 'проверяю связь…'
      toast('info', 'PulseRedeem: ' + line, { durationMs: 6000 })
      // Одна JSON-строка в консоль: ПКМ по ней → Copy string contents. Работает и тогда, когда глобальный объект недоступен.
      api.logger.info('PULSEREDEEM_DUMP ' + debug.dump())
    }

    const unsubscribe = typeof api.client.onQueueChange === 'function'
      ? api.client.onQueueChange((snapshot: unknown) => { void dispatcher.observe(snapshot) })
      : null
    if (!unsubscribe) api.logger.warn('onQueueChange недоступен: старт трека не будет подтверждаться, заявки завершатся по таймауту')

    // Состояние плеера для виджета «Плеер с заявками». Без этого API заявки работают как обычно.
    let publisher: ReturnType<typeof createNowPlayingPublisher> | null = null
    let unsubscribePlayer: (() => void) | null = null
    if (player.hasPlayerState) {
      publisher = createNowPlayingPublisher({ client, player, log: api.logger })
      // Снимок читаем сами: аргумент слушателя в SDK не документирован. Позицию играющей заявки проверяем и по событиям, и по таймеру.
      const onPlayer = () => {
        let snapshot: unknown
        try { snapshot = player.playerSnapshot() } catch { return }
        void publisher?.update(snapshot)
        void dispatcher.observePlayer(snapshot)
      }
      unsubscribePlayer = player.onPlayerChange(onPlayer)
      onPlayer()
      api.setInterval(onPlayer, PUBLISH_CHECK_MS)
    } else {
      api.logger.warn('getPlayerSnapshot недоступен: виджет не увидит текущий трек, а награда выполняется на старте трека, а не по окончании')
    }

    // Команды пульта (пауза, пропуск, пропуск с баном).
    const controller = createController({
      client,
      player,
      log: api.logger,
      notify: event => {
        if (event.type === 'command-failed') toast('error', 'Команда «' + event.action + '» не выполнена: ' + event.error)
      },
    })
    api.setInterval(() => { void controller.tick() }, PUBLISH_CHECK_MS)

    // Отладка из консоли devtools: copy(__pulseredeem.dump()) копирует состояние плеера и очереди одной JSON-строкой.
    const debug = {
      dump: () => safeJson({
        version: addonConfig.version,
        blocker: player.insertBlocker(),
        dispatcher: dispatcher.status(),
        ...player.diagnostics(),
        rawPlayer: safeTry(() => api.client.getPlayerSnapshot()),
        rawQueue: safeTry(() => api.client.getQueueSnapshot()),
      }),
      // Раз в periodMs пишет в лог короткую строку состояния; remember: debug.stop().
      watch: (periodMs = 2000) => {
        debug.stop()
        watchTimer = setInterval(() => api.logger.info('watch', safeJson({ blocker: player.insertBlocker(), ...player.diagnostics(), d: dispatcher.status() })), Math.max(500, periodMs))
        return 'watch started'
      },
      stop: () => { if (watchTimer) clearInterval(watchTimer); watchTimer = null; return 'watch stopped' },
    }
    let watchTimer: ReturnType<typeof setInterval> | null = null
    for (const root of [globalThis, window, window.top].filter(Boolean) as object[]) {
      try { (root as { __pulseredeem?: typeof debug }).__pulseredeem = debug } catch { /* чужой origin */ }
    }

    void dispatcher.tick()
    api.setInterval(() => { void dispatcher.tick() }, POLL_MS)

    return () => {
      debug.stop()
      for (const root of [globalThis, window, window.top].filter(Boolean) as object[]) {
        try { delete (root as { __pulseredeem?: unknown }).__pulseredeem } catch { /* чужой origin */ }
      }
      dispatcher.stop()
      controller.stop()
      publisher?.stop()
      unsubscribe?.()
      unsubscribePlayer?.()
      showStatus = null
    }
  },
})
