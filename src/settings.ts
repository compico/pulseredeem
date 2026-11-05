import { defineAddonSettings } from '@pulsesync/addon-sdk'

// OAuth Client ID is a public identifier and is built into the addon.
// Keep the settings page reserved for integration controls supplied by the host UI.
export const settings = defineAddonSettings([])
