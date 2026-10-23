// 平台锁定的 Vite 配置：预览（dev server）和构建共用。
// 应用工作区里的 vite.config / postcss / uno.config / .env 都不会被加载，
// 因此预览和构建只是对应用源码做纯转换，服务端不会执行生成的代码。
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VantResolver } from '@vant/auto-import-resolver'
import vue from '@vitejs/plugin-vue'
import { presetWind3 } from 'unocss'
import UnoCSS from 'unocss/vite'
import Components from 'unplugin-vue-components/vite'

export { build, createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
export const TEMPLATE_ROOT = join(here, '..')
export const TEMPLATE_FILES_DIR = join(TEMPLATE_ROOT, 'files')
export const TEMPLATE_NODE_MODULES = join(TEMPLATE_ROOT, 'node_modules')
const EMPTY_ENV_DIR = join(here, '.empty-env')

/** 任何应用都可直接使用的依赖 */
export const BASE_DEPENDENCIES = ['vue', 'vue-router', 'vant', 'pinia', '@vueuse/core', 'dayjs']
/** 需要在 manifest.dependencies 里声明后才能使用的白名单依赖 */
export const OPTIONAL_DEPENDENCIES = ['lodash-es', 'canvas-confetti', 'phaser', 'howler', 'qrcode', 'echarts']
export const ALLOWED_DEPENDENCIES = [...BASE_DEPENDENCIES, ...OPTIONAL_DEPENDENCIES]

/** 平台管理、应用不可修改的文件（src/biz-api.d.ts 由平台按业务接口目录生成，同样锁定） */
export const LOCKED_FILES = ['tsconfig.json', 'src/env.d.ts', 'src/platform.d.ts', 'src/biz-api.d.ts']
/** 禁止出现在应用工作区的文件（会被构建工具链自动加载） */
export const FORBIDDEN_FILE_RE = /^(?:vite\.config\.|vitest\.config\.|postcss\.config\.|uno\.config\.|unocss\.config\.|tailwind\.config\.|babel\.config\.|\.babelrc|\.postcssrc|\.env|package\.json$|pnpm-|yarn\.lock|package-lock\.json|node_modules\/|\.vite\/)/

export const BOOT_SCRIPT = '/__platform/boot.js'

function platformHtml(appId, channel) {
  const src = appId && channel
    ? `${BOOT_SCRIPT}?app=${encodeURIComponent(appId)}&amp;channel=${encodeURIComponent(channel)}`
    : BOOT_SCRIPT
  return {
    name: 'app-platform-html',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (html.includes(BOOT_SCRIPT))
          return html
        return {
          html,
          tags: [{ tag: 'script', attrs: { src }, injectTo: 'head-prepend' }],
        }
      },
    },
  }
}

/**
 * @param {import('./index.d.ts').PlatformViteOptions} opts
 * @returns {import('vite').InlineConfig}
 */
export function createPlatformViteConfig(opts) {
  mkdirSync(EMPTY_ENV_DIR, { recursive: true })
  const isBuild = opts.command === 'build'
  return {
    configFile: false,
    root: opts.root,
    base: opts.base ?? '/',
    mode: isBuild ? 'production' : 'development',
    publicDir: 'public',
    cacheDir: opts.cacheDir,
    envDir: EMPTY_ENV_DIR,
    clearScreen: false,
    logLevel: opts.logLevel ?? 'warn',
    customLogger: opts.customLogger,
    resolve: {
      alias: { '@': join(opts.root, 'src') },
    },
    css: {
      // 内联 postcss 配置，阻止 Vite 去加载工作区里的 postcss.config.*
      postcss: { plugins: [] },
    },
    plugins: [
      vue(),
      UnoCSS({
        configFile: false,
        presets: [presetWind3()],
      }),
      Components({
        dts: false,
        dirs: [],
        resolvers: [VantResolver({ importStyle: false })],
      }),
      platformHtml(opts.appId, opts.channel),
    ],
    server: isBuild
      ? undefined
      : {
          host: '127.0.0.1',
          port: opts.port,
          strictPort: true,
          allowedHosts: opts.allowedHosts ?? true,
          hmr: opts.hmr,
          fs: {
            strict: true,
            allow: [opts.root, TEMPLATE_ROOT, ...(opts.fsAllow ?? [])],
          },
          watch: { ignored: ['**/.vite/**', '**/node_modules/**'] },
        },
    build: isBuild
      ? {
          outDir: opts.outDir,
          emptyOutDir: true,
          target: ['es2018'],
          sourcemap: 'hidden',
          assetsDir: 'assets',
          chunkSizeWarningLimit: 2000,
          reportCompressedSize: false,
        }
      : undefined,
  }
}
