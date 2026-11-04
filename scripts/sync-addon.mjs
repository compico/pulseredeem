import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import addonConfig from '../addon.config.mjs'

function defaultAddonsDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PulseSync', 'addons')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'PulseSync', 'addons')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'PulseSync', 'addons')
}

export async function syncAddon(sourceDir = process.env.PULSESYNC_ADDON_OUT_DIR || path.resolve('dist', addonConfig.directoryName)) {
  const metadataPath = path.join(sourceDir, 'metadata.json')
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
  if (metadata.type !== 'web-addon' || metadata.id !== addonConfig.id) throw new Error('Build output is not the expected PulseRedeem web addon')
  const root = path.resolve(process.env.PULSESYNC_ADDONS_DIR || defaultAddonsDir())
  const target = path.join(root, addonConfig.directoryName)
  const settingsFile = 'pulsesync.settings.json'
  await fs.mkdir(root, { recursive: true })
  try {
    const installed = JSON.parse(await fs.readFile(path.join(target, 'metadata.json'), 'utf8'))
    if (installed.installSource === 'store' && process.env.PULSESYNC_ALLOW_STORE_ADDON_OVERWRITE !== '1') {
      throw new Error('Refusing to overwrite a store-managed addon. Choose another directoryName or explicitly set PULSESYNC_ALLOW_STORE_ADDON_OVERWRITE=1.')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const staging = path.join(root, `.pulseredeem-staging-${process.pid}`)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.cp(sourceDir, staging, { recursive: true, force: true })
  try {
    await fs.copyFile(path.join(target, settingsFile), path.join(staging, settingsFile))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await fs.rm(target, { recursive: true, force: true })
  await fs.rename(staging, target)
  let reload = 'not-available'
  try {
    const response = await fetch('http://127.0.0.1:2007/dev/addons/reload?directory=' + encodeURIComponent(addonConfig.directoryName), {
      method: 'POST',
      headers: { 'X-PulseSync-Addon-Dev': '1' },
      signal: AbortSignal.timeout(2000),
    })
    reload = response.ok ? 'requested' : 'unsupported'
  } catch {}
  console.log(`PulseRedeem installed to ${target} (client reload: ${reload})`)
  return target
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\\\', '/')}`) {
  syncAddon().catch(error => { console.error(error); process.exitCode = 1 })
}
