# PulseSync SDK integration findings

Проверено по предоставленному архиву @pulsesync/addon-sdk@0.18.0 и @pulsesync/yamusic-types@0.8.0.

## Queue API

SDK описывает addTrackToQueueById(trackId, options?), где selector поддерживает albumId и position?: 'next' | 'last' | string.

    await api.client.addTrackToQueueById(trackId, {
      albumId,
      position: 'last',
    })

## Runtime lifecycle и storage

defineAddon() принимает start(api), а API lifecycle предоставляет signal, onCleanup, setTimeout, setInterval и listen. api.storage предоставляет асинхронные get/set/remove и используется для OAuth токенов и дедупликации redemption IDs.

api.net предоставляет HTTP fetch/json/text. В публичных типах SDK 0.18.0 отдельного WebSocket API нет.

## Twitch transport

Twitch EventSub WebSocket — исходящее соединение с wss://eventsub.wss.twitch.tv/ws; входящий локальный порт для этого не нужен. Реализация использует стандартный WebSocket API среды WebHost и добавляет WSS endpoint в allowedUrls. Фактическая доступность WebSocket/CSP в PulseSync должна быть проверена smoke-тестом.

## OAuth

Для standalone desktop addon выбран Twitch OAuth Device Code Flow с Public Client: не нужен callback-сервер, redirect URI или client secret. Токены и ротация refresh token хранятся в api.storage. Токен валидируется через Twitch /oauth2/validate; срок жизни берётся из expires_in, а не задаётся константой.
