const addonConfig = {
  id: 'pulseredeem',
  directoryName: 'pulseredeem',
  name: 'PulseRedeem',
  description: 'Twitch Channel Points → Яндекс Музыка: принимает заявки и добавляет треки в конец очереди PulseSync.',
  version: '0.2.0',
  author: 'compico',
  image: '',
  banner: '',
  libraryLogo: '',
  tags: ['twitch', 'yandex-music', 'queue'],
  dependencies: [],
  allowedUrls: ['http://127.0.0.1:3037'],
  supportedVersions: [],
  requirements: {
    minHostApi: 1,
    capabilities: ['lifecycle-v1', 'async-start-v1', 'net-per-addon-v1'],
  },
}

export default addonConfig
