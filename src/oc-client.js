// Клиент маршрутов wasm-плагина «music» в Overlay Composer.
// Не зависит от PulseSync: HTTP-функция передаётся снаружи (api.net.fetch), поэтому модуль тестируется в обычном node.

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
export const API_PATH = '/plugins/music/api';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
// Для этих кодов повтор бессмысленен: заявка не принята как есть, и результат не изменится.
const FINAL_STATUSES = new Set([400, 404, 409]);

export class OcError extends Error {
  constructor(message, { status = 0, retryable = true } = {}) {
    super(message);
    this.name = 'OcError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Только http на loopback без логина/пароля: аддон не должен слать заявки куда-то ещё. */
export function normalizeBaseUrl(input) {
  try {
    const url = new URL(String(input).trim());
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

/**
 * Приводит заявку из ответа /next к виду {id, trackId, albumId, user} или {id, invalid}.
 * Заявку с корректным id, но негодным треком не выбрасываем: её нужно отклонить через /failed,
 * иначе она будет приходить снова и блокировать очередь.
 */
export function parseItem(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || !Number.isSafeInteger(raw.id) || raw.id <= 0) {
    throw new OcError('OC вернул заявку без корректного id', { retryable: true });
  }
  const trackId = typeof raw.trackId === 'string' ? raw.trackId : '';
  if (!/^\d{1,20}$/.test(trackId)) return { id: raw.id, user: String(raw.user || ''), invalid: 'в заявке нет корректного trackId' };
  const albumId = typeof raw.albumId === 'string' && /^\d{1,20}$/.test(raw.albumId) ? raw.albumId : undefined;
  return { id: raw.id, trackId, albumId, user: String(raw.user || '') };
}

export function createOcClient({ fetch, baseUrl = DEFAULT_BASE_URL, timeoutMs = 10000, signal }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('Адрес OC должен быть http://127.0.0.1 или http://localhost');
  if (typeof fetch !== 'function') throw new Error('fetch is required');

  async function request(method, path, body) {
    let response;
    try {
      response = await fetch(base + API_PATH + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
        signal,
      });
    } catch (error) {
      throw new OcError('OC недоступен: ' + (error instanceof Error ? error.message : String(error)));
    }
    if (!response.ok) {
      throw new OcError('OC ответил HTTP ' + response.status, { status: response.status, retryable: !FINAL_STATUSES.has(response.status) });
    }
    try {
      return await response.json();
    } catch {
      throw new OcError('OC вернул не JSON', { status: response.status });
    }
  }

  return {
    /** → {item|null, resend} */
    async next() {
      const data = await request('GET', '/next');
      if (!data || typeof data !== 'object') throw new OcError('OC вернул неожиданный ответ');
      return { item: parseItem(data.item), resend: data.resend === true };
    },
    async started(id) { await request('POST', '/started', { id }); },
    /** Состояние плеера для виджета. Пустой объект/без trackId — «ничего не играет». */
    async nowPlaying(state) { await request('POST', '/nowplaying', state); },
    async failed(id, reason) { await request('POST', '/failed', { id, reason: String(reason || '').slice(0, 200) }); },
  };
}
