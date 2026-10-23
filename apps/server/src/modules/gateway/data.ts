import { type AclRules, type AppManifest, type CollectionDef, type DataEnv, aclRules, assertSafeDocument, DslError, fieldsToJsonSchema, normalizeQuery, SYSTEM_FIELDS } from '@app-platform/shared'
import Ajv, { type ValidateFunction } from 'ajv'
import type { Document, Filter } from 'mongodb'
import { config } from '../../config'
import { pushDevError } from '../../core/dev-errors'
import { moderateText } from '../../core/moderation'
import { err } from '../../lib/errors'
import { appCollection } from '../../lib/mongo'
import { rateLimit } from '../../lib/store'
import { newId } from '../../lib/tokens'
import type { AppUser } from './identity'

export interface DataCtx {
  appId: string
  env: DataEnv
  manifest: AppManifest | null
  user: AppUser | null
  /** 访客标识（app_vid cookie），未登录时作为数据归属与限流依据 */
  vid?: string
  ip: string
}

const ajv = new Ajv({ allErrors: true, strict: false })
const validators = new Map<string, ValidateFunction>()
const indexed = new Set<string>()

function validatorFor(def: CollectionDef) {
  const schema = fieldsToJsonSchema(def.fields)
  const key = JSON.stringify(schema)
  let v = validators.get(key)
  if (!v) {
    v = ajv.compile(schema)
    validators.set(key, v)
  }
  return v
}

function ajvMessage(v: ValidateFunction) {
  return (v.errors ?? []).slice(0, 5).map((e) => {
    const field = e.instancePath.replace(/^\//, '') || (e.params as any)?.missingProperty || (e.params as any)?.additionalProperty || '数据'
    if (e.keyword === 'additionalProperties')
      return `字段 ${(e.params as any).additionalProperty} 未在 manifest 中声明`
    if (e.keyword === 'required')
      return `缺少必填字段 ${(e.params as any).missingProperty}`
    return `${field} ${e.message}`
  }).join('；')
}

export function collectionDef(ctx: DataCtx, name: string): CollectionDef {
  const def = ctx.manifest?.collections[name]
  if (!def)
    throw err.notFound(`集合 ${name} 未在 manifest.json 中声明`)
  return def
}

/** 按 manifest 建索引（幂等，进程内按定义去重） */
export async function ensureIndexes(appId: string, env: DataEnv, name: string, def: CollectionDef) {
  const key = `${appId}:${env}:${name}:${JSON.stringify(def.indexes)}`
  if (indexed.has(key))
    return
  const c = appCollection(appId, env, name)
  await c.createIndex({ _owner: 1, _createdAt: -1 })
  await c.createIndex({ _createdAt: -1 })
  for (const idx of def.indexes) {
    try {
      await c.createIndex(idx.fields, { unique: Boolean(idx.unique) })
    }
    catch (e) {
      console.warn(`[data] ${appId}/${env}/${name} 建索引失败`, (e as Error).message)
    }
  }
  indexed.add(key)
}

function indexedFields(def: CollectionDef) {
  const set = new Set<string>(['_id', '_owner', '_createdAt', '_updatedAt'])
  for (const idx of def.indexes) {
    for (const f of Object.keys(idx.fields))
      set.add(f)
  }
  return set
}

/** prod 只允许按声明了索引的字段排序/计数；dev 只告警，提示 AI 补索引 */
async function checkIndexed(ctx: DataCtx, name: string, def: CollectionDef, fields: string[], what: string) {
  const idx = indexedFields(def)
  const missing = fields.filter(f => !idx.has(f))
  if (!missing.length)
    return
  const msg = `集合 ${name} ${what}字段 ${missing.join('、')} 未声明索引，请在 manifest.json 的 indexes 中补充`
  if (ctx.env === 'prod')
    throw err.invalid(msg)
  await pushDevError(ctx.appId, { kind: 'data-warning', message: msg })
}

/** 数据归属：登录用户用 uid，游客用访客 cookie，兜底 IP */
function actorOf(ctx: DataCtx) {
  if (ctx.user)
    return ctx.user.uid
  return ctx.vid ? `vid:${ctx.vid}` : `ip:${ctx.ip}`
}

function readFilter(ctx: DataCtx, def: CollectionDef, mine: boolean): Filter<Document> {
  const rules = aclRules(def.acl)
  if (rules.read === 'none')
    throw err.forbidden('该集合仅后台可见')
  if (rules.read === 'own' || mine) {
    if (!ctx.user && !rules.guestCreate)
      throw err.login()
    return { _owner: actorOf(ctx) }
  }
  if (!ctx.user && !rules.guestRead)
    throw err.login()
  return {}
}

function toDoc(d: Document | null) {
  return d
}

function dsl<T>(fn: () => T): T {
  try {
    return fn()
  }
  catch (e) {
    if (e instanceof DslError)
      throw err.invalid(e.message)
    throw e
  }
}

export async function queryDocs(ctx: DataCtx, name: string, input: unknown) {
  const def = collectionDef(ctx, name)
  const q = dsl(() => normalizeQuery(input))
  const base = readFilter(ctx, def, q.mine)
  await ensureIndexes(ctx.appId, ctx.env, name, def)
  await checkIndexed(ctx, name, def, q.sortFields, '排序')
  const filter = Object.keys(q.where).length ? { $and: [q.where as Document, base] } : base
  const sort = q.orderBy.length ? Object.fromEntries(q.orderBy.map(([f, d]) => [f, d === 'asc' ? 1 : -1])) : { _createdAt: -1 }
  const projection = q.fields ? Object.fromEntries([...q.fields, ...SYSTEM_FIELDS, '_ownerProfile'].map(f => [f, 1])) : undefined
  const list = await appCollection(ctx.appId, ctx.env, name)
    .find(filter, { projection, maxTimeMS: 2000 })
    .sort(sort as any)
    .skip(q.skip)
    .limit(q.limit + 1)
    .toArray()
  return { list: list.slice(0, q.limit), hasMore: list.length > q.limit }
}

export async function countDocs(ctx: DataCtx, name: string, input: unknown) {
  const def = collectionDef(ctx, name)
  const q = dsl(() => normalizeQuery({ ...(input as object), limit: 1 }))
  const base = readFilter(ctx, def, q.mine)
  await ensureIndexes(ctx.appId, ctx.env, name, def)
  await checkIndexed(ctx, name, def, [...q.usedFields], '计数条件')
  const filter = Object.keys(q.where).length ? { $and: [q.where as Document, base] } : base
  const count = await appCollection(ctx.appId, ctx.env, name).countDocuments(filter, { maxTimeMS: 2000 })
  return { count }
}

export async function groupDocs(ctx: DataCtx, name: string, input: unknown) {
  const def = collectionDef(ctx, name)
  const field = (input as { field?: unknown })?.field
  if (typeof field !== 'string' || !def.fields[field])
    throw err.invalid('groupCount 的字段必须在 fields 中声明')
  const q = dsl(() => normalizeQuery({ ...(input as object), field: undefined, limit: 1 }))
  const base = readFilter(ctx, def, q.mine)
  await ensureIndexes(ctx.appId, ctx.env, name, def)
  await checkIndexed(ctx, name, def, [field], '分组')
  const match = Object.keys(q.where).length ? { $and: [q.where as Document, base] } : base
  const groups = await appCollection(ctx.appId, ctx.env, name).aggregate([
    { $match: match },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 100 },
  ], { maxTimeMS: 3000 }).toArray()
  return { groups: groups.map(g => ({ value: g._id ?? null, count: g.count })) }
}

async function validateData(ctx: DataCtx, def: CollectionDef, data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw err.invalid('data 必须是对象')
  dsl(() => assertSafeDocument(data))
  for (const k of Object.keys(data)) {
    if (k.startsWith('_'))
      throw err.invalid(`不能写入系统字段 ${k}`)
  }
  if (Buffer.byteLength(JSON.stringify(data)) > config.limits.docBytes)
    throw err.invalid(`单条数据不能超过 ${config.limits.docBytes / 1024}KB`)
  const v = validatorFor(def)
  if (!v(data))
    throw err.invalid(ajvMessage(v))
  for (const f of def.moderate) {
    const value = (data as Record<string, unknown>)[f]
    if (typeof value === 'string') {
      const r = await moderateText(value, 'ugc')
      if (!r.pass)
        throw err.invalid(r.reason || '内容未通过审核')
    }
  }
}

async function writeLimit(ctx: DataCtx, name: string, def: CollectionDef, uid: string) {
  if (!await rateLimit(`w:${ctx.appId}:${uid}`, config.limits.writesPerMinutePerUser, 60))
    throw err.rate()
  if (def.limits.writesPerMinute && !await rateLimit(`w:${ctx.appId}:${name}:${uid}`, def.limits.writesPerMinute, 60))
    throw err.rate()
}

export async function createDoc(ctx: DataCtx, name: string, data: unknown) {
  const def = collectionDef(ctx, name)
  const rules = aclRules(def.acl)
  if (!rules.create)
    throw err.forbidden('该集合不允许应用端写入')
  if (!ctx.user && !rules.guestCreate)
    throw err.login()
  const actor = actorOf(ctx)
  await validateData(ctx, def, data)
  await writeLimit(ctx, name, def, actor)
  await ensureIndexes(ctx.appId, ctx.env, name, def)
  const c = appCollection(ctx.appId, ctx.env, name)
  if (def.limits.perUserDocs) {
    const n = await c.countDocuments({ _owner: actor }, { limit: def.limits.perUserDocs })
    if (n >= def.limits.perUserDocs)
      throw err.quota(`每人最多 ${def.limits.perUserDocs} 条`)
  }
  const now = Date.now()
  const doc = {
    ...(data as object),
    _id: newId(),
    _owner: actor,
    _ownerProfile: ctx.user ? { nickname: ctx.user.nickname, avatar: ctx.user.avatar } : { nickname: '游客', avatar: '' },
    _createdAt: now,
    _updatedAt: now,
  }
  try {
    await c.insertOne(doc as any)
  }
  catch (e: any) {
    if (e?.code === 11000)
      throw err.duplicate('数据已存在（违反唯一约束）')
    throw e
  }
  return doc
}

export async function getDoc(ctx: DataCtx, name: string, id: string) {
  const def = collectionDef(ctx, name)
  const base = readFilter(ctx, def, false)
  const doc = await appCollection(ctx.appId, ctx.env, name).findOne({ ...base, _id: id } as any)
  if (!doc)
    throw err.notFound('数据不存在')
  return toDoc(doc)
}

async function ownDoc(ctx: DataCtx, name: string, id: string, rules: AclRules) {
  if (!ctx.user && !rules.guestCreate)
    throw err.login()
  const actor = actorOf(ctx)
  const doc = await appCollection(ctx.appId, ctx.env, name).findOne({ _id: id } as any)
  if (!doc)
    throw err.notFound('数据不存在')
  if (doc._owner !== actor)
    throw err.forbidden('只能修改自己创建的数据')
  return { doc, actor }
}

export async function updateDoc(ctx: DataCtx, name: string, id: string, patch: unknown) {
  const def = collectionDef(ctx, name)
  const rules = aclRules(def.acl)
  if (!rules.update)
    throw err.forbidden('该集合的数据创建后不能修改')
  const { doc, actor } = await ownDoc(ctx, name, id, rules)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw err.invalid('data 必须是对象')
  const merged: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) {
    if (!k.startsWith('_'))
      merged[k] = v
  }
  Object.assign(merged, patch)
  for (const [k, v] of Object.entries(merged)) {
    if (v === null || v === undefined)
      delete merged[k]
  }
  await validateData(ctx, def, merged)
  await writeLimit(ctx, name, def, actor)
  const now = Date.now()
  const unset = Object.fromEntries(Object.entries(patch as object).filter(([, v]) => v === null || v === undefined).map(([k]) => [k, '']))
  const set = Object.fromEntries(Object.entries(patch as object).filter(([, v]) => v !== null && v !== undefined))
  try {
    await appCollection(ctx.appId, ctx.env, name).updateOne(
      { _id: id, _owner: actor } as any,
      { $set: { ...set, _updatedAt: now }, ...(Object.keys(unset).length ? { $unset: unset } : {}) } as any,
    )
  }
  catch (e: any) {
    if (e?.code === 11000)
      throw err.duplicate('数据已存在（违反唯一约束）')
    throw e
  }
  return { ...doc, ...set, _updatedAt: now }
}

export async function removeDoc(ctx: DataCtx, name: string, id: string) {
  const def = collectionDef(ctx, name)
  const rules = aclRules(def.acl)
  if (!rules.remove)
    throw err.forbidden('该集合的数据创建后不能删除')
  const { actor } = await ownDoc(ctx, name, id, rules)
  await writeLimit(ctx, name, def, actor)
  await appCollection(ctx.appId, ctx.env, name).deleteOne({ _id: id, _owner: actor } as any)
  return { ok: true }
}
