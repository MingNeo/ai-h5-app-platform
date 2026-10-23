import { BOOT_SCRIPT } from '@app-platform/app-template'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getApp, isWithinSchedule } from '../../core/apps'
import { readPreviewClaims } from '../../core/preview-access'
import { blobs } from '../../lib/blob'
import { mimeOf } from '../../lib/mime'
import { col, type SnapshotFile } from '../../lib/mongo'
import { buildCsp, SECURITY_HEADERS } from './csp'
import { placeholderPage } from './pages'

const buildFileCache = new Map<string, Map<string, SnapshotFile>>()

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

/** 线上版和测试版：从构建产物返回静态文件 */
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

    let path = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, ''))
    if (path === '' || path.endsWith('/'))
      path += 'index.html'
    if (path.endsWith('.map'))
      return reply.status(404).send('Not Found')
    let file = files.get(path)
    if (!file && !/\.[a-z0-9]+$/i.test(path))
      file = files.get('index.html'), path = 'index.html'
    if (!file)
      return reply.status(404).headers(SECURITY_HEADERS).send('Not Found')

    const data = await blobs.get(file.hash)
    if (!data)
      return reply.status(500).send('文件丢失')
    const etag = `"${file.hash.slice(0, 32)}"`
    if (req.headers['if-none-match'] === etag)
      return reply.status(304).send()
    const headers: Record<string, string> = { 'content-type': mimeOf(path), 'etag': etag, ...SECURITY_HEADERS }
    if (path === 'index.html') {
      Object.assign(headers, await appPageHeaders(appId, channel, req.headers.host ?? ''), { 'cache-control': 'no-cache' })
      let html = data.toString('utf8')
      if (!html.includes(BOOT_SCRIPT))
        html = html.replace(/<head[^>]*>/i, m => `${m}\n    <script src="${BOOT_SCRIPT}"></script>`)
      return reply.headers(headers).send(html)
    }
    headers['cache-control'] = path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=60'
    return reply.headers(headers).send(data)
}
