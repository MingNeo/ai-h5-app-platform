// 平台前端约定：应用是纯 HTML + 原生 ESM，没有构建、没有打包。
// 这里只提供模板目录、保留路径和平台前端的文件位置；应用代码不会被加载或执行。
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

export const TEMPLATE_ROOT = join(here, '..')
export const TEMPLATE_FILES_DIR = join(TEMPLATE_ROOT, 'files')
/** 平台前端运行时（dom.js、ui.js、ui.css），由 server 直接返回 */
export const FRONTEND_DIR = join(here, 'frontend')
/** Tailwind v4 浏览器运行时：扫描 DOM 生成原子类，不需要构建 */
export const TAILWIND_FILE = require.resolve('@tailwindcss/browser')

/** 平台保留路径：应用可以引用，但不属于应用文件 */
export const PLATFORM_PREFIX = '/__platform/'
export const BOOT_SCRIPT = '/__platform/boot.js'
export const TAILWIND_SCRIPT = '/__platform/tailwind.js'

/** 平台运行时不依赖任何第三方包，应用也不能声明依赖 */
export const BASE_DEPENDENCIES = []
export const OPTIONAL_DEPENDENCIES = []
export const ALLOWED_DEPENDENCIES = []

/** 平台管理、应用不可修改的文件（当前没有，保留给后续平台级生成文件） */
export const LOCKED_FILES = []
/** 禁止出现在应用工作区的文件（构建配置会被工具链自动加载） */
export const FORBIDDEN_FILE_RE = /^(?:vite\.config\.|vitest\.config\.|postcss\.config\.|uno\.config\.|unocss\.config\.|tailwind\.config\.|babel\.config\.|\.babelrc|\.postcssrc|\.env|package\.json$|pnpm-|yarn\.lock|package-lock\.json|node_modules\/|\.vite\/)/
