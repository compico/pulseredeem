import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseYandexTrackUrl } from './yandex-url.js';

export class QueueStore {
  constructor({ filePath = path.resolve('data/queue.json'), maxQueue = 15, maxPerUser = 1 } = {}) {
    this.filePath = filePath; this.maxQueue = maxQueue; this.maxPerUser = maxPerUser;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try { this.state = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { this.state = { items: [], history: [], redemptionIds: [] }; }
    this.state.items ||= []; this.state.history ||= []; this.state.redemptionIds ||= [];
  }
  save() { const tmp = this.filePath + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2)); fs.renameSync(tmp, this.filePath); }
  snapshot() { return structuredClone(this.state); }
  add({ url, userId, userName, redemptionId = null }) {
    if (!userId || !userName) return { ok: false, reason: 'invalid_user' };
    if (redemptionId && this.state.redemptionIds.includes(redemptionId)) return { ok: false, reason: 'duplicate_redemption' };
    const parsed = parseYandexTrackUrl(url); if (!parsed) return { ok: false, reason: 'invalid_yandex_url' };
    const active = this.state.items.filter(x => ['queued','sending','sent_to_player'].includes(x.status));
    if (active.length >= this.maxQueue) return { ok: false, reason: 'queue_full' };
    if (active.filter(x => x.userId === String(userId)).length >= this.maxPerUser) return { ok: false, reason: 'user_limit' };
    if (active.some(x => x.trackId === parsed.trackId)) return { ok: false, reason: 'duplicate_track' };
    const item = { id: randomUUID(), redemptionId, userId: String(userId), userName: String(userName).slice(0,100), ...parsed, title: 'Трек ' + parsed.trackId, artist: 'Метаданные ожидают интеграции', status: 'queued', createdAt: new Date().toISOString() };
    this.state.items.push(item); if (redemptionId) this.state.redemptionIds.push(redemptionId);
    this.state.redemptionIds = this.state.redemptionIds.slice(-2000); this.save(); return { ok: true, item: structuredClone(item) };
  }
  remove(id) {
    const index = this.state.items.findIndex(x => x.id === id); if (index < 0) return null;
    const item = this.state.items.splice(index,1)[0]; this.state.history.unshift({ ...item, status:'removed', finishedAt:new Date().toISOString() });
    this.state.history = this.state.history.slice(0,100); this.save(); return item;
  }
}
