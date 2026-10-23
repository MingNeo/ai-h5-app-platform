import { BOOT_SCRIPT } from '@app-platform/app-template'
import { ADMIN_VIEW_FILE, appPath } from '@app-platform/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getApp, isWithinSchedule } from '../../core/apps'
import { readPreviewClaims } from '../../core/preview-access'
import { blobs } from '../../lib/blob'
import { mimeOf } from '../../lib/mime'
import { col, type SnapshotFile } from '../../lib/mongo'
import { buildCsp, SECURITY_HEADERS } from './csp'
import { placeholderPage } from './pages'

const buildFileCache = new Map<string, Map<string, SnapshotFile>>()
const rewriteCache = new Map<string, Buffer>()

/** 应用自己引用了 boot.js 时补上 appId / channel，否则由平台注入 */
function injectBoot(html: string, appId: string, channel: 'prod' | 'beta' | 'dev') {
  const qs = `?app=${encodeURIComponent(appId)}&amp;channel=${encodeURIComponent(channel)}`
  if (html.includes(BOOT_SCRIPT))
    return html.includes(`${BOOT_SCRIPT}?`) ? html : html.replace(BOOT_SCRIPT, `${BOOT_SCRIPT}${qs}`)
  return html.replace(/<head[^>]*>/i, m => `${m}\n    <script src="${BOOT_SCRIPT}${qs}"></script>`)
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

const REWRITE_TEXT = /\.(?:html?|js|mjs|css|svg)$/i
/** 应用内文件在根路径下的可访问路径集合，用于只改写真实存在的引用 */
function appUrlPaths(files: Map<string, SnapshotFile>) {
  const out = new Set<string>()
  for (const p of files.keys()) {
    out.add(`/${p}`)
    if (p.startsWith('public/'))
      out.add(`/${p.slice('public/'.length)}`)
  }
  return out
}

/**
 * 应用从根路径迁到 /a/{appId}[--channel]/ 后，源码里的根绝对引用需要补前缀。
 * 只改写能对应到应用文件的路径，避免误伤 platform.biz.request('/api/...') 这类业务路径。
 */
function rewriteAppUrls(text: string, base: string, urls: Set<string>) {
  const replacePath = (raw: string) => {
    if (!raw.startsWith('/') || raw.startsWith('//'))
      return raw
    const [, path, suffix = ''] = /^([^?#]*)(.*)$/.exec(raw)!
    if (path === '/')
      return `${base}${suffix}`
    return urls.has(path!) ? `${base}${path!.slice(1)}${suffix}` : raw
  }
  return text
    // 引号内的路径：HTML 属性、JS import、fetch 等
    .replace(/(["'`])(\/[^"'`\n]*?)\1/g, (_m, q: string, p: string) => `${q}${replacePath(p)}${q}`)
    // CSS url(/...)
    .replace(/url\((\s*)(['"]?)(\/[^'")\s]*)\2(\s*)\)/g, (m, s1: string, q: string, p: string, s2: string) => {
      const next = replacePath(p)
      return next === p ? m : `url(${s1}${q}${next}${q}${s2})`
    })
}

/** 改写结果按 buildId + 路径 + 前缀缓存 */
function rewriteFile(data: Buffer, path: string, base: string, urls: Set<string>, cacheKey: string) {
  const key = `${cacheKey}|${path}|${base}`
  const hit = rewriteCache.get(key)
  if (hit)
    return hit
  const out = Buffer.from(rewriteAppUrls(data.toString('utf8'), base, urls), 'utf8')
  if (rewriteCache.size > 500)
    rewriteCache.delete(rewriteCache.keys().next().value!)
  rewriteCache.set(key, out)
  return out
}

/** 按文件清单返回静态文件；beta/prod 读构建产物 */
async function serveFiles(req: FastifyRequest, reply: FastifyReply, files: Map<string, SnapshotFile>, channel: 'prod' | 'beta') {
  const site = req.site
  if (site?.kind !== 'app')
    return reply.status(404).send('Not Found')
  const { appId } = site
  const base = `${appPath(appId, channel)}/`
  let path = decodeURIComponent(site.path).replace(/^\/+/, '')
  if (path === '' || path.endsWith('/'))
    path += 'index.html'
  // 后台视图配置只在管理端读取，不对应用访问者暴露
  if (path === ADMIN_VIEW_FILE)
    return reply.status(404).headers(SECURITY_HEADERS).send('Not Found')
  if (path.endsWith('.map'))
    return reply.status(404).send('Not Found')
  let file = files.get(path)
  // public/ 下的文件按应用根路径访问（/logo.png → public/logo.png）
  if (!file && files.has(`public/${path}`)) {
    file = files.get(`public/${path}`)
    path = `public/${path}`
  }
  // 前端路由：无扩展名的路径回退到 index.html
  if (!file && !/\.[a-z0-9]+$/i.test(path)) {
    file = files.get('index.html')
    path = 'index.html'
  }
  if (!file)
    return reply.status(404).headers(SECURITY_HEADERS).send('Not Found')

  const raw = await blobs.get(file.hash)
  if (!raw)
    return reply.status(500).send('文件丢失')
  // 内容寻址：文件内容变了 hash 就变，改写缓存不会串版本
  const data = REWRITE_TEXT.test(path)
    ? rewriteFile(raw, path, base, appUrlPaths(files), file.hash)
    : raw
  const etag = `"${file.hash.slice(0, 32)}"`
  if (req.headers['if-none-match'] === etag)
    return reply.status(304).send()
  const headers: Record<string, string> = { 'content-type': mimeOf(path), ...SECURITY_HEADERS }
  if (path === 'index.html') {
    Object.assign(headers, await appPageHeaders(appId, channel, req.headers.host ?? ''), { 'cache-control': 'no-cache' })
    return reply.headers(headers).send(injectBoot(data.toString('utf8'), appId, channel))
  }
  headers.etag = etag
  headers['cache-control'] = path.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=60'
  return reply.headers(headers).send(data)
}

/** 线上版和测试版 */
export async function serveAppBuild(req: FastifyRequest, reply: FastifyReply) {
  const site = req.site
  if (site?.kind !== 'app')
    return reply.status(404).send({ error_code: 'NOT_FOUND', error_msg: 'Not Found' })
  const { appId, channel } = site
  if (channel === 'dev')
    return reply.status(404).send({ error_code: 'NOT_FOUND', error_msg: 'Not Found' })
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
