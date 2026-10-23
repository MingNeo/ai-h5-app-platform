import { BOOT_SCRIPT, TAILWIND_SCRIPT } from '@app-platform/app-template'
import { ADMIN_VIEW_FILE } from '@app-platform/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getApp, isWithinSchedule } from '../../core/apps'
import { currentFiles } from '../../core/drafts'
import { readPreviewClaims } from '../../core/preview-access'
import { blobs } from '../../lib/blob'
import { mimeOf } from '../../lib/mime'
import { col, type SnapshotFile } from '../../lib/mongo'
import { buildCsp, SECURITY_HEADERS } from './csp'
import { placeholderPage } from './pages'

const buildFileCache = new Map<string, Map<string, SnapshotFile>>()

/** 平台自己的 head 标签；应用源码里不用写，由这里统一注入 */
const PLATFORM_HEAD = [
  `<script src="${BOOT_SCRIPT}"></script>`,
  `<link rel="stylesheet" href="/__platform/ui.css">`,
  `<script src="${TAILWIND_SCRIPT}"></script>`,
]

function injectPlatformHead(html: string) {
  const missing = PLATFORM_HEAD.filter((tag) => {
    const url = /(?:src|href)="([^"]+)"/.exec(tag)?.[1]
    return url ? !html.includes(url) : true
  })
  if (!missing.length)
    return html
  return html.replace(/<head[^>]*>/i, m => `${m}\n    ${missing.join('\n    ')}`)
}

async function buildFiles(buildId: string) {
  let m = buildFileCache.get(buildId)
  if (!m) {
    const b = await col.builds.findOne({ _id: buildId }, { projection: { files: 1 } })
    if (!b)
      return null
    m = new Map(b.files.map(f => [f.path, f]))
    if (buildFileCache.size > 200)
      buildFileCache.delete(buildFileCache.keys().next().value!)
    buildFileCache.set(buildId, m)
  }
  return m
}

function sendPage(reply: FastifyReply, status: number, html: string) {
  return reply.status(status).headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS }).send(html)
}

export async function appPageHeaders(appId: string, channel: 'prod' | 'beta' | 'dev', host: string) {
  return {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': buildCsp({ host, channel }),
  }
}

/** 按文件清单返回静态文件；dev 直接读草稿，beta/prod 读构建产物（内容相同） */
async function serveFiles(req: FastifyRequest, reply: FastifyReply, files: Map<string, SnapshotFile>, channel: 'prod' | 'beta' | 'dev') {
  const site = req.site
  if (site?.kind !== 'app')
    return reply.status(404).send('Not Found')
  const { appId } = site
  let path = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, ''))
  if (path === '' || path.endsWith('/'))
    path += 'index.html'
  // 后台视图配置只在管理端读取，不对应用访问者暴露
  if (path === ADMIN_VIEW_FILE)
    return reply.status(404).headers(SECURITY_HEADERS).send('Not Found')
  if (path.endsWith('.map'))
    return reply.status(404).send('Not Found')
  let file = files.get(path)
  // 草稿里的 public/ 在预览时按根路径访问
  if (!file && channel === 'dev' && files.has(`public/${path}`)) {
    file = files.get(`public/${path}`)
    path = `public/${path}`
  }
  if (!file && !/\.[a-z0-9]+$/i.test(path)) {
    file = files.get('index.html')
    path = 'index.html'
  }
  if (!file)
    return reply.status(404).headers(SECURITY_HEADERS).send('Not Found')

  const data = await blobs.get(file.hash)
  if (!data)
    return reply.status(500).send('文件丢失')
  const etag = `"${file.hash.slice(0, 32)}"`
  if (channel !== 'dev' && req.headers['if-none-match'] === etag)
    return reply.status(304).send()
  const headers: Record<string, string> = { 'content-type': mimeOf(path), ...SECURITY_HEADERS }
  if (path === 'index.html') {
    Object.assign(headers, await appPageHeaders(appId, channel, req.headers.host ?? ''), { 'cache-control': 'no-store' })
    return reply.headers(headers).send(injectPlatformHead(data.toString('utf8')))
  }
  if (channel === 'dev') {
    headers['cache-control'] = 'no-store'
  }
  else {
    headers.etag = etag
    headers['cache-control'] = path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=60'
  }
  return reply.headers(headers).send(data)
}

/** 线上版和测试版 */
export async function serveAppBuild(req: FastifyRequest, reply: FastifyReply) {
  const site = req.site
  if (site?.kind !== 'app')
    return reply.status(404).send({ error_code: 'NOT_FOUND', error_msg: 'Not Found' })
  const { appId, channel } = site
  const doc = await getApp(appId)
  if (!doc)
    return sendPage(reply, 404, placeholderPage('not_found'))
  if (channel !== 'prod' && !readPreviewClaims(req.headers.cookie, appId))
    return sendPage(reply, 403, placeholderPage('preview_forbidden'))
  if (channel === 'prod') {
    if (doc.status === 'offline')
      return sendPage(reply, 200, placeholderPage('offline'))
    const sched = isWithinSchedule(doc)
    if (sched !== 'ok')
      return sendPage(reply, 200, placeholderPage(sched))
  }
  const buildId = channel === 'prod' ? doc.prodBuildId : doc.betaBuildId
  if (!buildId)
    return sendPage(reply, 200, placeholderPage('not_published'))
  const files = await buildFiles(buildId)
  if (!files)
    return sendPage(reply, 500, placeholderPage('not_found'))
  return serveFiles(req, reply, files, channel)
}

/** 实时预览：直接返回草稿文件，没有编译，也没有 dev server */
export async function serveAppDraft(req: FastifyRequest, reply: FastifyReply) {
  const site = req.site
  if (site?.kind !== 'app')
    return reply.status(404).send({ error_code: 'NOT_FOUND', error_msg: 'Not Found' })
  const doc = await getApp(site.appId)
  if (!doc)
    return sendPage(reply, 404, placeholderPage('not_found'))
  const files = new Map((await currentFiles(site.appId)).map(f => [f.path, f]))
  return serveFiles(req, reply, files, 'dev')
}
