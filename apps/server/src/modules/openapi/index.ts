import { createHash } from 'node:crypto'
import { type CollectionDef, type DataEnv, fieldsToJsonSchema, normalizeQuery } from '@app-platform/shared'
import { effectiveManifest } from '../../core/apps'
import Ajv from 'ajv'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Document, Filter } from 'mongodb'
import { z } from 'zod'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { appCollection, col, type ApiClientDoc } from '../../lib/mongo'
import { rateLimit } from '../../lib/store'
import { newId } from '../../lib/tokens'
import { ensureIndexes } from '../gateway/data'

const ajv = new Ajv({ allErrors: true, strict: false })
const OPEN_API_PREFIX = '/open-api/v1'

type Scope = ApiClientDoc['scopes'][number]

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

interface Ctx {
  client: ApiClientDoc
  appId: string
  env: DataEnv
}

function requireScope(client: ApiClientDoc, scope: Scope) {
  if (!client.scopes.includes(scope))
    throw err.forbidden(`该 token 没有 ${scope} 权限`)
}

async function authenticate(req: FastifyRequest): Promise<ApiClientDoc> {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token)
    throw err.login('缺少 Authorization: Bearer <token>')
  const client = await col.apiClients.findOne({ tokenHash: sha256(token) })
  if (!client || client.revokedAt)
    throw err.login('token 无效或已吊销')
  if (client.allowedIps?.length && !client.allowedIps.includes(req.ip))
    throw err.forbidden('调用来源 IP 不在白名单内')
  if (!await rateLimit(`openapi:${client._id}`, 600, 60))
    throw err.rate()
  void col.apiClients.updateOne({ _id: client._id }, { $set: { lastUsedAt: new Date() } })
  return client
}

async function context(req: FastifyRequest, scope: Scope): Promise<Ctx> {
  const client = await authenticate(req)
  requireScope(client, scope)
  const { appId } = req.params as { appId?: string }
  if (!appId)
    throw err.invalid('缺少 appId')
  if (!client.appIds.includes('*') && !client.appIds.includes(appId))
    throw err.forbidden('该 token 不能访问这个应用')
  const env = z.enum(['dev', 'prod']).parse((req.query as { env?: string }).env ?? 'prod')
  if (env === 'dev')
    requireScope(client, 'dev')
  const app = await col.apps.findOne({ _id: appId })
  if (!app || app.status === 'deleted')
    throw err.notFound('应用不存在')
  return { client, appId, env }
}

async function collectionDef(appId: string, env: DataEnv, name: string): Promise<CollectionDef> {
  const manifest = await effectiveManifest(appId, env)
  const def = manifest?.collections[name]
  if (!def)
    throw err.notFound(`集合 ${name} 未声明`)
  return def
}

function record(ctx: Ctx, action: string, detail: Record<string, unknown>) {
  audit(`client:${ctx.client._id}`, action, ctx.appId, { ...detail, env: ctx.env, client: ctx.client.name })
}

export function registerOpenApi(app: FastifyInstance) {
  // 机器可读文档，不需要鉴权
  app.get(`${OPEN_API_PREFIX}/openapi.json`, async () => OPENAPI_SPEC)

  app.get(`${OPEN_API_PREFIX}/apps`, async (req) => {
    const client = await authenticate(req)
    requireScope(client, 'read')
    const filter = client.appIds.includes('*') ? { status: { $ne: 'deleted' as const } } : { _id: { $in: client.appIds }, status: { $ne: 'deleted' as const } }
    const apps = await col.apps.find(filter, { projection: { name: 1, status: 1, prodBuildId: 1, updatedAt: 1, schedule: 1 } }).sort({ updatedAt: -1 }).toArray()
    return ok({ apps: apps.map(a => ({ appId: a._id, name: a.name, status: a.status, published: Boolean(a.prodBuildId), updatedAt: a.updatedAt })) })
  })

  app.get(`${OPEN_API_PREFIX}/apps/:appId`, async (req) => {
    const ctx = await context(req, 'read')
    const app = await col.apps.findOne({ _id: ctx.appId })
    if (!app)
      throw err.notFound('应用不存在')
    const release = app.prodReleaseId ? await col.releases.findOne({ _id: app.prodReleaseId }) : null
    return ok({
      appId: app._id,
      name: app.name,
      status: app.status,
      published: Boolean(app.prodBuildId),
      releasedAt: release?.createdAt ?? null,
      manifest: await effectiveManifest(ctx.appId, ctx.env),
    })
  })

  app.get(`${OPEN_API_PREFIX}/apps/:appId/collections`, async (req) => {
    const ctx = await context(req, 'read')
    const manifest = await effectiveManifest(ctx.appId, ctx.env)
    const collections = await Promise.all(Object.entries(manifest?.collections ?? {}).map(async ([name, def]) => ({
      name,
      acl: def.acl,
      description: def.description ?? '',
      fields: def.fields,
      count: await appCollection(ctx.appId, ctx.env, name).estimatedDocumentCount(),
    })))
    return ok({ env: ctx.env, collections })
  })

  app.post(`${OPEN_API_PREFIX}/apps/:appId/collections/:col/query`, async (req) => {
    const ctx = await context(req, 'read')
    const { col: name } = req.params as { col: string }
    await collectionDef(ctx.appId, ctx.env, name)
    let q
    try {
      q = normalizeQuery(req.body)
    }
    catch (e) {
      throw err.invalid((e as Error).message)
    }
    const c = appCollection(ctx.appId, ctx.env, name)
    const [list, total] = await Promise.all([
      c.find(q.where as Filter<Document>)
        .sort(q.orderBy.length ? Object.fromEntries(q.orderBy.map(([f, d]) => [f, d === 'asc' ? 1 : -1])) : { _createdAt: -1 })
        .skip(q.skip).limit(q.limit).toArray(),
      c.countDocuments(q.where as Filter<Document>, { maxTimeMS: 3000 }),
    ])
    record(ctx, 'openapi.query', { collection: name })
    return ok({ list, total })
  })

  app.get(`${OPEN_API_PREFIX}/apps/:appId/collections/:col/stats`, async (req) => {
    const ctx = await context(req, 'read')
    const { col: name } = req.params as { col: string }
    const def = await collectionDef(ctx.appId, ctx.env, name)
    const { field, limit } = z.object({
      field: z.string().min(1).max(64),
      limit: z.coerce.number().int().positive().max(100).default(20),
    }).parse(req.query)
    if (!def.fields[field])
      throw err.invalid('分组字段必须在 fields 中声明')
    const groups = await appCollection(ctx.appId, ctx.env, name).aggregate([
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ], { maxTimeMS: 3000 }).toArray()
    record(ctx, 'openapi.stats', { collection: name, field })
    return ok({ field, groups: groups.map(g => ({ value: g._id ?? null, count: g.count })) })
  })

  app.get(`${OPEN_API_PREFIX}/apps/:appId/collections/:col/:id`, async (req) => {
    const ctx = await context(req, 'read')
    const { col: name, id } = req.params as { col: string, id: string }
    await collectionDef(ctx.appId, ctx.env, name)
    const doc = await appCollection<any>(ctx.appId, ctx.env, name).findOne({ _id: id })
    if (!doc)
      throw err.notFound('数据不存在')
    record(ctx, 'openapi.get', { collection: name, id })
    return ok(doc)
  })

  app.post(`${OPEN_API_PREFIX}/apps/:appId/collections/:col`, async (req) => {
    const ctx = await context(req, 'write')
    const { col: name } = req.params as { col: string }
    const def = await collectionDef(ctx.appId, ctx.env, name)
    const { data } = parseBody(z.object({ data: z.record(z.string(), z.unknown()) }), req.body)
    const validate = ajv.compile(fieldsToJsonSchema(def.fields))
    if (!validate(data))
      throw err.invalid(ajv.errorsText(validate.errors, { separator: '；' }))
    await ensureIndexes(ctx.appId, ctx.env, name, def)
    const now = Date.now()
    const doc = { ...data, _id: newId(), _owner: `api:${ctx.client._id}`, _ownerProfile: { nickname: ctx.client.name, avatar: '' }, _createdAt: now, _updatedAt: now }
    try {
      await appCollection<any>(ctx.appId, ctx.env, name).insertOne(doc)
    }
    catch (ex) {
      if ((ex as { code?: number }).code === 11000)
        throw err.duplicate('违反唯一约束，这条数据已经存在')
      throw ex
    }
    record(ctx, 'openapi.create', { collection: name, id: doc._id })
    return ok(doc)
  })

  app.patch(`${OPEN_API_PREFIX}/apps/:appId/collections/:col/:id`, async (req) => {
    const ctx = await context(req, 'write')
    const { col: name, id } = req.params as { col: string, id: string }
    const def = await collectionDef(ctx.appId, ctx.env, name)
    const { data } = parseBody(z.object({ data: z.record(z.string(), z.unknown()) }), req.body)
    const c = appCollection<any>(ctx.appId, ctx.env, name)
    const existing = await c.findOne({ _id: id })
    if (!existing)
      throw err.notFound('数据不存在')
    const next = Object.fromEntries(Object.entries({ ...existing, ...data }).filter(([k, v]) => !k.startsWith('_') && v !== null))
    const validate = ajv.compile(fieldsToJsonSchema(def.fields))
    if (!validate(next))
      throw err.invalid(ajv.errorsText(validate.errors, { separator: '；' }))
    const unset = Object.fromEntries(Object.entries(data).filter(([, v]) => v === null).map(([k]) => [k, '']))
    await c.updateOne({ _id: id }, {
      $set: { ...Object.fromEntries(Object.entries(data).filter(([k, v]) => !k.startsWith('_') && v !== null)), _updatedAt: Date.now() },
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    })
    record(ctx, 'openapi.update', { collection: name, id })
    return ok({})
  })

  app.delete(`${OPEN_API_PREFIX}/apps/:appId/collections/:col/:id`, async (req) => {
    const ctx = await context(req, 'write')
    const { col: name, id } = req.params as { col: string, id: string }
    await collectionDef(ctx.appId, ctx.env, name)
    await appCollection<any>(ctx.appId, ctx.env, name).deleteOne({ _id: id })
    record(ctx, 'openapi.delete', { collection: name, id })
    return ok({})
  })

  app.get(`${OPEN_API_PREFIX}/apps/:appId/collections/:col/export.csv`, async (req, reply) => {
    const ctx = await context(req, 'export')
    const { col: name } = req.params as { col: string }
    const def = await collectionDef(ctx.appId, ctx.env, name)
    const fields = ['_id', '_owner', ...Object.keys(def.fields), '_createdAt']
    const docs = await appCollection(ctx.appId, ctx.env, name).find().sort({ _createdAt: 1 }).limit(50_000).toArray()
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [fields.join(','), ...docs.map(d => fields.map(f => f === '_createdAt' ? cell(new Date(Number((d as any)[f])).toLocaleString('zh-CN')) : cell((d as any)[f])).join(','))]
    record(ctx, 'openapi.export', { collection: name, rows: docs.length })
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${ctx.appId}-${name}-${ctx.env}.csv"`)
      .send(`﻿${lines.join('\n')}`)
  })

  app.get(`${OPEN_API_PREFIX}/apps/:appId/kv/:key`, async (req) => {
    const ctx = await context(req, 'read')
    const { key } = req.params as { key: string }
    const doc = await appCollection<{ _id: string, value: unknown, updatedAt?: number }>(ctx.appId, ctx.env, '_kv_app').findOne({ _id: key })
    if (!doc)
      throw err.notFound('配置不存在')
    return ok({ key, value: doc.value, updatedAt: doc.updatedAt ?? null })
  })
}

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'H5 应用平台 Open API',
    version: '1.0.0',
    description: '服务端到服务端接口。请在请求头带 Authorization: Bearer <token>。默认访问 prod 环境；env=dev 需要 token 具备 dev scope。读接口是管理视角，不过滤 _owner。',
  },
  servers: [{ url: '/open-api/v1' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  },
  security: [{ bearer: [] }],
  paths: {
    '/apps': { get: { summary: '应用列表', responses: { 200: { description: 'ok' } } } },
    '/apps/{appId}': { get: { summary: '应用详情与 manifest', parameters: [{ name: 'appId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } },
    '/apps/{appId}/collections': { get: { summary: '集合列表与条数', responses: { 200: { description: 'ok' } } } },
    '/apps/{appId}/collections/{col}/query': { post: { summary: '查询（where / orderBy / skip / limit）', responses: { 200: { description: 'ok' } } } },
    '/apps/{appId}/collections/{col}/stats': { get: { summary: '按字段分组计数', parameters: [{ name: 'field', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } },
    '/apps/{appId}/collections/{col}/{id}': {
      get: { summary: '单条数据', responses: { 200: { description: 'ok' } } },
      patch: { summary: '更新（需要 write scope）', responses: { 200: { description: 'ok' } } },
      delete: { summary: '删除（需要 write scope）', responses: { 200: { description: 'ok' } } },
    },
    '/apps/{appId}/collections/{col}': { post: { summary: '新增（需要 write scope）', responses: { 200: { description: 'ok' } } } },
    '/apps/{appId}/collections/{col}/export.csv': { get: { summary: '导出 CSV（需要 export scope）', responses: { 200: { description: 'ok' } } } },
    '/apps/{appId}/kv/{key}': { get: { summary: '读取应用级 KV', responses: { 200: { description: 'ok' } } } },
  },
}
