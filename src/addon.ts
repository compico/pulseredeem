import { defineAddon } from '@pulsesync/addon-sdk'
import addonConfig from '../addon.config.mjs'

const BRIDGE_URL = 'http://127.0.0.1:3037'
let polling = false

async function processNext(api) {
  if (polling || api.signal.aborted) return
  polling = true
  let claimedId
  try {
    const response = await api.net.fetch(`${BRIDGE_URL}/api/bridge/next`, {
      method: 'GET',
      signal: api.signal,
      timeoutMs: 5000,
    })
    if (response.status === 204) return
    if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`)
    const payload = await response.json()
    const item = payload.item
    if (!item?.id || !item?.trackId) return
    claimedId = item.id

    await api.client.addTrackToQueueById(item.trackId, {
      albumId: item.albumId,
      position: 'last',
    })

    const completed = await api.net.fetch(`${BRIDGE_URL}/api/bridge/${encodeURIComponent(item.id)}/complete`, {
      method: 'POST',
      signal: api.signal,
      timeoutMs: 5000,
    })
    if (!completed.ok) throw new Error(`Could not acknowledge request: HTTP ${completed.status}`)
    api.logger.info('Track appended to Yandex Music queue', { trackId: item.trackId, requestId: item.id })
  } catch (error) {
    if (claimedId && !api.signal.aborted) {
      try {
        await api.net.fetch(`${BRIDGE_URL}/api/bridge/${encodeURIComponent(claimedId)}/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: error instanceof Error ? error.message : String(error) }),
          signal: api.signal,
          timeoutMs: 5000,
        })
      } catch (retryError) {
        api.logger.error('Could not return failed request to queue', retryError)
      }
    }
    if (!api.signal.aborted) api.logger.error('PulseRedeem queue delivery failed', error)
  } finally {
    polling = false
  }
}

export default defineAddon({
  id: addonConfig.id,
  name: addonConfig.name,
  start(api) {
    void processNext(api)
    api.setInterval(() => void processNext(api), 2500)
    api.logger.info('PulseRedeem bridge started; polling local queue')
  },
})
