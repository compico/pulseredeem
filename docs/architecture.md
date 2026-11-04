# Architecture

Target environment: Windows 10/11, PulseSync v3.0.3-beta, Yandex Music Desktop 5.125.3, Node.js 22.12+.

## Components

- `src/server.js`: loopback-only local dashboard and queue HTTP API.
- `src/queue-store.js`: durable JSON FIFO queue with per-user/queue limits.
- `src/main.ts`: official PulseSync SDK addon lifecycle and queue consumer.
- `addon.config.mjs`: editable addon metadata source for the PulseSync project editor.
- `addon/`: required project asset/settings directory, including `handleEvents.json`.
- `vite.config.ts`: official SDK Vite addon build.
- `scripts/`: project-specific development build and delivery scripts following the supplied template's workflow.

## Flow

A future Twitch EventSub integration will validate a redeemed Yandex Music URL and add it to the local queue. The addon polls `GET /api/bridge/next`, invokes `api.client.addTrackToQueueById(trackId, { albumId, position: 'last' })`, then acknowledges the request. Failed requests return to `queued`.

The bridge currently supports local test requests only. Twitch OAuth/EventSub is not yet implemented.

## Runtime compatibility

The method signature was verified in the user-provided `@pulsesync/addon-sdk@0.18.0` archive and its bundled `@pulsesync/yamusic-types@0.8.0`. The installed PulseSync v3.0.3-beta runtime still needs a smoke test. Do not mark automatic fulfilment production-ready until this test passes.

## Security

- Bind the local service to `127.0.0.1` by default.
- Never commit OAuth tokens, client secrets, session cookies or `.env`.
- Keep the dev request endpoint loopback-only.
- Twitch reward fulfilment should happen only after a request is durably stored.
