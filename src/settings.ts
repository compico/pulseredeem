import { defineAddonSettings, SettingType } from '@pulsesync/addon-sdk'

export const settings = defineAddonSettings([
  {
    title: 'Twitch',
    items: {
      clientId: {
        type: SettingType.STRING,
        name: 'Twitch Client ID',
        description: 'Client ID приложения Twitch. Для этого аддона зарегистрируй приложение как Public client.',
        default: '',
      },
      rewardId: {
        type: SettingType.STRING,
        name: 'Reward ID (необязательно)',
        description: 'ID награды Channel Points. Если оставить пустым, аддон будет принимать заявки со всех пользовательских наград.',
        default: '',
      },
    },
  },
])
