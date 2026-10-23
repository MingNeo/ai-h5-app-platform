import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { parseSiteHost } from '@app-platform/shared'
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
import { serveAppBuild, serveAppDraft } from './modules/host/app-host'
import { placeholderPage } from './modules/host/pages'
import { registerOpenApi } from './modules/openapi'

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
    req.site = parseSiteHost(req.headers.host, config.baseDomain)
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

  // 后台静态资源、实时预览（直接返回草稿文件）、线上版 / 测试版
  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    handler: async (req, reply) => {
      const site = req.site
      if (!site)
        return reply.status(404).send('Unknown host')
      if (site.kind === 'admin')
        return serveAdmin(req.url, reply)
      if (site.channel === 'dev') {
        if (!readPreviewClaims(req.headers.cookie, site.appId))
          return reply.status(403).type('text/html; charset=utf-8').send(placeholderPage('preview_forbidden'))
        return serveAppDraft(req, reply)
      }
      return serveAppBuild(req, reply)
    },
  })

  return app
}

function serveAdmin(url: string, reply: any) {
  if (!existsSync(ADMIN_DIST))
    return reply.status(404).type('text/plain; charset=utf-8').send('admin-web 未构建；本地开发请通过 nginx 访问（会代理到 Vite）')
  let path = normalize(decodeURIComponent(url.split('?')[0]!)).replace(/^(\.\.[/\\])+/, '')
  let file = join(ADMIN_DIST, path)
  if (!file.startsWith(ADMIN_DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(ADMIN_DIST, 'index.html')
    path = '/index.html'
  }
  return reply
    .headers({
      'content-type': mimeOf(file),
      'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    })
    .send(readFileSync(file))
}
