# PulseSync SDK integration findings

Проверено по предоставленному архиву @pulsesync/addon-sdk@0.18.0 и @pulsesync/yamusic-types@0.8.0.

## Queue API

SDK описывает addTrackToQueueById(trackId, options?), где selector поддерживает albumId и position?: 'next' | 'last' | string.

    await api.client.addTrackToQueueById(trackId, {
      albumId,
      position: 'last',
    })

## Runtime lifecycle и storage

defineAddon() принимает start(api), а API lifecycle предоставляет signal, onCleanup, setTimeout, setInterval и listen. api.storage предоставляет асинхронные get/set/remove (аддон сейчас не использует).

api.net предоставляет HTTP fetch/json/text. В публичных типах SDK 0.18.0 отдельного WebSocket API нет.

## Сеть

`api.net.fetch(url, {method, headers, body, timeoutMs, signal})` ходит только по адресам из `allowedUrls`. Аддон использует
`http://127.0.0.1:8000` (Overlay Composer). Формат записи для `http://` и доступность loopback нужно проверить в живом PulseSync.

## `api.client` в аддоне асинхронный
Методы `api.client` (`getQueueSnapshot`, `getPlayerSnapshot`, `getState`, …) в аддоне работают через RPC и возвращают **промисы**, хотя в `@pulsesync/yamusic-types` у `PulseSyncApi` они описаны как синхронные. Без `await` получается пустой объект (`{}` при `JSON.stringify`), `currentIndex` и `track` `undefined`. Подписки (`onQueueChange`, `onPlayerSnapshotChange`) локальные и синхронные. В консоли devtools Яндекс Музыки тот же API доступен синхронно как `window.pulsesyncApi`.
