import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

const SETTINGS_FILENAME = 'pulsesync.settings.json'
const CLIENT_RELOAD_URL = process.env.PULSESYNC_CLIENT_URL || 'http://127.0.0.1:2007'
const CLIENT_RELOAD_HEADER = 'X-PulseSync-Addon-Dev'

function getAddonsDir() {
  if (process.env.PULSESYNC_ADDONS_DIR) return process.env.PULSESYNC_ADDONS_DIR
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PulseSync', 'addons')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'PulseSync', 'addons')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'PulseSync', 'addons')
}

async function exists(file) {
  try { await fs.access(file); return true } catch { return false }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

function safeBuildFile(sourceDir, fileName) {
  const resolved = path.resolve(sourceDir, fileName)
  const relative = path.relative(sourceDir, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Built addon file points outside build directory: ${fileName}`)
  }
  return resolved
}

async function ensureMetadata(sourceDir, config) {
  const file = path.join(sourceDir, 'metadata.json')
  if (await exists(file)) return readJson(file)

  // SDK 0.18.0 emits the bundle, but in this project configuration it does not
  // emit metadata.json. Use the official WebHost manifest shape (not legacy "script").
  const metadata = {
    id: config.id,
    directoryName: config.directoryName,
    name: config.name,
    version: config.version,
    author: config.author,
    description: config.description,
    type: 'web-addon',
    script: 'script.js',
    ...(await exists(path.join(sourceDir, 'script.css')) ? { css: 'script.css' } : {}),
    tags: config.tags || [],
    allowedUrls: config.allowedUrls || [],
    supportedVersions: config.supportedVersions || [],
    ...(config.requirements ? { requirements: config.requirements } : {}),
  }
  await fs.writeFile(file, JSON.stringify(metadata, null, 2) + '\n', 'utf8')
  return metadata
}

async function validateBuild(sourceDir, config) {
  const metadata = await ensureMetadata(sourceDir, config)
  if (metadata.type !== 'web-addon') {
    throw new Error(`Expected WebHost addon type "web-addon", received "${String(metadata.type)}"`)
  }
  if (String(metadata.id || '').trim() !== String(config.id || '').trim()) {
    throw new Error(`Built addon id does not match addon.config.mjs: ${String(metadata.id || '<empty>')}`)
  }
  if (typeof metadata.script !== 'string' || !metadata.script.trim()) {
    throw new Error('WebHost metadata does not declare a script file')
  }
  for (const name of [metadata.script, metadata.css].filter(Boolean)) {
    if (!(await exists(safeBuildFile(sourceDir, name)))) throw new Error(`Built addon file is missing: ${name}`)
  }
  return metadata
}

async function notifyClient(directoryName) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2000)
  try {
    const url = new URL('/dev/addons/reload', CLIENT_RELOAD_URL)
    url.searchParams.set('directory', directoryName)
    const response = await fetch(url, {
      method: 'POST',
      headers: { [CLIENT_RELOAD_HEADER]: '1' },
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload?.ok !== true) {
      return { status: response.status === 404 ? 'unsupported' : 'rejected', reason: String(payload?.error || `HTTP ${response.status}`) }
    }
    return { status: 'acknowledged', enabled: payload.enabled === true, recipients: Number(payload.recipients) || 0 }
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

export function formatDeliveryResult(result) {
  const client = result.client
  if (client.status === 'acknowledged') {
    return client.recipients > 0
      ? `PulseRedeem установлен; PulseSync подтвердил перезагрузку (${client.recipients} получателей).`
      : 'PulseRedeem установлен. Перезапусти Яндекс Музыку с модом PulseSync, чтобы загрузить аддон.'
  }
  if (client.status === 'unsupported') return 'PulseRedeem скопирован. Эта версия PulseSync не поддерживает dev-перезагрузку; перезапусти Яндекс Музыку.'
  if (client.status === 'rejected') return `PulseSync отклонил dev-перезагрузку: ${client.reason}`
  return `PulseRedeem скопирован, но PulseSync не ответил на запрос перезагрузки: ${client.reason}`
}

export async function deliverAddon(sourceDir, config) {
  const directoryName = String(config.directoryName || '').trim()
  if (!directoryName || directoryName === '.' || directoryName === '..' || path.basename(directoryName) !== directoryName) {
    throw new Error(`Invalid addon directoryName: ${directoryName || '<empty>'}`)
  }

  const resolvedSource = path.resolve(sourceDir)
  const targetRoot = path.resolve(getAddonsDir())
  const target = path.join(targetRoot, directoryName)
  if (resolvedSource === target || path.relative(target, resolvedSource).startsWith('..' + path.sep)) {
    throw new Error('Build output must be outside the installed PulseSync addons directory.')
  }

  const metadata = await validateBuild(resolvedSource, config)
  await fs.mkdir(targetRoot, { recursive: true })
  if (await exists(path.join(target, 'metadata.json'))) {
    const installed = await readJson(path.join(target, 'metadata.json'))
    if (installed.installSource === 'store' && process.env.PULSESYNC_ALLOW_STORE_ADDON_OVERWRITE !== '1') {
      throw new Error('Refusing to overwrite a store-managed addon.')
    }
  }

  const staging = path.join(targetRoot, `.pulseredeem-staging-${process.pid}`)
  const backup = target + '.previous'
  await fs.rm(staging, { recursive: true, force: true })
  await fs.cp(resolvedSource, staging, { recursive: true, force: true })
  try {
    await fs.copyFile(path.join(target, SETTINGS_FILENAME), path.join(staging, SETTINGS_FILENAME))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  await fs.rm(backup, { recursive: true, force: true })
  let moved = false
  try {
    await fs.rename(target, backup)
    moved = true
  } catch (error) {
    if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error
  }
  try {
    if (moved) {
      await fs.rename(staging, target)
      await fs.rm(backup, { recursive: true, force: true })
    } else {
      await fs.mkdir(target, { recursive: true })
      await fs.cp(staging, target, { recursive: true, force: true })
      await fs.rm(staging, { recursive: true, force: true })
    }
  } catch (error) {
    if (moved) {
      try { await fs.rename(backup, target) } catch {}
    }
    throw error
  }

  return { target, name: metadata.name || directoryName, client: await notifyClient(directoryName) }
}
