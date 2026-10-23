import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { type Channel, dataEnvOf } from '@app-platform/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../../config'
import { allowedBizPrefixes, approvedGrants, effectiveManifest, getApp } from '../../core/apps'
import { resolveBizTarget } from '../../core/biz-docs'
import { pushDevError } from '../../core/dev-errors'
import { PREVIEW_COOKIE, previewCookieValue, readPreviewClaims, verifyPreviewTicket } from '../../core/preview-access'
import { blobs } from '../../lib/blob'
import { err } from '../../lib/errors'
import { ok } from '../../lib/http'
import { UPLOAD_MIME } from '../../lib/mime'
import { appCollection, col } from '../../lib/mongo'
import { rateLimit } from '../../lib/store'
import { newId, randomToken } from '../../lib/tokens'
import { countDocs, createDoc, type DataCtx, getDoc, groupDocs, queryDocs, removeDoc, updateDoc } from './data'
import { encodeMock, type Identity, MOCK_COOKIE, resolveIdentity } from './identity'

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

/** 不需要 X-App-SDK 头的路径（sendBeacon、<img>、页面跳转、脚本） */
const NO_SDK_HEADER = new Set(['/__platform/boot.js', '/__platform/preview-auth', '/__platform/api/telemetry'])

/** 不转发给上游的平台 cookie（后台会话、预览票据、预览身份） */
const PLATFORM_COOKIES = new Set(['__Host-app_admin', PREVIEW_COOKIE, MOCK_COOKIE])

/** 转发主站 cookie（sess 等），平台自己的 cookie 全部剔除 */
function forwardCookie(header?: string) {
  if (!header)
    return ''
  return header.split(';').map(s => s.trim()).filter(Boolean)
    .filter((pair) => {
      const i = pair.indexOf('=')
      return i > 0 && !PLATFORM_COOKIES.has(pair.slice(0, i))
    })
    .join('; ')
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
  return { appId: c.appId, env: dataEnvOf(c.channel), manifest, user: id.user }
}

function cookieDomain() {
  return `.${config.baseDomain}`
}

export function registerGateway(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/__platform/'))
      return
    const site = req.site
    if (site?.kind !== 'app')
      throw err.notFound()
    if (req.method === 'OPTIONS')
      return reply.status(403).send()
    const path = req.url.split('?')[0]!
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
    const doc = await getApp(site.appId)
    if (!doc)
      throw err.notFound('应用不存在')
    if (site.channel !== 'prod' && path !== '/__platform/preview-auth' && !readPreviewClaims(req.headers.cookie, site.appId))
      throw err.forbidden('需要预览权限')
    req.appCtx = { appId: site.appId, channel: site.channel }
  })

  // 平台 SDK + 应用配置
  app.get('/__platform/boot.js', async (req, reply) => {
    const { appId, channel } = req.appCtx!
    const [doc, manifest, grants, id] = await Promise.all([getApp(appId), effectiveManifest(appId, channel), approvedGrants(appId), identity(req)])
    const buildId = channel === 'prod' ? doc?.prodBuildId : channel === 'beta' ? doc?.betaBuildId : 'draft'
    const cfg = {
      appId,
      channel,
      version: buildId ?? '0',
      sdkVersion: '1',
      requireLogin: Boolean(manifest?.requireLogin),
      authProvider: config.auth.provider,
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
      identityLocked: id.locked,
    }
    if (!req.headers.cookie?.includes('app_vid='))
      reply.setCookie('app_vid', randomToken(12), { path: '/', maxAge: 365 * 86400, sameSite: 'lax', secure: true })
    return reply
      .headers({ 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
      .send(`window.__APP_CONFIG__=${JSON.stringify(cfg).replace(/</g, '\\u003c')};\n${sdkSource()}`)
  })

  // 后台预览票据换 cookie
  app.get('/__platform/preview-auth', async (req, reply) => {
    const { appId } = req.appCtx!
    const q = req.query as { t?: string, next?: string }
    const claims = verifyPreviewTicket(q.t, appId)
    if (!claims)
      return reply.status(403).type('text/html; charset=utf-8').send('<p>预览链接已过期，请回到后台重新打开</p>')
    reply.setCookie(PREVIEW_COOKIE, previewCookieValue(appId, claims.uid, claims.identity), {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 24 * 3600,
    })
    const next = typeof q.next === 'string' && q.next.startsWith('/') && !q.next.startsWith('//') ? q.next : '/'
    return reply.redirect(next)
  })

  app.get('/__platform/api/auth/me', async (req) => {
    const id = await identity(req)
    return ok({ user: id.user, identityLocked: id.locked })
  })

  // 本地 mock 登录：模拟主站在 .<baseDomain> 写入共享 cookie
  app.post('/__platform/api/dev/mock-login', async (req, reply) => {
    if (config.auth.provider !== 'mock')
      throw err.forbidden('当前环境未开启模拟登录')
    const mobile = String((req.body as { mobile?: string })?.mobile ?? '')
    if (!/^1\d{10}$/.test(mobile))
      throw err.invalid('手机号格式不正确')
    const user = { uid: `mock_${mobile.slice(-4)}`, nickname: `用户${mobile.slice(-4)}`, avatar: '' }
    reply.setCookie(MOCK_COOKIE, encodeMock(user), { domain: cookieDomain(), path: '/', secure: true, sameSite: 'lax', maxAge: 30 * 86400 })
    return ok({ user })
  })

  app.post('/__platform/api/dev/mock-logout', async (_req, reply) => {
    reply.clearCookie(MOCK_COOKIE, { domain: cookieDomain(), path: '/' })
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
    return ok({ fileId, url: `/__platform/api/files/${fileId}`, size, mime: file.mime })
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
    const url = new URL(target.upstream)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${target.upstreamPath}`
    url.search = query

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
}
