import type { HmrOptions, InlineConfig, Logger } from 'vite'

export { build, createServer } from 'vite'

export interface PlatformViteOptions {
  command: 'serve' | 'build'
  root: string
  cacheDir: string
  outDir?: string
  port?: number
  hmr?: HmrOptions | boolean
  allowedHosts?: string[] | true
  fsAllow?: string[]
  logLevel?: 'info' | 'warn' | 'error' | 'silent'
  customLogger?: Logger
}

export const TEMPLATE_ROOT: string
export const TEMPLATE_FILES_DIR: string
export const TEMPLATE_NODE_MODULES: string
export const BASE_DEPENDENCIES: string[]
export const OPTIONAL_DEPENDENCIES: string[]
export const ALLOWED_DEPENDENCIES: string[]
export const LOCKED_FILES: string[]
export const FORBIDDEN_FILE_RE: RegExp
export const BOOT_SCRIPT: string
export function createPlatformViteConfig(opts: PlatformViteOptions): InlineConfig
