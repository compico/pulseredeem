# Архитектура

Аддон — мост между плагином `music` в Overlay Composer и очередью PulseSync. Twitch (OAuth, награды, EventSub, статусы
погашений) целиком в OC; аддон не хранит токенов и не ходит в Twitch.

## Поток

1. `GET /plugins/music/api/next` (раз в 3 с, пока нет активной заявки). Ответ: `{item|null, resend}`.
2. `getQueueSnapshot()` → запоминаем `startIndex`; `addTrackToQueueById(trackId, {albumId, position: 'next'})`.
3. `onQueueChange`: индекс сдвинулся и `items[currentIndex].id === trackId` → `POST /started {id}`.
4. Ошибка вставки, негодная заявка или 30 минут без старта → `POST /failed {id, reason}`.

## Состояние плеера для виджета

`getPlayerSnapshot()` → `POST /plugins/music/api/nowplaying` `{trackId, title, artists[], cover, durationMs, positionMs, playing}`.
Шлётся при смене трека, паузе, перемотке (расхождение с ожидаемой позицией > 2,5 с) и раз в 5 с. Виджет сам доигрывает
полосу прогресса между опросами. После сбоя повтор не чаще раза в 5 с.

## Инварианты

- Активна одна заявка; следующая берётся только после подтверждения предыдущей.
- Подтверждение, которое не ушло, хранится в памяти и повторяется; пока оно не ушло, новая заявка не берётся.
- Адрес OC — только loopback по http.
- Идентификаторы из заявки проверяются заново (`^\d+$`), хотя плагин уже их валидировал.

## Модули

`src/oc-client.js`, `src/dispatcher.js`, `src/player.js` — чистая логика с внедряемыми зависимостями (тесты в `test/`);
`src/main.tsx` подключает их к `api` PulseSync.
