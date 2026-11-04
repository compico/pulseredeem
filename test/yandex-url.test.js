import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYandexTrackUrl } from '../src/yandex-url.js';
test('parses Yandex album/track URL',()=>{ assert.deepEqual(parseYandexTrackUrl('https://music.yandex.ru/album/33658663/track/132062255'),{albumId:'33658663',trackId:'132062255',url:'https://music.yandex.ru/album/33658663/track/132062255'}); });
test('rejects foreign host, bad path and non-https',()=>{ assert.equal(parseYandexTrackUrl('https://example.com/album/1/track/2'),null); assert.equal(parseYandexTrackUrl('https://music.yandex.ru/album/1'),null); assert.equal(parseYandexTrackUrl('http://music.yandex.ru/album/1/track/2'),null); });
