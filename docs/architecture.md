# Архитектура PulseRedeem

Целевая среда: Windows 10/11, PulseSync WebHost с SDK 0.18.0, Яндекс Музыка Desktop.

## Компоненты

- src/main.tsx: OAuth Device Code Flow, проверка/обновление токена, загрузка/создание Twitch Channel Points rewards, Twitch EventSub WebSocket, обработка погашений и вызов очереди PulseSync.
- src/settings.ts: настройка Twitch Client ID.
- api.storage: OAuth токены, ID выбранной награды и дедупликация redemption IDs.
- api.modals.form: нативные окна PulseSync для выбора существующей награды или создания новой.
- src/yandex-url.js: строгий разбор ссылок на отдельные треки Яндекс Музыки.
- addon.config.mjs: метаданные аддона и список разрешённых сетевых адресов.
- vite.config.ts: production/development сборка через официальный @pulsesync/addon-sdk/vite.

## Поток событий

1. Пользователь запускает OAuth Device Code Flow из кнопки аддона.
2. Twitch возвращает access token и refresh token. Оба сохраняются в api.storage; refresh token ротируется при каждом обновлении.
3. Аддон валидирует токен через https://id.twitch.tv/oauth2/validate, получает ID broadcaster и проверяет scopes channel:read:redemptions и channel:manage:redemptions.
4. Аддон загружает список Channel Points rewards. Пользователь выбирает одну из них в нативном окне PulseSync либо создаёт новую; созданная награда требует текстовый ввод.
5. ID выбранной награды сохраняется в api.storage.
6. Аддон открывает исходящее WebSocket-соединение к Twitch EventSub и подписывается на channel.channel_points_custom_reward_redemption.add.
7. Для события сверяется ID выбранной награды, затем проверяется URL из user_input.
8. Аддон вызывает api.client.addTrackToQueueById(trackId, { albumId, position: 'last' }).
9. Redemption ID сохраняется в PulseSync storage для дедупликации.

Кнопка «Настроить награду» позволяет повторно выбрать или создать награду.

## Сеть и секреты

- Входящие порты не открываются; EventSub соединение инициируется из PulseSync наружу.
- Нет локального HTTP-сервера, Node.js-процесса, .env или локальной веб-панели.
- Client Secret не используется. OAuth Device Code Flow предназначен для Public clients.
- Access/refresh tokens находятся только в PulseSync storage и не коммитятся в репозиторий.
- Twitch токен проверяется при старте и каждый час через /oauth2/validate. Refresh выполняется реактивно при 401; новый одноразовый refresh token сохраняется сразу.
- OAuth Redirect URL в Twitch Developer Console: http://localhost как обязательное регистрационное значение. Успешный Device Code Flow не использует callback; адрес может быть fallback при отказе пользователя.

## Известные ограничения

SDK 0.18.0 предоставляет api.net.fetch/json/text, но не отдельный метод WebSocket. Код использует стандартный WebSocket среды WebHost; требуется проверить, что runtime и CSP разрешают wss://eventsub.wss.twitch.tv. До такого smoke-теста интеграция не считается подтверждённой в конкретной сборке PulseSync.
