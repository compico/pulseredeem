import { defineAddonSettings, SettingType } from '@pulsesync/addon-sdk'

export const settings = defineAddonSettings([
  {
    title: 'Twitch',
    items: {
      clientId: {
        type: SettingType.STRING,
        name: 'Twitch Client ID',
        description: 'Client ID приложения Twitch. Зарегистрируй приложение как Public client; Client Secret не нужен.',
        default: '',
      },
    },
  },
])
