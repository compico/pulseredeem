# PulseSync SDK integration findings

Inspected the user-provided archive of `@pulsesync/addon-sdk` **0.18.0** and its bundled `@pulsesync/yamusic-types` **0.8.0** declarations.

## Confirmed queue API

The SDK's `AddonApi` exposes:

- `api.client` as `PulseSyncWebHostApiV1` (the WebHost RPC API)
- `api.pulsesyncApi` as the same WebHost API
- `api.player` as a read-only player snapshot/subscription facade

The underlying `PulseSyncApi` declaration includes:

```ts
interface PulseSyncTrackSelector {
  albumId?: string;
  from?: string;
  position?: 'next' | 'last' | string;
}

interface PulseSyncApi {
  addTrackToQueueById(
    trackId: string,
    options?: PulseSyncTrackSelector
  ): void;
}
```

The WebHost RPC type wraps remote API calls in promises. The intended addon call is therefore:

```ts
await api.client.addTrackToQueueById(trackId, {
  albumId,
  position: 'last',
});
```

For the requested behaviour, `position: 'last'` is the append-to-end selector; `'next'` is available when inserting immediately after the current track. Track and album IDs are parsed from a canonical Yandex Music URL such as `/album/33658663/track/132062255`.

## Integration notes

- Call the method only from an active addon's `start(api)` lifecycle or an active addon handler, not at module import time.
- Use `api.onCleanup()` for listeners and local resources.
- The SDK README explicitly warns that new SDK features require a compatible Runtime/WebHost and that pre-1.0 minor versions may change. The installed PulseSync runtime must still be checked with a smoke test before enabling automatic fulfilment.
- The archive bundles `@pulsesync/yamusic-types@0.8.0`, which is the SDK's declared dependency range (`^0.8.0`). The project should not pin a separate older `0.4.0` copy.

## Relevant official documentation

- SDK npm package: https://www.npmjs.com/package/@pulsesync/addon-sdk
- Example addon template: https://github.com/PulseSync-LLC/PulseSync-ExampleAddon
