const ALLOWED_HOSTS = new Set(['music.yandex.ru','music.yandex.com','music.yandex.kz','music.yandex.by']);

export function parseYandexTrackUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\\/album\\/(\\d+)\\/track\\/(\\d+)\\/?$/);
    if (!match) return null;
    return { albumId: match[1], trackId: match[2], url: 'https://' + url.hostname.toLowerCase() + '/album/' + match[1] + '/track/' + match[2] };
  } catch { return null; }
}
