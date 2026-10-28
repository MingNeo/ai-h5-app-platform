import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { type Channel, dataEnvOf, parseAppPath, RESERVED_APP_IDS, APP_ID_RE, appPath } from '@app-platform/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../../config'
import { allowedBizPrefixes, approvedGrants, effectiveManifest, getApp } from '../../core/apps'
import { buildUpstreamUrl, resolveBizTarget } from '../../core/biz-docs'
import { pushDevError } from '../../core/dev-errors'
import { previewCookieName, previewCookieValue, readPreviewClaims, verifyPreviewTicket } from '../../core/preview-access'
import { blobs } from '../../lib/blob'
import { err } from '../../lib/errors'
import { ok, parseCookies } from '../../lib/http'
import { UPLOAD_MIME } from '../../lib/mime'
import { appCollection, col } from '../../lib/mongo'
import { rateLimit } from '../../lib/store'
import { newId, randomToken, signToken } from '../../lib/tokens'
import { registerPlatformAssets } from '../host/platform-assets'
import { countDocs, createDoc, type DataCtx, getDoc, groupDocs, queryDocs, removeDoc, updateDoc } from './data'
import { DEV_USER_COOKIE, type Identity, resolveIdentity } from './identity'

const require = createRequire(import.meta.url)
const SDK_JS = join(dirname(require.resolve('@app-platform/sdk/package.json')), 'dist/sdk.js')
let sdkCache: { mtime: number, text: string } | null = null

function sdkSource() {
  const mtime = statSync(SDK_JS).mtimeMs
  if (!sdkCache || sdkCache.mtime !== mtime)
    sdkCache = { mtime, text: readFileSync(SDK_JS, 'utf8') }
  return sdkCache.text
}

declare module 'fastify' {
  interface FastifyRequest {
    appCtx?: { appId: string, channel: Channel, identity?: Identity }
  }
}

/** 不需要 X-App-SDK 头的路径（sendBeacon、<img>、页面跳转、脚本、样式） */
const NO_SDK_HEADER = new Set([
  '/__platform/boot.js',
  '/__platform/preview-auth',
  '/__platform/api/telemetry',
  '/__platform/dom.js',
  '/__platform/ui.js',
  '/__platform/ui.css',
  '/__platform/tailwind.js',
])

/** 平台共享的运行时文件与应用无关，不解析 appId */
const PLATFORM_ASSETS = new Set([
  '/__platform/dom.js',
  '/__platform/ui.js',
  '/__platform/ui.css',
  '/__platform/tailwind.js',
])

/** 不转发给上游的平台 cookie（后台会话、预览票据、预览身份） */
function isPlatformCookie(name: string) {
  return name === '__Host-app_admin' || name.startsWith('__Host-app_preview') || name === DEV_USER_COOKIE
}

/** 转发主站 cookie（sess 等），平台自己的 cookie 全部剔除 */
function forwardCookie(header?: string) {
  if (!header)
    return ''
  return header.split(';').map(s => s.trim()).filter(Boolean)
    .filter((pair) => {
      const i = pair.indexOf('=')
      return i > 0 && !isPlatformCookie(pair.slice(0, i))
    })
    .join('; ')
}

function queryOf(req: FastifyRequest, name: string): string | undefined {
  const i = req.url.indexOf('?')
  if (i < 0)
    return undefined
  return new URLSearchParams(req.url.slice(i + 1)).get(name) ?? undefined
}

const CHANNELS = new Set(['prod', 'beta', 'dev'])

/**
 * 应用身份来自 SDK 请求头（或支持不带头的查询参数：sendBeacon、图片）。
 * 平台已放弃应用间的 origin 隔离，appId 可被应用代码修改，按已接受的风险处理。
 *
 * 渠道必须显式给出，缺省不再回退到 prod/dev；缺失或非法直接拒绝，
 * 避免任何一侧的默认值不一致时静默落到错误的数据环境。
 */
function appLocator(req: FastifyRequest): { appId: string, channel: Channel } {
  const appId = String(req.headers['x-app-id'] ?? queryOf(req, 'app') ?? '')
  const rawChannel = String(req.headers['x-app-channel'] ?? queryOf(req, 'channel') ?? '')
  if (!APP_ID_RE.test(appId) || RESERVED_APP_IDS.has(appId))
    throw err.notFound()
  if (!CHANNELS.has(rawChannel))
    throw err.invalid('缺少或非法的应用渠道标识')
  return { appId, channel: rawChannel as Channel }
}

/**
 * 请求来源页面（Referer）解析出的应用与渠道。
 * 这是渠道的权威来源：SDK 头/查询参数只用于交叉校验，两者不一致一律拒绝。
 */
function refererSite(req: FastifyRequest): { appId: string, channel: Channel } | null {
  const raw = req.headers.referer
  if (!raw)
    return null
  let url: URL
  try {
    url = new URL(raw)
  }
  catch {
    return null
  }
  const hostname = url.hostname.toLowerCase()
  const base = config.baseDomain.toLowerCase()
  if (hostname !== base && !config.devHosts.includes(hostname))
    return null
  const site = parseAppPath(url.pathname)
  return site ? { appId: site.appId, channel: site.channel } : null
}

async function identity(req: FastifyRequest) {
  const c = req.appCtx!
  if (!c.identity)
    c.identity = await resolveIdentity(req, c.appId, c.channel)
  return c.identity
}

async function dataCtx(req: FastifyRequest): Promise<DataCtx> {
  const c = req.appCtx!
  const [id, manifest] = await Promise.all([identity(req), effectiveManifest(c.appId, c.channel)])
  return {
    appId: c.appId,
    env: dataEnvOf(c.channel),
    manifest,
    user: id.user,
    vid: parseCookies(req.headers.cookie).app_vid,
    ip: req.ip,
  }
}

export function registerGateway(app: FastifyInstance) {
  /**
   * 平台接口的响应内容取决于请求头里的应用与渠道，URL 本身几乎不带这些信息。
   * 一旦中间层（CDN / 反向代理）只按 URL 缓存，dev 的响应就可能被 prod 页面读到。
   * 因此：除平台共享运行时文件和内容寻址的文件下载外，一律禁止缓存，并显式声明 Vary。
   */
  app.addHook('onSend', async (req, reply, payload) => {
    if (!req.url.startsWith('/__platform/') && !req.url.startsWith('/open-api/'))
      return payload
    const path = req.url.split('?')[0]!
    if (PLATFORM_ASSETS.has(path) || path.startsWith('/__platform/api/files/'))
      return payload
    reply.header('cache-control', 'no-store')
    reply.header('vary', 'X-App-Id, X-App-Channel, Referer')
    return payload
  })

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/__platform/'))
      return
    if (req.method === 'OPTIONS')
      return reply.status(403).send()
    const path = req.url.split('?')[0]!
    // 平台运行时文件与应用无关，直接放行
    if (PLATFORM_ASSETS.has(path))
      return
    const isFileGet = req.method === 'GET' && path.startsWith('/__platform/api/files/')
    if (!NO_SDK_HEADER.has(path) && !isFileGet) {
      if (req.headers['x-app-sdk'] !== '1')
        throw err.forbidden('缺少 SDK 请求头')
      const fetchSite = req.headers['sec-fetch-site']
      if (fetchSite && fetchSite !== 'same-origin')
        throw err.forbidden('不允许跨站调用平台接口')
    }
    if (!await rateLimit(`ip:${req.ip}`, config.limits.apiPerMinutePerIp, 60))
      throw err.rate()
    // 预览票据换 cookie：appId 与渠道从票据里取，不信任其它输入
    if (path === '/__platform/preview-auth')
      return
    const loc = appLocator(req)
    // 渠道以页面来源为准：来源页面必须是同一个应用、同一个渠道。
    // 这样即使应用代码伪造了 X-App-Channel（或浏览器里残留了其它渠道的预览 cookie），
    // 也不可能从线上页面读写测试环境的数据。
    const src = refererSite(req)
    if (!src || src.appId !== loc.appId || src.channel !== loc.channel) {
      // 这类拒绝是排查“请求串到另一个环境”的关键线索，必须留痕
      req.log.warn({
        url: req.url,
        referer: req.headers.referer,
        claimedAppId: loc.appId,
        claimedChannel: loc.channel,
        sourceAppId: src?.appId,
        sourceChannel: src?.channel,
      }, 'app channel does not match request origin')
      throw err.forbidden('请求来源与应用渠道不一致')
    }
    const doc = await getApp(loc.appId)
    if (!doc)
      throw err.notFound('应用不存在')
    if (loc.channel !== 'prod' && !readPreviewClaims(req.headers.cookie, loc.appId, loc.channel))
      throw err.forbidden('需要预览权限')
    req.appCtx = { appId: loc.appId, channel: loc.channel }
  })

  // 平台 SDK + 应用配置
  app.get('/__platform/boot.js', async (req, reply) => {
    const { appId, channel } = req.appCtx!
    // 预览身份锁定只取决于本地签名票据，同步读 cookie 即可。
    // 真实用户身份要请求主站用户信息接口（含 3s 超时），不能放在 boot 阶段：
    // boot.js 是 head 里的同步脚本，会阻塞首屏。身份由 SDK 启动后异步请求 /api/auth/me 获取。
    const claims = channel === 'prod' ? null : readPreviewClaims(req.headers.cookie, appId, channel)
    const identityLocked = claims?.identity === 'guest' || claims?.identity === 'test'
    const [doc, manifest, grants] = await Promise.all([getApp(appId), effectiveManifest(appId, channel), approvedGrants(appId)])
    const buildId = channel === 'prod' ? doc?.prodBuildId : channel === 'beta' ? doc?.betaBuildId : 'draft'
    const cfg = {
      appId,
      channel,
      base: appPath(appId, channel),
      version: buildId ?? '0',
      sdkVersion: '1',
      requireLogin: Boolean(manifest?.requireLogin),
      mockLogin: config.auth.allowMockLogin && channel !== 'prod',
      apiBase: '/__platform/api',
      biz: { prefixes: allowedBizPrefixes(manifest, grants.bizPrefixes), unauthCodes: config.biz.unauthCodes },
      login: {
        loginOrigin: config.auth.loginOrigin,
        loginMobileOrigin: config.auth.loginMobileOrigin,
        fromActivity: config.auth.fromActivity,
        agreementUrl: config.auth.agreementUrl,
        privacyUrl: config.auth.privacyUrl,
      },
      native: { containers: config.native.containers },
      adminOrigin: channel === 'prod' ? undefined : config.adminOrigin,
      identityLocked,
    }
    if (!req.headers.cookie?.includes('app_vid='))
      reply.setCookie('app_vid', randomToken(12), { path: '/', maxAge: 365 * 86400, sameSite: 'lax', secure: true })
    return reply
      .headers({ 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
      .send(`window.__APP_CONFIG__=${JSON.stringify(cfg).replace(/</g, '\\u003c')};\n${sdkSource()}`)
  })

  // 后台预览票据换 cookie
  app.get('/__platform/preview-auth', async (req, reply) => {
    const q = req.query as { t?: string, next?: string }
    const claims = verifyPreviewTicket(q.t)
    if (!claims)
      return reply.status(403).type('text/html; charset=utf-8').send('<p>预览链接已过期，请回到后台重新打开</p>')
    if (!await getApp(claims.appId))
      return reply.status(403).type('text/html; charset=utf-8').send('<p>应用不存在或已删除</p>')
    reply.setCookie(previewCookieName(claims.appId, claims.channel), previewCookieValue(claims.appId, claims.channel, claims.uid, claims.identity), {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 24 * 3600,
    })
    const next = typeof q.next === 'string' && q.next.startsWith('/') && !q.next.startsWith('//') ? q.next : '/'
    return reply.redirect(`${appPath(claims.appId, claims.channel)}${next === '/' ? '/' : next}`)
  })

  app.get('/__platform/api/auth/me', async (req) => {
    const id = await identity(req)
    return ok({ user: id.user, identityLocked: id.locked })
  })

  // 调试用的模拟登录：ALLOW_MOCK_LOGIN=1 才开启，dev/beta 渠道可用，prod 永远拒绝。
  // 线上开发/测试环境需要调试数据时可以显式打开；正式环境不要设置。
  // cookie 里带 appId + channel 签名，跨渠道不识别。
  app.post('/__platform/api/dev/mock-login', async (req, reply) => {
    const { appId, channel } = req.appCtx!
    if (!config.auth.allowMockLogin || channel === 'prod')
      throw err.forbidden('当前环境未开启模拟登录')
    const claims = readPreviewClaims(req.headers.cookie, appId, channel)
    if (!claims)
      throw err.forbidden('需要该渠道的预览权限')
    const user = { uid: `dev_${claims.uid}`, nickname: '开发测试用户', avatar: '' }
    reply.setCookie(DEV_USER_COOKIE, signToken({ kind: 'dev-user', appId, channel, user }, 7 * 86400), {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 86400,
    })
    return ok({ user })
  })

  app.post('/__platform/api/dev/mock-logout', async (_req, reply) => {
    reply.clearCookie(DEV_USER_COOKIE, { path: '/' })
    return ok({})
  })

  // ---------- 数据库 ----------
  app.post('/__platform/api/db/:col/query', async req => ok(await queryDocs(await dataCtx(req), (req.params as any).col, req.body)))
  app.post('/__platform/api/db/:col/count', async req => ok(await countDocs(await dataCtx(req), (req.params as any).col, req.body)))
  app.post('/__platform/api/db/:col/group', async req => ok(await groupDocs(await dataCtx(req), (req.params as any).col, req.body)))
  app.post('/__platform/api/db/:col', async req => ok(await createDoc(await dataCtx(req), (req.params as any).col, (req.body as any)?.data)))
  app.get('/__platform/api/db/:col/:id', async req => ok(await getDoc(await dataCtx(req), (req.params as any).col, (req.params as any).id)))
  app.patch('/__platform/api/db/:col/:id', async req => ok(await updateDoc(await dataCtx(req), (req.params as any).col, (req.params as any).id, (req.body as any)?.data)))
  app.delete('/__platform/api/db/:col/:id', async req => ok(await removeDoc(await dataCtx(req), (req.params as any).col, (req.params as any).id)))

  // ---------- KV ----------
  const KEY_RE = /^[\w.:-]{1,64}$/
  const kvKey = (req: FastifyRequest) => {
    const key = (req.params as { key: string }).key
    if (!KEY_RE.test(key))
      throw err.invalid('key 只能包含字母、数字和 _ . : -，最长 64 位')
    return key
  }
  app.get('/__platform/api/kv/user/:key', async (req) => {
    const ctx = await dataCtx(req)
    if (!ctx.user)
      throw err.login()
    const doc = await appCollection<{ _id: string, value: unknown }>(ctx.appId, ctx.env, '_kv_user').findOne({ _id: `${ctx.user.uid}:${kvKey(req)}` })
    return ok({ value: doc?.value ?? null })
  })
  app.put('/__platform/api/kv/user/:key', async (req) => {
    const ctx = await dataCtx(req)
    if (!ctx.user)
      throw err.login()
    const key = kvKey(req)
    const value = (req.body as { value?: unknown })?.value
    if (Buffer.byteLength(JSON.stringify(value ?? null)) > config.limits.kvValueBytes)
      throw err.invalid(`value 不能超过 ${config.limits.kvValueBytes / 1024}KB`)
    if (!await rateLimit(`kv:${ctx.appId}:${ctx.user.uid}`, config.limits.writesPerMinutePerUser, 60))
      throw err.rate()
    await appCollection<{ _id: string }>(ctx.appId, ctx.env, '_kv_user').updateOne(
      { _id: `${ctx.user.uid}:${key}` },
      { $set: { uid: ctx.user.uid, key, value, updatedAt: Date.now() } },
      { upsert: true },
    )
    return ok({})
  })
  app.delete('/__platform/api/kv/user/:key', async (req) => {
    const ctx = await dataCtx(req)
    if (!ctx.user)
      throw err.login()
    await appCollection<{ _id: string }>(ctx.appId, ctx.env, '_kv_user').deleteOne({ _id: `${ctx.user.uid}:${kvKey(req)}` })
    return ok({})
  })
  app.get('/__platform/api/kv/app/:key', async (req) => {
    const ctx = await dataCtx(req)
    const doc = await appCollection<{ _id: string, value: unknown }>(ctx.appId, ctx.env, '_kv_app').findOne({ _id: kvKey(req) })
    return ok({ value: doc?.value ?? null })
  })

  // ---------- 文件 ----------
  app.post('/__platform/api/files', async (req) => {
    const ctx = await dataCtx(req)
    if (!ctx.user)
      throw err.login()
    if (!await rateLimit(`up:${ctx.appId}:${ctx.user.uid}`, 30, 60))
      throw err.rate()
    let isPublic = true
    let file: { data: Buffer, mime: string, name: string } | null = null
    for await (const part of req.parts({ limits: { fileSize: config.limits.uploadBytes, files: 1 } })) {
      if (part.type === 'field' && part.fieldname === 'public')
        isPublic = part.value !== '0'
      if (part.type === 'file') {
        const data = await part.toBuffer()
        if (part.file.truncated)
          throw err.invalid(`文件不能超过 ${config.limits.uploadBytes / 1024 / 1024}MB`)
        file = { data, mime: part.mimetype, name: part.filename }
      }
    }
    if (!file)
      throw err.invalid('缺少文件')
    if (!UPLOAD_MIME.test(file.mime))
      throw err.invalid('只支持上传图片、音频、视频')
    const { hash, size } = await blobs.put(file.data)
    const fileId = newId()
    await appCollection<any>(ctx.appId, ctx.env, '_files').insertOne({
      _id: fileId,
      owner: ctx.user.uid,
      name: file.name.slice(0, 200),
      mime: file.mime,
      size,
      hash,
      public: isPublic,
      createdAt: Date.now(),
    })
    // <img>/<a> 不会带自定义头，appId 与渠道放进 URL
    return ok({ fileId, url: `/__platform/api/files/${fileId}?app=${encodeURIComponent(ctx.appId)}&channel=${encodeURIComponent(req.appCtx!.channel)}`, size, mime: file.mime })
  })
  app.get('/__platform/api/files/:id', async (req, reply: FastifyReply) => {
    const ctx = await dataCtx(req)
    const meta = await appCollection<any>(ctx.appId, ctx.env, '_files').findOne({ _id: (req.params as any).id })
    if (!meta)
      throw err.notFound('文件不存在')
    if (!meta.public && meta.owner !== ctx.user?.uid)
      throw err.forbidden('无权访问该文件')
    const data = await blobs.get(meta.hash)
    if (!data)
      throw err.notFound('文件不存在')
    return reply.headers({
      'content-type': meta.mime,
      'cache-control': meta.public ? 'public, max-age=86400' : 'private, max-age=300',
      'content-security-policy': 'default-src \'none\'; sandbox',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    }).send(data)
  })

  // ---------- 埋点 ----------
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 128 * 1024 }, (_req, body, done) => done(null, body))
  app.post('/__platform/api/telemetry', async (req) => {
    const { appId, channel } = req.appCtx!
    let body: any = req.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      }
      catch {
        return ok({})
      }
    }
    const events = Array.isArray(body?.events) ? body.events.slice(0, 50) : []
    if (!events.length)
      return ok({})
    const id = await identity(req)
    const vid = String((req.cookies as Record<string, string>).app_vid ?? '')
    await col.telemetry.insertMany(events.map((e: any) => ({
      appId,
      channel,
      type: String(e.type ?? 'custom').slice(0, 20),
      ts: new Date(Number(e.ts) || Date.now()),
      path: String(e.path ?? '').slice(0, 300),
      uid: id.user?.uid,
      vid,
      data: Object.fromEntries(Object.entries(e).filter(([k]) => !['type', 'ts', 'path'].includes(k)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 2000) : v])),
    })))
    return ok({})
  })

  // ---------- 业务接口代理（平台服务器 → 内网上游） ----------
  app.all('/__platform/api/biz/*', async (req, reply) => {
    const { appId, channel } = req.appCtx!
    const path = `/${(req.params as Record<string, string>)['*'] ?? ''}`
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
    const res = await resolveBizTarget(appId, req.method, path)
    if (!res.ok)
      throw err.capability(res.reason)
    const { target } = res
    const url = buildUpstreamUrl(target.upstream, target.upstreamPath, query)

    const headers: Record<string, string> = { ...target.headers }
    const contentType = req.headers['content-type']
    if (contentType)
      headers['content-type'] = contentType
    const cookie = forwardCookie(req.headers.cookie)
    if (cookie)
      headers.cookie = cookie

    let body: string | undefined
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined)
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)

    let upstream: Response
    try {
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.biz.timeoutMs),
      })
    }
    catch (e) {
      const timeout = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError'
      const msg = timeout ? '业务接口超时' : '业务接口不可用'
      req.log.warn({ appId, path, upstream: url.origin, err: (e as Error).message }, 'biz proxy failed')
      if (channel !== 'prod')
        void pushDevError(appId, { kind: 'biz', message: `${msg}：${req.method} ${path}（${url.origin}）${(e as Error).message}` })
      throw err.upstream(msg)
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      // 重定向地址多半是内网地址，浏览器跟不过去，直接把问题抛给管理员
      throw err.upstream(`上游返回了重定向（${upstream.status}），请把最终地址配成上游`)
    }
    const data = Buffer.from(await upstream.arrayBuffer())
    reply.status(upstream.status)
    const ct = upstream.headers.get('content-type')
    if (ct)
      reply.header('content-type', ct)
    reply.header('cache-control', 'no-store')
    return reply.send(data)
  })

  // ---------- 预览环境运行时错误（供后台控制台与 AI 读取） ----------
  app.post('/__platform/api/dev/errors', async (req) => {
    const { appId, channel } = req.appCtx!
    if (channel === 'prod')
      return ok({})
    const entries = Array.isArray((req.body as any)?.entries) ? (req.body as any).entries.slice(0, 50) : []
    for (const e of entries)
      await pushDevError(appId, { kind: String(e.kind ?? 'js'), message: String(e.message ?? ''), stack: e.stack ? String(e.stack).slice(0, 4000) : undefined, file: e.file, line: e.line })
    return ok({})
  })

  // 平台前端运行时（dom.js / ui.js / ui.css / tailwind.js）
  registerPlatformAssets(app)
}
