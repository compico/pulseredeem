import path from 'node:path'
import { fileURLToPath } from 'node:url'
import addonConfig from '../addon.config.mjs'
import { deliverAddon, formatDeliveryResult } from './addon-delivery.mjs'

export async function syncAddon(sourceDir = process.env.PULSESYNC_ADDON_OUT_DIR || path.resolve('dist', addonConfig.directoryName)) {
  const result = await deliverAddon(sourceDir, addonConfig)
  console.log(formatDeliveryResult(result))
  console.log('PulseRedeem installed to ' + result.target)
  return result.target
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncAddon().catch(error => { console.error(error); process.exitCode = 1 })
}
