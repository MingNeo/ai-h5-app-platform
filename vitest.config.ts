import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
    // 服务端 config 要求显式配置域名，测试用占位值；AUTH_PROVIDER 默认线上值需要真实接口，测试走 mock
    env: { APP_BASE_DOMAIN: 'test.example.test', AUTH_PROVIDER: 'mock' },
  },
})
