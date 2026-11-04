# Архитектура PulseRedeem

Целевая среда: Windows 10/11, PulseSync WebHost с SDK 0.18.0, Яндекс Музыка Desktop.

## Компоненты

- src/main.ts: OAuth Device Code Flow, проверка/обновление токена, Twitch EventSub WebSocket, обработка погашений и вызов очереди PulseSync.
- src/settings.ts: настройки Twitch Client ID и необязательного Reward ID.
- src/yandex-url.js: строгий разбор ссылок на отдельные треки Яндекс Музыки.
- addon.config.mjs: метаданные аддона и список разрешённых сетевых адресов.
- vite.config.ts: production/development сборка через официальный @pulsesync/addon-sdk/vite.

## Поток событий

1. Пользователь запускает OAuth Device Code Flow из кнопки аддона.
2. Twitch возвращает access token и refresh token. Оба сохраняются в api.storage; refresh token ротируется при каждом обновлении.
3. Аддон валидирует токен через https://id.twitch.tv/oauth2/validate, получает ID авторизованного broadcaster и проверяет scope channel:read:redemptions.
4. Аддон открывает исходящее WebSocket-соединение к Twitch EventSub и подписывается на channel.channel_points_custom_reward_redemption.add.
5. Для события проверяется Reward ID (если задан), затем URL из user_input.
6. Аддон вызывает api.client.addTrackToQueueById(trackId, { albumId, position: 'last' }).
7. Redemption ID сохраняется в PulseSync storage для дедупликации.

## Сеть и секреты

- Входящие порты не открываются; EventSub соединение инициируется из PulseSync наружу.
- Нет локального HTTP-сервера, Node.js-процесса, .env или локальной веб-панели.
- Client Secret не используется. OAuth Device Code Flow предназначен для публичных клиентов.
- Access/refresh tokens находятся только в PulseSync storage и не коммитятся в репозиторий.
- Twitch токен проверяется при старте и каждый час. При остатке времени жизни не более часа выполняется refresh на основании Twitch expires_in, а не фиксированного TTL.

## Известные ограничения

SDK 0.18.0 предоставляет api.net.fetch/json/text, но не отдельный метод WebSocket. Код использует стандартный WebSocket среды WebHost; требуется проверить, что runtime и CSP разрешают wss://eventsub.wss.twitch.tv. До такого smoke-теста интеграция не считается подтверждённой в конкретной сборке PulseSync.
