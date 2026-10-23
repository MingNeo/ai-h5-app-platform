import { CAPABILITIES, CAPABILITY_LABELS, isHttpUrl, normalizeOpenApi, parseOpenApiText, specOperations } from '@app-platform/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { invalidateApp } from '../../core/apps'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { col } from '../../lib/mongo'
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
        ...(user.isPlatformAdmin ? { id: b._id, docs: b.docs, upstream: b.upstream ?? '', headers: b.headers ? JSON.stringify(b.headers, null, 2) : '', specText: b.specText || (b.spec ? JSON.stringify(b.spec, null, 2) : '') } : {}),
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
    /** 目录默认请求头（服务令牌等），JSON 对象文本，值可用 env:变量名 */
    headers: z.string().max(4000).default(''),
    /** OpenAPI 3 文档（YAML 或 JSON 文本），留空表示不提供结构化文档 */
    specText: z.string().max(1000000).default(''),
    docs: z.string().max(20000).default(''),
  })
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
      throw err.invalid('请求头需为 JSON 对象，例如 { "X-Token": "env:COUPON_TOKEN" }')
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
    const { specText, headers, upstream, ...body } = parseBody(bizSchema, req.body)
    const stored = readSpec(body.prefix, specText)
    const now = new Date()
    await col.bizApis.insertOne({ _id: newId(), ...body, ...stored, upstream: readUpstream(upstream), headers: readHeaders(headers), createdBy: user._id, createdAt: now, updatedAt: now }).catch((e) => {
      if (e?.code === 11000)
        throw err.duplicate('前缀已存在')
      throw e
    })
    return ok({})
  })
  app.put('/admin-api/biz-apis/:id', async (req) => {
    requirePlatformAdmin(req)
    const { specText, headers, upstream, ...body } = parseBody(bizSchema, req.body)
    const stored = readSpec(body.prefix, specText)
    await col.bizApis.updateOne({ _id: (req.params as { id: string }).id }, { $set: { ...body, ...stored, upstream: readUpstream(upstream), headers: readHeaders(headers), updatedAt: new Date() } })
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
