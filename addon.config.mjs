const addonConfig = {
  id: 'pulseredeem',
  directoryName: 'pulseredeem',
  name: 'PulseRedeem',
  description: 'Заявки на треки из Overlay Composer → очередь PulseSync: берёт заявки у плагина music и ставит трек следующим.',
  version: '0.7.6',
  author: 'compico',
  image: '',
  banner: '',
  libraryLogo: '',
  tags: ['overlay-composer', 'yandex-music', 'queue'],
  dependencies: [],
  allowedUrls: [
    'http://127.0.0.1:8000',
  ],
  supportedVersions: [],
  requirements: {
    minHostApi: 1,
    capabilities: ['lifecycle-v1', 'async-start-v1', 'net-per-addon-v1'],
  },
}

export default addonConfig
