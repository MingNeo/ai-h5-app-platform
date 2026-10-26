import { CAPABILITIES, CAPABILITY_LABELS, checkHeaderValues, HTTP_METHODS, isHttpUrl, normalizeOpenApi, parseOpenApiText, rewriteBizPath, specOperations } from '@app-platform/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { invalidateApp } from '../../core/apps'
import { buildUpstreamUrl, resolveHeaders } from '../../core/biz-docs'
import { config } from '../../config'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { col } from '../../lib/mongo'
import { rateLimit } from '../../lib/store'
import { newId } from '../../lib/tokens'
import { notifyFeishu } from '../build/notify'
import { requireAdmin, requirePerm, requirePlatformAdmin } from './auth'

export function registerGrantRoutes(app: FastifyInstance) {
  app.get('/admin-api/catalog', async (req) => {
    const user = requireAdmin(req)
    const biz = await col.bizApis.find().sort({ prefix: 1 }).toArray()
    return ok({
      capabilities: CAPABILITIES.map(key => ({ key, label: CAPABILITY_LABELS[key] ?? key })),
      // 只有平台管理员能编辑目录，其他人不需要文档内容
      bizApis: biz.map(b => ({
        prefix: b.prefix,
        title: b.title,
        description: b.description,
        operations: b.spec ? specOperations(b.spec).length : 0,
        ...(user.isPlatformAdmin
          ? {
              id: b._id,
              docs: b.docs,
              upstream: b.upstream ?? '',
              headers: b.headers ? JSON.stringify(b.headers, null, 2) : '',
              specText: b.specText || (b.spec ? JSON.stringify(b.spec, null, 2) : ''),
              // 密钥值从不返回，只告诉前端有哪些名字可以引用
              secretNames: Object.keys(b.secrets ?? {}),
            }
          : {}),
      })),
    })
  })

  app.post('/admin-api/apps/:appId/grants', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requirePerm(req, appId, 'app.edit')
    const body = parseBody(z.object({ type: z.enum(['capability', 'biz']), key: z.string().min(1).max(200), reason: z.string().trim().min(2).max(500) }), req.body)
    if (body.type === 'capability' && !CAPABILITIES.includes(body.key))
      throw err.invalid('未知能力')
    if (body.type === 'biz' && !await col.bizApis.findOne({ prefix: body.key }))
      throw err.invalid('业务接口不在目录中')
    const exists = await col.grants.findOne({ appId, type: body.type, key: body.key, status: { $in: ['pending', 'approved'] } })
    if (exists)
      throw err.duplicate(exists.status === 'approved' ? '已开通' : '已在审批中')
    await col.grants.insertOne({ _id: newId(), appId, type: body.type, key: body.key, status: 'pending', reason: body.reason, requestedBy: user._id, createdAt: new Date() })
    audit(user._id, 'grant.request', appId, body)
    void notifyFeishu(`【能力申请】${appId} 申请 ${body.key}：${body.reason}`)
    return ok({})
  })

  app.get('/admin-api/grants', async (req) => {
    requirePlatformAdmin(req)
    const status = (req.query as { status?: string }).status ?? 'pending'
    const list = await col.grants.find(status === 'all' ? {} : { status: status as any }).sort({ createdAt: -1 }).limit(200).toArray()
    const users = await col.adminUsers.find({ _id: { $in: [...new Set(list.map(g => g.requestedBy))] } }, { projection: { name: 1 } }).toArray()
    const names = new Map(users.map(u => [u._id, u.name]))
    return ok(list.map(g => ({ ...g, id: g._id, requestedByName: names.get(g.requestedBy) ?? g.requestedBy })))
  })

  app.post('/admin-api/grants/:id/review', async (req) => {
    const user = requirePlatformAdmin(req)
    const { id } = req.params as { id: string }
    const body = parseBody(z.object({ approve: z.boolean(), note: z.string().max(500).default('') }), req.body)
    const g = await col.grants.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: body.approve ? 'approved' : 'rejected', reviewedBy: user._id, reviewNote: body.note, reviewedAt: new Date() } }, { returnDocument: 'after' })
    if (!g)
      throw err.notFound('申请不存在或已处理')
    invalidateApp(g.appId)
    audit(user._id, body.approve ? 'grant.approve' : 'grant.reject', g.appId, { key: g.key })
    return ok({})
  })

  app.post('/admin-api/grants/:id/revoke', async (req) => {
    const user = requirePlatformAdmin(req)
    const { id } = req.params as { id: string }
    const g = await col.grants.findOneAndUpdate({ _id: id, status: 'approved' }, { $set: { status: 'rejected', reviewedBy: user._id, reviewNote: '已撤销', reviewedAt: new Date() } })
    if (!g)
      throw err.notFound('授权不存在')
    invalidateApp(g.appId)
    audit(user._id, 'grant.revoke', g.appId, { key: g.key })
    return ok({})
  })

  // ---------- 业务接口目录（平台管理员维护） ----------
  const bizSchema = z.object({
    prefix: z.string().regex(/^\/[\w\-./]*\/$/, '前缀需以 / 开头并以 / 结尾，例如 /api/coupon/'),
    title: z.string().trim().min(1).max(50),
    description: z.string().max(500).default(''),
    /** 目录默认上游，例如 http://coupon-service.internal:8080；留空则用 BIZ_API_ORIGIN */
    upstream: z.string().trim().max(500).default(''),
    /** 目录默认请求头（服务令牌等），JSON 对象文本，值可用 env:变量名 / secret:密钥名 */
    headers: z.string().max(4000).default(''),
    /** OpenAPI 3 文档（YAML 或 JSON 文本），留空表示不提供结构化文档 */
    specText: z.string().max(1000000).default(''),
    docs: z.string().max(20000).default(''),
    /** 密钥补丁：字符串表示新增/替换，null 表示删除；没提到的密钥保留原值 */
    secrets: z.record(z.string(), z.string().max(4000).nullable()).optional(),
  })
  const SECRET_NAME_RE = /^[A-Za-z0-9_]{1,64}$/
  /** 按补丁合并密钥：旧值 + 本次新增/替换 - 本次删除 */
  function applySecretPatch(existing: Record<string, string> | undefined, patch?: Record<string, string | null>) {
    if (!patch)
      return existing
    const out = { ...(existing ?? {}) }
    for (const [name, value] of Object.entries(patch)) {
      if (!SECRET_NAME_RE.test(name))
        throw err.invalid(`密钥名 ${name} 只能包含字母、数字、下划线`)
      if (value === null) {
        delete out[name]
        continue
      }
      if (!value.trim())
        throw err.invalid(`密钥 ${name} 的值不能为空`)
      out[name] = value
    }
    return Object.keys(out).length ? out : undefined
  }
  /** 请求头不能写明文密钥：目录级 + 每个接口的 x-upstream-headers 都要核对 */
  function checkHeaders(headers: Record<string, string> | undefined, spec: ReturnType<typeof readSpec>['spec'], secretNames: string[]) {
    const errors = checkHeaderValues(headers, secretNames, '目录请求头')
    if (spec) {
      for (const op of specOperations(spec))
        errors.push(...checkHeaderValues(op.headers, secretNames, `${op.method.toUpperCase()} ${op.path} 的请求头`))
    }
    if (errors.length)
      throw err.invalid(errors[0]!)
  }
  /** 解析并校验文档，返回要存储的内容（解析结果 + 原始文本，便于原样再编辑） */
  function readSpec(prefix: string, text: string) {
    if (!text.trim())
      return { spec: undefined, specText: '' }
    const parsed = parseOpenApiText(text)
    if (!parsed.ok)
      throw err.invalid(parsed.errors[0]!)
    const res = normalizeOpenApi(parsed.doc, prefix)
    if (!res.ok)
      throw err.invalid(`接口文档不符合 OpenAPI 3：\n${res.errors.slice(0, 5).join('\n')}`)
    return { spec: res.spec, specText: text }
  }
  function readHeaders(text: string) {
    if (!text.trim())
      return undefined
    let json: unknown
    try {
      json = JSON.parse(text)
    }
    catch {
      throw err.invalid('请求头需为 JSON 对象，例如 { "X-Token": "secret:coupon_token" }')
    }
    if (!json || typeof json !== 'object' || Array.isArray(json) || Object.values(json).some(v => typeof v !== 'string'))
      throw err.invalid('请求头需为 JSON 对象，值为字符串')
    const entries = Object.entries(json as Record<string, string>).filter(([k]) => /^[A-Za-z0-9-]+$/.test(k))
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  function readUpstream(url: string) {
    if (!url)
      return undefined
    if (!isHttpUrl(url))
      throw err.invalid('上游地址需为 http/https，例如 http://coupon-service.internal:8080')
    return url.replace(/\/+$/, '')
  }
  app.post('/admin-api/biz-apis', async (req) => {
    const user = requirePlatformAdmin(req)
    const { specText, headers, upstream, secrets: secretsPatch, ...body } = parseBody(bizSchema, req.body)
    const stored = readSpec(body.prefix, specText)
    const secrets = applySecretPatch(undefined, secretsPatch)
    const parsedHeaders = readHeaders(headers)
    checkHeaders(parsedHeaders, stored.spec, Object.keys(secrets ?? {}))
    const now = new Date()
    await col.bizApis.insertOne({ _id: newId(), ...body, ...stored, upstream: readUpstream(upstream), headers: parsedHeaders, secrets, createdBy: user._id, createdAt: now, updatedAt: now }).catch((e) => {
      if (e?.code === 11000)
        throw err.duplicate('前缀已存在')
      throw e
    })
    return ok({})
  })
  app.put('/admin-api/biz-apis/:id', async (req) => {
    requirePlatformAdmin(req)
    const { id } = req.params as { id: string }
    const existing = await col.bizApis.findOne({ _id: id })
    if (!existing)
      throw err.notFound('接口目录不存在')
    const { specText, headers, upstream, secrets: secretsPatch, ...body } = parseBody(bizSchema, req.body)
    const stored = readSpec(body.prefix, specText)
    const secrets = applySecretPatch(existing.secrets, secretsPatch)
    const parsedHeaders = readHeaders(headers)
    checkHeaders(parsedHeaders, stored.spec, Object.keys(secrets ?? {}))
    await col.bizApis.updateOne({ _id: id }, { $set: { ...body, ...stored, upstream: readUpstream(upstream), headers: parsedHeaders, secrets, updatedAt: new Date() } })
    return ok({})
  })
  app.delete('/admin-api/biz-apis/:id', async (req) => {
    requirePlatformAdmin(req)
    await col.bizApis.deleteOne({ _id: (req.params as { id: string }).id })
    return ok({})
  })
  /** 保存前校验接口文档（YAML 或 JSON），返回其中的接口数量 */
  app.post('/admin-api/biz-apis/validate', async (req) => {
    requirePlatformAdmin(req)
    const body = parseBody(z.object({ prefix: bizSchema.shape.prefix, specText: z.string().max(1000000) }), req.body)
    const { spec } = readSpec(body.prefix, body.specText)
    return ok({ operations: spec ? specOperations(spec).length : 0 })
  })
  /** 连通性测试：按当前编辑内容（不要求已保存）代发一次真实请求，密钥只在服务器内解析，不回传 */
  app.post('/admin-api/biz-apis/test', async (req) => {
    const user = requirePlatformAdmin(req)
    if (!await rateLimit(`biz-test:${user._id}`, 30, 60))
      throw err.rate()
    const body = parseBody(z.object({
      id: z.string().optional(),
      prefix: bizSchema.shape.prefix,
      upstream: z.string().trim().max(500).default(''),
      headers: z.string().max(4000).default(''),
      specText: z.string().max(1000000),
      method: z.enum(HTTP_METHODS),
      path: z.string().min(1).max(500),
      pathParams: z.record(z.string(), z.string()).default({}),
      query: z.record(z.string(), z.string()).default({}),
      body: z.string().max(100000).default(''),
      cookie: z.string().max(4000).default(''),
    }), req.body)

    const parsed = parseOpenApiText(body.specText)
    if (!parsed.ok)
      throw err.invalid(parsed.errors[0]!)
    const norm = normalizeOpenApi(parsed.doc, body.prefix)
    if (!norm.ok)
      throw err.invalid(norm.errors[0]!)
    const op = specOperations(norm.spec).find(o => o.method === body.method && o.path === body.path)
    if (!op)
      throw err.invalid('接口不存在，请先在上面保存这条编辑')

    const secrets = body.id ? (await col.bizApis.findOne({ _id: body.id }, { projection: { secrets: 1 } }))?.secrets : undefined
    const catalogUpstream = body.upstream ? readUpstream(body.upstream) : undefined
    const upstream = op.upstream ?? catalogUpstream ?? config.biz.origin
    if (!upstream)
      throw err.invalid('没有配置上游地址')

    let path = body.path
    for (const [k, v] of Object.entries(body.pathParams))
      path = path.replace(`{${k}}`, encodeURIComponent(v))
    const upstreamPath = rewriteBizPath(op, path)
    const headers: Record<string, string> = { ...resolveHeaders(readHeaders(body.headers), secrets), ...resolveHeaders(op.headers, secrets) }
    if (body.cookie)
      headers.cookie = body.cookie
    const hasBody = Boolean(body.body.trim()) && body.method !== 'get' && body.method !== 'delete'
    if (hasBody)
      headers['content-type'] = 'application/json'

    const url = buildUpstreamUrl(upstream, upstreamPath, new URLSearchParams(body.query).toString())
    const startedAt = Date.now()
    try {
      const upstreamRes = await fetch(url, {
        method: body.method.toUpperCase(),
        headers,
        body: hasBody ? body.body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.biz.timeoutMs),
      })
      const buf = Buffer.from(await upstreamRes.arrayBuffer())
      const truncated = buf.length > config.biz.testMaxBodyBytes
      audit(user._id, 'biz-apis.test', body.prefix, { method: body.method, path: body.path })
      return ok({
        ok: true,
        status: upstreamRes.status,
        durationMs: Date.now() - startedAt,
        contentType: upstreamRes.headers.get('content-type') ?? '',
        body: (truncated ? buf.subarray(0, config.biz.testMaxBodyBytes) : buf).toString('utf8'),
        truncated,
        url: url.toString(),
      })
    }
    catch (e) {
      const timeout = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError'
      return ok({ ok: false, error: timeout ? '请求超时' : `请求失败：${(e as Error).message}`, url: url.toString(), durationMs: Date.now() - startedAt })
    }
  })

  app.get('/admin-api/audit', async (req) => {
    const q = req.query as { appId?: string }
    if (q.appId)
      await requirePerm(req, q.appId, 'console.view')
    else requirePlatformAdmin(req)
    const list = await col.audit.find(q.appId ? { appId: q.appId } : {}).sort({ createdAt: -1 }).limit(200).toArray()
    const users = await col.adminUsers.find({ _id: { $in: [...new Set(list.map(a => a.actor))] } }, { projection: { name: 1 } }).toArray()
    const names = new Map(users.map(u => [u._id, u.name]))
    return ok(list.map(a => ({ ...a, actorName: names.get(a.actor) ?? a.actor })))
  })
}
