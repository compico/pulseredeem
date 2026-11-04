# PulseSync SDK integration findings

The user-provided SDK archive contains `@pulsesync/addon-sdk@0.18.0` and `@pulsesync/yamusic-types@0.8.0`.

## Queue API

The addon's active lifecycle API exposes `api.client`. The type declarations define `addTrackToQueueById(trackId, options?)`, where the selector supports `albumId` and `position?: 'next' | 'last' | string`.

The addon calls:

```ts
await api.client.addTrackToQueueById(trackId, {
  albumId,
  position: 'last',
})
```

`last` requests appending at the end of the queue. The API is called only from the active addon's `start(api)` lifecycle, not at module import time.

## Template and metadata

The supplied `PulseSync-ExampleAddon` uses `addon.config.mjs`, `vite.config.ts`, `@pulsesync/addon-sdk/vite` and `addonPlugin()`. The build generates `metadata.json`, `script.js` and `script.css`. PulseSync's project editor can edit `addon.config.mjs`; the optional `addon.manifest.json` is not required for this project.

The repository now follows that layout and copies the template's development-delivery scripts.

## Compatibility caveat

SDK documentation warns that new SDK features require compatible Runtime/WebHost versions and that the pre-1.0 API can change between minor releases. The installed PulseSync v3.0.3-beta must pass a queue insertion smoke test before this integration is considered verified.
