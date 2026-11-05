import { defineAddonSettings, SettingType } from '@pulsesync/addon-sdk'

export const settings = defineAddonSettings([
  {
    title: 'Интеграции',
    items: {
      enabled: {
        type: SettingType.BOOLEAN,
        name: 'Обрабатывать заявки Twitch Channel Points',
        default: true,
      },
    },
  },
])
