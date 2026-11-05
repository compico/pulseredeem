const addonConfig = {
  id: 'pulseredeem',
  directoryName: 'pulseredeem',
  name: 'PulseRedeem',
  description: 'Twitch Channel Points → Яндекс Музыка: добавляет заявки прямо в очередь PulseSync.',
  version: '0.4.0',
  author: 'compico',
  image: '',
  banner: '',
  libraryLogo: '',
  tags: ['twitch', 'yandex-music', 'queue'],
  dependencies: [],
  allowedUrls: [
    'https://id.twitch.tv',
    'https://api.twitch.tv',
    'https://www.twitch.tv',
    'wss://eventsub.wss.twitch.tv',
  ],
  supportedVersions: [],
  requirements: {
    minHostApi: 1,
    capabilities: ['lifecycle-v1', 'async-start-v1', 'net-per-addon-v1'],
  },
}

export default addonConfig
