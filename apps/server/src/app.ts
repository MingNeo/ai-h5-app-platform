import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { parseSite } from '@app-platform/shared'
import Fastify from 'fastify'
import { config } from './config'
import { readPreviewClaims } from './core/preview-access'
import { errorHandler } from './lib/http'
import { mimeOf } from './lib/mime'
import { registerAdminAuth } from './modules/admin/auth'
import { registerApiClientRoutes } from './modules/admin/api-clients'
import { registerConsoleRoutes } from './modules/admin/console'
import { registerAppRoutes } from './modules/admin/apps'
import { registerDataRoutes } from './modules/admin/data'
import { registerFileRoutes } from './modules/admin/files'
import { registerGrantRoutes } from './modules/admin/grants'
import { registerMonitorRoutes } from './modules/admin/monitor'
import { registerReleaseRoutes } from './modules/admin/release'
import { registerAgentRoutes } from './modules/agent/routes'
import { registerGateway } from './modules/gateway'
import { appPageHeaders, serveAppBuild } from './modules/host/app-host'
import { placeholderPage } from './modules/host/pages'
import { registerOpenApi } from './modules/openapi'
import { proxyPreviewRequest, proxyPreviewUpgrade } from './modules/preview/manager'

const ADMIN_DIST = join(config.repoRoot, 'apps/admin-web/dist')

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info', transport: undefined },
    trustProxy: true,
    bodyLimit: 8 * 1024 * 1024,
    disableRequestLogging: true,
  })

  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: config.limits.uploadBytes, files: 10 } })
  app.setErrorHandler(errorHandler)
  app.decorateRequest('site', null)
  app.addHook('onRequest', async (req) => {
    req.site = parseSite(req.headers.host, req.url, config.baseDomain, config.devHosts)
  })
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 500 || reply.elapsedTime > 3000)
      req.log.warn({ url: req.url, host: req.headers.host, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'slow or failed request')
  })

  app.get('/healthz', async () => ({ ok: true }))

  registerAdminAuth(app)
  registerAppRoutes(app)
  registerFileRoutes(app)
  registerAgentRoutes(app)
  registerReleaseRoutes(app)
  registerDataRoutes(app)
  registerGrantRoutes(app)
  registerMonitorRoutes(app)
  registerConsoleRoutes(app)
  registerApiClientRoutes(app)
  registerGateway(app)
  registerOpenApi(app)

  // 后台静态资源、实时预览（代理到 Vite dev server）、线上版 / 测试版
  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    handler: async (req, reply) => {
      const site = req.site
      if (!site) {
        const host = req.headers.host?.split(':')[0]?.toLowerCase()
        if (host && (host === config.baseDomain || config.devHosts.includes(host)) && req.url.split('?')[0] === '/')
          return reply.redirect('/admin/')
        return reply.status(404).type('text/plain; charset=utf-8').send(`资源不存在：请使用入口域名 ${config.baseDomain}`)
      }
      if (site.kind === 'admin')
        return serveAdmin(req.url, reply)
      // /a/vote → /a/vote/，保证相对路径按应用根解析
      if (site.path === '/' && !req.url.split('?')[0]!.endsWith('/'))
        return reply.redirect(`${req.url.split('?')[0]}/`)
      if (site.channel === 'dev') {
        if (!readPreviewClaims(req.headers.cookie, site.appId))
          return reply.status(403).type('text/html; charset=utf-8').send(placeholderPage('preview_forbidden'))
        const headers = await appPageHeaders(site.appId, 'dev', req.headers.host ?? '')
        reply.hijack()
        await proxyPreviewRequest(site.appId, req.raw, reply.raw, (_status, ct) => ({
          ...headers,
          'Content-Security-Policy': ct?.includes('text/html') ? headers['Content-Security-Policy']! : '',
          'cache-control': 'no-store',
        }))
        return
      }
      return serveAppBuild(req, reply)
    },
  })

  app.server.on('upgrade', (req, socket, head) => {
    const site = parseSite(req.headers.host, req.url ?? '/', config.baseDomain, config.devHosts)
    if (site?.kind !== 'app' || site.channel !== 'dev' || !site.path.startsWith('/__vite_hmr') || !readPreviewClaims(req.headers.cookie, site.appId)) {
      socket.destroy()
      return
    }
    void proxyPreviewUpgrade(site.appId, req, socket, head)
  })

  return app
}

/** 后台的 CSP：独立于应用，禁用内联脚本，禁止被任何页面嵌入 */
const ADMIN_CSP = [
  'default-src \'self\'',
  'script-src \'self\'',
  'style-src \'self\' \'unsafe-inline\'',
  'img-src \'self\' data: blob: https:',
  'font-src \'self\' data:',
  'connect-src \'self\'',
  'worker-src \'self\' blob:',
  // 后台需要同源 iframe 预览自己的应用
  'frame-src \'self\'',
  'frame-ancestors \'none\'',
  'object-src \'none\'',
  'base-uri \'self\'',
  'form-action \'self\'',
].join('; ')

function serveAdmin(url: string, reply: any) {
  if (!existsSync(ADMIN_DIST))
    return reply.status(404).type('text/plain; charset=utf-8').send('admin-web 未构建；本地开发请通过 make dev 访问（会代理到 Vite）')
  const pathname = decodeURIComponent(url.split('?')[0]!)
  // /admin、/admin/xxx → 去掉 /admin 前缀后在 dist 里找；SPA 路由回退到 index.html
  const rel = normalize(pathname === '/admin' ? '/' : pathname.slice('/admin'.length) || '/').replace(/^(\.\.[/\\])+/, '')
  let file = join(ADMIN_DIST, rel)
  let isIndex = false
  if (!file.startsWith(ADMIN_DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(ADMIN_DIST, 'index.html')
    isIndex = true
  }
  // 所有 SPA 路由返回同一个 index.html，安全头只挂在这份文档上
  if (isIndex) {
    return reply
      .headers({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': ADMIN_CSP,
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-origin',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'strict-transport-security': 'max-age=31536000',
      })
      .send(readFileSync(file))
  }
  return reply
    .headers({
      'content-type': mimeOf(file),
      'cache-control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    .send(readFileSync(file))
}
