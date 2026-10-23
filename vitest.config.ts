import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
    // 服务端 config 要求显式配置域名，测试用占位值
    env: { APP_BASE_DOMAIN: 'test.example.test' },
  },
})
