import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { syncAddon } from './sync-addon.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, '.pulsesync-dev', 'pulseredeem')
process.env.PULSESYNC_ADDON_OUT_DIR = outDir

console.log('PulseRedeem addon dev mode: build changes are copied into PulseSync. Ctrl+C to stop.')
const watcher = await build({
  configFile: path.join(root, 'vite.config.ts'),
  mode: 'development',
  build: { watch: {} },
})
let syncing = false
watcher.on('event', event => {
  if (event.code !== 'END' || syncing) return
  syncing = true
  syncAddon(outDir).catch(error => console.error('Addon delivery failed:', error)).finally(() => { syncing = false })
})
process.once('SIGINT', () => watcher.close().then(() => process.exit(0)))
process.once('SIGTERM', () => watcher.close().then(() => process.exit(0)))
