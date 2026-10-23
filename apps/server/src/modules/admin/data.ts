import { type CollectionDef, type DataEnv, fieldsToJsonSchema, normalizeQuery } from '@app-platform/shared'
import Ajv from 'ajv'
import type { FastifyInstance } from 'fastify'
import type { Document, Filter } from 'mongodb'
import { z } from 'zod'
import { draftManifest, effectiveManifest } from '../../core/apps'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { appCollection } from '../../lib/mongo'
import { newId } from '../../lib/tokens'
import { ensureIndexes } from '../gateway/data'
import { requireAppRole } from './auth'

const envSchema = z.enum(['dev', 'prod'])
const ajv = new Ajv({ allErrors: true, strict: false })

async function collectionsFor(appId: string, env: DataEnv) {
  const m = env === 'dev' ? (await draftManifest(appId)).manifest : await effectiveManifest(appId, 'prod')
  return m?.collections ?? {}
}

async function defOf(appId: string, env: DataEnv, name: string): Promise<CollectionDef> {
  const def = (await collectionsFor(appId, env))[name]
  if (!def)
    throw err.notFound(`集合 ${name} 未声明`)
  return def
}

function csvCell(v: unknown) {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function registerDataRoutes(app: FastifyInstance) {
  app.get('/admin-api/apps/:appId/data/:env/collections', async (req) => {
    const { appId, env } = req.params as { appId: string, env: string }
    await requireAppRole(req, appId, 'viewer')
    const e = envSchema.parse(env)
    const cols = await collectionsFor(appId, e)
    const result = await Promise.all(Object.entries(cols).map(async ([name, def]) => ({
      name,
      acl: def.acl,
      description: def.description ?? '',
      fields: def.fields,
      count: await appCollection(appId, e, name).estimatedDocumentCount(),
    })))
    const kvApp = await appCollection<{ _id: string, value: unknown, updatedAt?: number }>(appId, e, '_kv_app').find().limit(200).toArray()
    return ok({ collections: result, kvApp: kvApp.map(k => ({ key: k._id, value: k.value, updatedAt: k.updatedAt })) })
  })

  app.post('/admin-api/apps/:appId/data/:env/:col/query', async (req) => {
    const { appId, env, col } = req.params as { appId: string, env: string, col: string }
    await requireAppRole(req, appId, 'viewer')
    const e = envSchema.parse(env)
    await defOf(appId, e, col)
    let q
    try {
      q = normalizeQuery(req.body)
    }
    catch (ex) {
      throw err.invalid((ex as Error).message)
    }
    const c = appCollection(appId, e, col)
    const [list, total] = await Promise.all([
      c.find(q.where as Filter<Document>).sort(q.orderBy.length ? Object.fromEntries(q.orderBy.map(([f, d]) => [f, d === 'asc' ? 1 : -1])) : { _createdAt: -1 }).skip(q.skip).limit(q.limit).toArray(),
      c.countDocuments(q.where as Filter<Document>, { maxTimeMS: 3000 }),
    ])
    return ok({ list, total })
  })

  app.post('/admin-api/apps/:appId/data/:env/:col', async (req) => {
    const { appId, env, col } = req.params as { appId: string, env: string, col: string }
    const e = envSchema.parse(env)
    const { user } = await requireAppRole(req, appId, e === 'prod' ? 'owner' : 'developer')
    const def = await defOf(appId, e, col)
    const { data } = parseBody(z.object({ data: z.record(z.string(), z.unknown()) }), req.body)
    const v = ajv.compile(fieldsToJsonSchema(def.fields))
    if (!v(data))
      throw err.invalid(ajv.errorsText(v.errors, { separator: '；' }))
    await ensureIndexes(appId, e, col, def)
    const now = Date.now()
    const doc = { ...data, _id: newId(), _owner: `admin:${user._id}`, _ownerProfile: { nickname: user.name, avatar: user.avatar }, _createdAt: now, _updatedAt: now }
    await appCollection<any>(appId, e, col).insertOne(doc)
    audit(user._id, 'data.create', appId, { env: e, col, id: doc._id })
    return ok(doc)
  })

  app.patch('/admin-api/apps/:appId/data/:env/:col/:id', async (req) => {
    const { appId, env, col, id } = req.params as { appId: string, env: string, col: string, id: string }
    const e = envSchema.parse(env)
    const { user } = await requireAppRole(req, appId, e === 'prod' ? 'owner' : 'developer')
    const def = await defOf(appId, e, col)
    const { data } = parseBody(z.object({ data: z.record(z.string(), z.unknown()) }), req.body)
    const c = appCollection<any>(appId, e, col)
    const existing = await c.findOne({ _id: id })
    if (!existing)
      throw err.notFound('数据不存在')
    const merged = Object.fromEntries(Object.entries({ ...existing, ...data }).filter(([k, v]) => !k.startsWith('_') && v !== null))
    const v = ajv.compile(fieldsToJsonSchema(def.fields))
    if (!v(merged))
      throw err.invalid(ajv.errorsText(v.errors, { separator: '；' }))
    const unset = Object.fromEntries(Object.entries(data).filter(([, v]) => v === null).map(([k]) => [k, '']))
    await c.updateOne({ _id: id }, { $set: { ...Object.fromEntries(Object.entries(data).filter(([k, v]) => !k.startsWith('_') && v !== null)), _updatedAt: Date.now() }, ...(Object.keys(unset).length ? { $unset: unset } : {}) })
    audit(user._id, 'data.update', appId, { env: e, col, id })
    return ok({})
  })

  app.delete('/admin-api/apps/:appId/data/:env/:col/:id', async (req) => {
    const { appId, env, col, id } = req.params as { appId: string, env: string, col: string, id: string }
    const e = envSchema.parse(env)
    const { user } = await requireAppRole(req, appId, e === 'prod' ? 'owner' : 'developer')
    await defOf(appId, e, col)
    await appCollection<any>(appId, e, col).deleteOne({ _id: id })
    audit(user._id, 'data.delete', appId, { env: e, col, id })
    return ok({})
  })

  app.get('/admin-api/apps/:appId/data/:env/:col/export', async (req, reply) => {
    const { appId, env, col } = req.params as { appId: string, env: string, col: string }
    const e = envSchema.parse(env)
    const { user } = await requireAppRole(req, appId, 'owner')
    const def = await defOf(appId, e, col)
    const fields = ['_id', '_owner', ...Object.keys(def.fields), '_createdAt']
    const docs = await appCollection(appId, e, col).find().sort({ _createdAt: 1 }).limit(50_000).toArray()
    const lines = [fields.join(','), ...docs.map(d => fields.map(f => f === '_createdAt' ? csvCell(new Date(Number(d[f])).toLocaleString('zh-CN')) : csvCell((d as any)[f])).join(','))]
    audit(user._id, 'data.export', appId, { env: e, col, rows: docs.length })
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${appId}-${col}-${e}.csv"`)
      .send(`﻿${lines.join('\n')}`)
  })

  /** 把 dev 的 readonly 集合数据同步到 prod（覆盖） */
  app.post('/admin-api/apps/:appId/data/sync-readonly', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'owner')
    const { collection } = parseBody(z.object({ collection: z.string() }), req.body)
    const prodDef = await defOf(appId, 'prod', collection)
    if (prodDef.acl !== 'readonly')
      throw err.invalid('只能同步 readonly 集合')
    const docs = await appCollection(appId, 'dev', collection).find().limit(5000).toArray()
    const target = appCollection<any>(appId, 'prod', collection)
    await target.deleteMany({})
    if (docs.length)
      await target.insertMany(docs)
    await ensureIndexes(appId, 'prod', collection, prodDef)
    audit(user._id, 'data.sync', appId, { collection, rows: docs.length })
    return ok({ rows: docs.length })
  })

  // ---------- 应用级 KV（运营配置） ----------
  app.put('/admin-api/apps/:appId/data/:env/kv/:key', async (req) => {
    const { appId, env, key } = req.params as { appId: string, env: string, key: string }
    const e = envSchema.parse(env)
    const { user } = await requireAppRole(req, appId, e === 'prod' ? 'owner' : 'developer')
    if (!/^[\w.:-]{1,64}$/.test(key))
      throw err.invalid('key 只能包含字母、数字和 _ . : -')
    const { value } = parseBody(z.object({ value: z.unknown() }), req.body)
    await appCollection<any>(appId, e, '_kv_app').updateOne({ _id: key }, { $set: { value, updatedAt: Date.now() } }, { upsert: true })
    audit(user._id, 'kv.set', appId, { env: e, key })
    return ok({})
  })

  app.delete('/admin-api/apps/:appId/data/:env/kv/:key', async (req) => {
    const { appId, env, key } = req.params as { appId: string, env: string, key: string }
    const e = envSchema.parse(env)
    const { user } = await requireAppRole(req, appId, e === 'prod' ? 'owner' : 'developer')
    await appCollection<any>(appId, e, '_kv_app').deleteOne({ _id: key })
    audit(user._id, 'kv.delete', appId, { env: e, key })
    return ok({})
  })
}
