import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { presetWind3 } from 'unocss'
import { defineConfig } from 'vite'

/** 直接跑 `vite` 时也要拿到入口域名，否则 server 会按 Host 拒绝（本地优先用 make dev） */
function appDomain() {
  if (process.env.APP_BASE_DOMAIN)
    return process.env.APP_BASE_DOMAIN
  const file = fileURLToPath(new URL('../../.env.local', import.meta.url))
  if (existsSync(file)) {
    const m = /^\s*APP_BASE_DOMAIN\s*=\s*(.+?)\s*$/m.exec(readFileSync(file, 'utf8'))
    if (m)
      return m[1]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return 'localhost'
}

export default defineConfig({
  // 后台与应用同域：https://<base>/admin/
  base: '/admin/',
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
      // 后端按 Host 判断站点，直连 Vite 时把 Host 改成入口域名
      '/admin-api': {
        target: process.env.SERVER_URL || 'http://127.0.0.1:3000',
        changeOrigin: false,
        headers: { host: appDomain() },
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
  },
})
