// События плагина music по WebSocket (/plugins/music/ws): вместо опроса OC аддон узнаёт об изменениях сразу.
// Модуль не зависит от PulseSync: конструктор WebSocket и таймеры передаются снаружи, поэтому он проверяется обычным node.

export const WS_PATH = '/plugins/music/ws';
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
const PING_MS = 25000;

/** ws://127.0.0.1:8000 из http://127.0.0.1:8000 (адрес уже проверен normalizeBaseUrl). */
export function wsUrl(baseUrl) {
  const u = new URL(baseUrl);
  return (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host + WS_PATH;
}

/**
 * Держит соединение с повторными подключениями (1 с … 30 с). onEvent(topic, data) — событие; onOpen — подписки подтверждены
 * (самое время один раз прочитать состояние обычным GET: события, пришедшие пока связи не было, потеряны);
 * onClose — связь потеряна. isOpen() — есть ли сейчас канал событий.
 */
export function createOcEvents({ WebSocketImpl = globalThis.WebSocket, url, topics, onEvent, onOpen = () => {}, onClose = () => {}, log = {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  const logger = { info() {}, warn() {}, ...log };
  let ws = null;
  let stopped = false;
  let open = false;
  let retry = MIN_RETRY_MS;
  let retryTimer = null;
  let pingTimer = null;
  let pending = new Set();

  const send = obj => { try { ws.send(JSON.stringify(obj)); } catch { /* закроется само */ } };

  function lost(why) {
    if (pingTimer) { clearTimeoutFn(pingTimer); pingTimer = null; }
    const was = open;
    open = false;
    ws = null;
    if (was) onClose(why);
    if (stopped || retryTimer) return;
    retryTimer = setTimeoutFn(() => { retryTimer = null; connect(); }, retry);
    retry = Math.min(retry * 2, MAX_RETRY_MS);
  }

  function schedulePing() {
    pingTimer = setTimeoutFn(() => { if (ws) { send({ t: 'ping' }); schedulePing(); } }, PING_MS);
  }

  function connect() {
    if (stopped) return;
    if (typeof WebSocketImpl !== 'function') { logger.warn('WebSocket недоступен: заявки и команды будут опрашиваться'); return; }
    let sock;
    try { sock = new WebSocketImpl(url); } catch (error) { logger.warn('Не удалось открыть WebSocket', String(error)); lost(error); return; }
    ws = sock;
    pending = new Set(topics);
    sock.onopen = () => { for (const t of topics) send({ t: 'sub', topic: t }); };
    sock.onmessage = ev => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'sub') {
        if (m.ok !== true) { logger.warn('Подписка отклонена', { topic: m.topic, error: m.error }); return; }
        pending.delete(m.topic);
        if (!open && pending.size === 0) {
          open = true;
          retry = MIN_RETRY_MS;
          schedulePing();
          onOpen();
        }
      } else if (m.t === 'event' && typeof m.topic === 'string') {
        onEvent(m.topic, m.data);
      }
    };
    sock.onclose = () => { if (ws === sock) lost('closed'); };
    sock.onerror = () => { /* за ошибкой следует close */ };
  }

  connect();
  return {
    isOpen: () => open,
    stop() {
      stopped = true;
      if (retryTimer) clearTimeoutFn(retryTimer);
      if (pingTimer) clearTimeoutFn(pingTimer);
      try { ws?.close(); } catch { /* уже закрыто */ }
      ws = null;
      open = false;
    },
  };
}
