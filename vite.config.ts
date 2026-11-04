import path from 'node:path'
import { addonPlugin, defineAddonManifest } from '@pulsesync/addon-sdk/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import addonConfig from './addon.config.mjs'

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  plugins: [
    react(),
    addonPlugin({
      manifest: defineAddonManifest(addonConfig),
      minify: mode === 'development' ? false : 'oxc',
      ...(process.env.PULSESYNC_ADDON_OUT_DIR
        ? { outDir: process.env.PULSESYNC_ADDON_OUT_DIR }
        : {}),
    }),
  ],
}))
