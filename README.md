# PulseRedeem

PulseSync addon + local Node.js queue service for Twitch Channel Points → Yandex Music.

## Requirements

- Windows 10/11
- Node.js 22.12 or newer
- PulseSync with the project editor and a compatible WebHost/Runtime
- Yandex Music Desktop with PulseSync integration enabled

## Open the addon project in PulseSync

1. Clone this repository and check out the PR branch (or download the branch ZIP).
2. In the project root run `npm install`.
3. Start the local queue service in a separate terminal: `npm start`.
4. In PulseSync open the addons menu (⋯) → **Open project** and select this repository's root folder.
5. Run `npm run dev` in the project folder. The development script builds the addon, copies it to the PulseSync addons directory and asks the client to reload it when supported.

For manual installation, run `npm run build` followed by `npm run sync`. The addon is installed under `%APPDATA%\\PulseSync\\addons\\pulseredeem` by default.

## Current integration

The addon polls the loopback bridge at `http://127.0.0.1:3037`. For each queued request it calls the SDK's `api.client.addTrackToQueueById(trackId, { albumId, position: 'last' })` and acknowledges delivery. Failed requests are returned to the queue.

The addon manifest is defined in `addon.config.mjs`; Vite's official `addonPlugin` generates PulseSync's `metadata.json`, script and styles. The client editor can edit the metadata in `addon.config.mjs`.

## Local queue service

`npm start` starts the dashboard/API at http://127.0.0.1:3037. Use the dashboard's test request form to validate URL parsing and local queue flow. The dev endpoint is loopback-only and must not be exposed publicly.

At this stage Twitch OAuth/EventSub is not yet connected. Test queue insertion in the installed PulseSync version before enabling unattended redemptions. The bridge is a development integration and does not yet provide crash recovery for a request left in `sending`.

## Commands

| Command | Description |
| --- | --- |
| `npm start` | Start local queue service |
| `npm run dev` | Watch, build and deliver addon to PulseSync |
| `npm run build` | Production addon build into `dist/pulseredeem` |
| `npm run sync` | Copy build to PulseSync addon directory |
| `npm test` | Run unit tests |

## Notes

- Keep `.env`, local queue data and user settings out of version control.
- The addon requires `net-per-addon-v1` and allows requests only to the loopback bridge.
- SDK 0.18.0 queue method signature is based on the supplied SDK archive. Compatibility with PulseSync v3.0.3-beta still needs a runtime smoke test.
