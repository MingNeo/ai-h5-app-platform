import type { Channel } from '@app-platform/shared'
import { config } from '../../config'

/** 应用页面的 CSP：只能访问自身文件、平台接口（同源）；业务接口一律经平台代理，不需要放行外部域名 */
export function buildCsp(opts: { host: string, channel: Channel }) {
  const loginOrigin = config.auth.loginOrigin
  const geetest = config.csp.geetest.join(' ')
  const connect = ["'self'", loginOrigin, geetest].filter(Boolean)
  if (opts.channel === 'dev')
    connect.push(`wss://${opts.host}`)
  const loginDirs = [loginOrigin, geetest].filter(Boolean).join(' ')
  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': `'self' ${geetest}`,
    'style-src': `'self' 'unsafe-inline' ${geetest}`,
    'img-src': `'self' data: blob: ${loginDirs} ${config.csp.imgExtra.join(' ')}`,
    'font-src': "'self' data:",
    'media-src': "'self' data: blob:",
    'connect-src': connect.join(' '),
    'frame-src': "'none'",
    'worker-src': "'self' blob:",
    'object-src': "'none'",
    'base-uri': "'self'",
    'form-action': `'self' ${loginOrigin}`.trim(),
    'frame-ancestors': `'self' ${config.adminOrigin}`,
  }
  return Object.entries(directives).map(([k, v]) => `${k} ${v}`).join('; ')
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000',
}
