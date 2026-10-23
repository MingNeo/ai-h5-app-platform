import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { presetWind3 } from 'unocss'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    UnoCSS({ configFile: false, presets: [presetWind3()] }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: { clientPort: 443, protocol: 'wss' },
    proxy: {
      '/admin-api': { target: process.env.SERVER_URL || 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
  },
})
