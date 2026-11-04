import { defineAddon } from '@pulsesync/addon-sdk'
import addonConfig from '../addon.config.mjs'
import { settings } from './settings'
import { parseYandexTrackUrl } from './yandex-url.js'

const TWITCH_ID = 'https://id.twitch.tv'
const TWITCH_API = 'https://api.twitch.tv/helix'
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws'
const REQUIRED_SCOPE = 'channel:read:redemptions'
const AUTH_KEY = 'twitchAuth'
const SEEN_KEY = 'seenRedemptions'

type TwitchToken = {
  accessToken: string
  refreshToken: string
  clientId: string
}

type Runtime = {
  api: any
  socket: WebSocket | null
  stopped: boolean
  reconnectTimer: (() => void) | null
  pendingRedemptions: Set<string>
  seenRedemptions: Set<string>
}

let activeRuntime: Runtime | null = null

async function postForm(api: any, url: string, values: Record<string, string>) {
  const body = new URLSearchParams(values).toString()
  const response = await api.net.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    timeoutMs: 15000,
    signal: api.signal,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = (data as any)?.message || ('HTTP ' + response.status)
    throw new Error(String(message))
  }
  return data as Record<string, any>
}

async function authorizeWithDeviceCode(api: any, clientId: string): Promise<TwitchToken> {
  const device = await postForm(api, TWITCH_ID + '/oauth2/device', {
    client_id: clientId,
    scopes: REQUIRED_SCOPE,
  })

  const verificationUrl = String(device.verification_uri_complete || device.verification_uri || 'https://www.twitch.tv/activate')
  await api.notifications.info(
    'Введи код ' + String(device.user_code) + ' на странице активации Twitch. PulseRedeem дождётся подтверждения.',
    { durationMs: 120000, link: { label: 'Открыть Twitch', href: verificationUrl } },
  )

  let intervalMs = Math.max(1000, Number(device.interval || 5) * 1000)
  const deadline = Date.now() + Number(device.expires_in || 1800) * 1000

  while (!api.signal.aborted && Date.now() < deadline) {
    await new Promise(resolve => api.setTimeout(resolve, intervalMs))
    if (api.signal.aborted) throw new Error('Authorization cancelled')

    const response = await api.net.fetch(TWITCH_ID + '/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: String(device.device_code),
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      timeoutMs: 15000,
      signal: api.signal,
    })
    const data = await response.json().catch(() => ({})) as Record<string, any>

    if (response.ok && data.access_token && data.refresh_token) {
      const token = {
        accessToken: String(data.access_token),
        refreshToken: String(data.refresh_token),
        clientId,
      }
      await api.storage.set(AUTH_KEY, token)
      return token
    }

    const reason = String(data.message || '')
    if (reason === 'authorization_pending') continue
    if (reason === 'slow_down') {
      intervalMs += 5000
      continue
    }
    if (reason === 'access_denied') throw new Error('Вход в Twitch отменён')
    if (reason === 'expired_token') throw new Error('Код активации Twitch истёк. Нажми «Подключить Twitch» ещё раз.')
    throw new Error(reason || ('Twitch OAuth вернул HTTP ' + response.status))
  }

  throw new Error('Время ожидания подтверждения Twitch истекло')
}

async function refreshToken(api: any, token: TwitchToken): Promise<TwitchToken> {
  const data = await postForm(api, TWITCH_ID + '/oauth2/token', {
    client_id: token.clientId,
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
  })
  if (!data.access_token || !data.refresh_token) throw new Error('Twitch не вернул обновлённые токены')
  const updated = {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token),
    clientId: token.clientId,
  }
  // Device-flow refresh tokens are single-use: persist the rotated value immediately.
  await api.storage.set(AUTH_KEY, updated)
  return updated
}

async function validateToken(api: any, token: TwitchToken): Promise<{ token: TwitchToken; userId: string }> {
  let current = token
  let response = await api.net.fetch(TWITCH_ID + '/oauth2/validate', {
    headers: { authorization: 'OAuth ' + current.accessToken },
    timeoutMs: 15000,
    signal: api.signal,
  })

  if (response.status === 401) {
    current = await refreshToken(api, current)
    response = await api.net.fetch(TWITCH_ID + '/oauth2/validate', {
      headers: { authorization: 'OAuth ' + current.accessToken },
      timeoutMs: 15000,
      signal: api.signal,
    })
  }

  if (!response.ok) throw new Error('Не удалось проверить Twitch-токен: HTTP ' + response.status)
  const data = await response.json() as Record<string, any>
  if (data.client_id !== current.clientId) throw new Error('Twitch Client ID не совпадает с настройками аддона')
  if (!Array.isArray(data.scopes) || !data.scopes.includes(REQUIRED_SCOPE)) {
    throw new Error('У Twitch-токена нет разрешения ' + REQUIRED_SCOPE + '. Переподключи Twitch.')
  }

  // Use Twitch's reported remaining lifetime rather than assuming a fixed token TTL.
  if (Number(data.expires_in) <= 3600) current = await refreshToken(api, current)
  return { token: current, userId: String(data.user_id) }
}

async function subscribeToRedemptions(api: any, token: TwitchToken, broadcasterId: string, sessionId: string) {
  const response = await api.net.fetch(TWITCH_API + '/eventsub/subscriptions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token.accessToken,
      'client-id': token.clientId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      type: 'channel.channel_points_custom_reward_redemption.add',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId },
      transport: { method: 'websocket', session_id: sessionId },
    }),
    timeoutMs: 15000,
    signal: api.signal,
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as Record<string, any>
    throw new Error('Не удалось подписаться на Twitch EventSub: ' + String(data.message || response.status))
  }
  api.logger.info('Subscribed to Twitch Channel Points redemptions')
}

async function handleRedemption(api: any, runtime: Runtime, event: Record<string, any>) {
  const redemptionId = String(event.id || '')
  if (!redemptionId || runtime.seenRedemptions.has(redemptionId) || runtime.pendingRedemptions.has(redemptionId)) return

  const rewardId = String(event.reward?.id || '')
  const configuredRewardId = String(api.settings.getCurrent().rewardId || '').trim()
  if (configuredRewardId && rewardId !== configuredRewardId) return

  const parsed = parseYandexTrackUrl(String(event.user_input || ''))
  if (!parsed) {
    await api.notifications.error('Заявка от ' + String(event.user_name || 'зрителя') + ': нужна ссылка на трек Яндекс Музыки.')
    return
  }

  runtime.pendingRedemptions.add(redemptionId)
  try {
    await api.client.addTrackToQueueById(parsed.trackId, {
      albumId: parsed.albumId,
      position: 'last',
    })

    runtime.seenRedemptions.add(redemptionId)
    const saved = await api.storage.get<string[]>(SEEN_KEY) || []
    const next = [...saved.filter(id => id !== redemptionId), redemptionId].slice(-2000)
    await api.storage.set(SEEN_KEY, next)

    await api.notifications.info(
      'Трек добавлен в очередь PulseSync по заявке ' + String(event.user_name || 'зрителя') + '.',
      { durationMs: 7000 },
    )
    api.logger.info('Added redeemed Yandex Music track', { trackId: parsed.trackId, redemptionId })
  } catch (error) {
    await api.notifications.error('Не удалось добавить трек из заявки Twitch: ' + (error instanceof Error ? error.message : String(error)))
    api.logger.error('Failed to append redeemed track', error)
  } finally {
    runtime.pendingRedemptions.delete(redemptionId)
  }
}

function attachSocket(api: any, runtime: Runtime, socket: WebSocket, token: TwitchToken, broadcasterId: string, subscribeOnWelcome: boolean) {
  socket.onmessage = event => {
    void (async () => {
      let message: any
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }

      const type = message.metadata?.message_type
      if (type === 'session_welcome') {
        const sessionId = message.payload?.session?.id
        if (subscribeOnWelcome && sessionId) {
          try {
            await subscribeToRedemptions(api, token, broadcasterId, String(sessionId))
            await api.notifications.info('PulseRedeem подключён к Twitch Channel Points.')
          } catch (error) {
            api.logger.error('EventSub subscription failed', error)
            await api.notifications.error('Не удалось включить события Channel Points: ' + (error instanceof Error ? error.message : String(error)))
          }
        }
        return
      }

      if (type === 'session_reconnect') {
        const reconnectUrl = message.payload?.session?.reconnect_url
        if (reconnectUrl && !runtime.stopped) {
          const previous = runtime.socket
          const next = new WebSocket(String(reconnectUrl))
          runtime.socket = next
          next.onopen = () => previous?.close()
          attachSocket(api, runtime, next, token, broadcasterId, false)
        }
        return
      }

      if (type === 'notification' && message.payload?.subscription?.type === 'channel.channel_points_custom_reward_redemption.add') {
        await handleRedemption(api, runtime, message.payload.event || {})
      }

      if (type === 'revocation') {
        api.logger.warn('Twitch revoked the EventSub subscription', message.payload)
        await api.notifications.error('Twitch отключил подписку PulseRedeem. Переподключи Twitch.')
      }
    })().catch(error => api.logger.error('Could not process Twitch EventSub message', error))
  }

  socket.onerror = error => api.logger.error('Twitch EventSub WebSocket error', error)
  socket.onclose = () => {
    if (runtime.stopped || api.signal.aborted) return
    runtime.reconnectTimer?.()
    runtime.reconnectTimer = api.setTimeout(() => {
      void connectEventSub(api, runtime).catch(error => api.logger.error('Twitch EventSub reconnect failed', error))
    }, 5000)
  }
}

async function connectEventSub(api: any, runtime: Runtime) {
  const stored = await api.storage.get<TwitchToken>(AUTH_KEY)
  if (!stored?.accessToken || runtime.stopped) return
  const validated = await validateToken(api, stored)
  const socket = new WebSocket(EVENTSUB_URL)
  runtime.socket = socket
  attachSocket(api, runtime, socket, validated.token, validated.userId, true)
}

async function startSession(api: any, runtime: Runtime) {
  const stored = await api.storage.get<TwitchToken>(AUTH_KEY)
  if (!stored?.accessToken) return
  try {
    const validated = await validateToken(api, stored)
    await connectEventSub(api, runtime)
    api.setInterval(() => {
      void (async () => {
        const latest = await api.storage.get<TwitchToken>(AUTH_KEY)
        if (latest?.accessToken) await validateToken(api, latest)
      })().catch(async error => {
        api.logger.error('Periodic Twitch token validation failed', error)
        await api.notifications.error('Проверка Twitch не прошла. Возможно, нужно переподключить аккаунт.')
      })
    }, 60 * 60 * 1000)
    api.logger.info('PulseRedeem Twitch integration started', { broadcasterId: validated.userId })
  } catch (error) {
    api.logger.error('Could not start Twitch integration', error)
    await api.notifications.error('Не удалось подключить Twitch: ' + (error instanceof Error ? error.message : String(error)))
  }
}

async function connectTwitch(api: any) {
  const clientId = String(api.settings.getCurrent().clientId || '').trim()
  if (!clientId) {
    await api.notifications.error('Сначала укажи Twitch Client ID в настройках PulseRedeem.')
    return
  }

  try {
    const token = await authorizeWithDeviceCode(api, clientId)
    await validateToken(api, token)
    if (activeRuntime) {
      activeRuntime.socket?.close()
      activeRuntime.socket = null
      await connectEventSub(api, activeRuntime)
    }
  } catch (error) {
    api.logger.error('Twitch authorization failed', error)
    await api.notifications.error('Не удалось подключить Twitch: ' + (error instanceof Error ? error.message : String(error)))
  }
}

async function disconnectTwitch(api: any) {
  if (activeRuntime) {
    activeRuntime.socket?.close()
    activeRuntime.socket = null
  }
  await api.storage.remove(AUTH_KEY)
  await api.notifications.info('Токен Twitch удалён из PulseRedeem.')
}

export default defineAddon({
  id: addonConfig.id,
  name: addonConfig.name,
  settings,
  playerBarButtons: [
    {
      id: 'pulseredeem-connect-twitch',
      label: 'Подключить Twitch',
      description: 'Авторизовать Twitch и слушать Channel Points',
      icon: 'gift',
      onClick: ({ api }) => connectTwitch(api),
    },
    {
      id: 'pulseredeem-disconnect-twitch',
      label: 'Отключить Twitch',
      description: 'Удалить сохранённый токен Twitch',
      icon: 'close',
      onClick: ({ api }) => disconnectTwitch(api),
    },
  ],
  start(api) {
    const seen = new Set<string>()
    activeRuntime = {
      api,
      socket: null,
      stopped: false,
      reconnectTimer: null,
      pendingRedemptions: new Set(),
      seenRedemptions: seen,
    }

    void (async () => {
      const saved = await api.storage.get<string[]>(SEEN_KEY) || []
      saved.forEach(id => seen.add(id))
      await startSession(api, activeRuntime!)
    })()

    return () => {
      if (!activeRuntime) return
      activeRuntime.stopped = true
      activeRuntime.reconnectTimer?.()
      activeRuntime.socket?.close()
      activeRuntime = null
    }
  },
})
