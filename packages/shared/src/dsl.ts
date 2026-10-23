/**
 * 应用查询 DSL：SDK 端构造、服务端校验后翻译为 Mongo 过滤条件。
 * 只允许白名单操作符，禁止 $where / $expr / $function / $regex 等。
 */

export const QUERY_OPERATORS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists'] as const
export type QueryOperator = typeof QUERY_OPERATORS[number]

export type Primitive = string | number | boolean | null
export type FieldCondition = Primitive | Partial<Record<QueryOperator, Primitive | Primitive[]>>
export interface Where {
  $and?: Where[]
  $or?: Where[]
  [field: string]: FieldCondition | Where[] | undefined
}

export type OrderBy = Array<[string, 'asc' | 'desc']>

export interface QueryInput {
  where?: Where
  orderBy?: OrderBy
  limit?: number
  skip?: number
  /** 只查自己的数据 */
  mine?: boolean
  /** 只返回这些字段 */
  fields?: string[]
}

export const QUERY_LIMIT_MAX = 100
export const QUERY_SKIP_MAX = 5000
const MAX_DEPTH = 3
const MAX_CONDITIONS = 30
const MAX_IN_ITEMS = 100

const FIELD_PATH_RE = /^(?:_id|_owner|_createdAt|_updatedAt|[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+){0,3})$/

export class DslError extends Error {}

function isPrimitive(v: unknown): v is Primitive {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

/** 校验 where，返回其中用到的字段集合；不合法时抛 DslError */
export function validateWhere(where: unknown): Set<string> {
  const fields = new Set<string>()
  let count = 0
  const walk = (node: unknown, depth: number) => {
    if (depth > MAX_DEPTH)
      throw new DslError(`查询条件嵌套过深（最多 ${MAX_DEPTH} 层）`)
    if (typeof node !== 'object' || node === null || Array.isArray(node))
      throw new DslError('where 必须是对象')
    for (const [key, value] of Object.entries(node)) {
      if (key === '$and' || key === '$or') {
        if (!Array.isArray(value) || value.length === 0 || value.length > 20)
          throw new DslError(`${key} 必须是 1–20 个条件组成的数组`)
        for (const sub of value)
          walk(sub, depth + 1)
        continue
      }
      if (key.startsWith('$'))
        throw new DslError(`不支持的操作符 ${key}`)
      if (!FIELD_PATH_RE.test(key))
        throw new DslError(`非法字段名 ${key}`)
      fields.add(key)
      if (++count > MAX_CONDITIONS)
        throw new DslError(`查询条件过多（最多 ${MAX_CONDITIONS} 个）`)
      if (isPrimitive(value))
        continue
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new DslError(`字段 ${key} 的条件只能是基础值或操作符对象`)
      const ops = Object.entries(value)
      if (!ops.length)
        throw new DslError(`字段 ${key} 的条件不能为空对象`)
      for (const [op, v] of ops) {
        if (!(QUERY_OPERATORS as readonly string[]).includes(op))
          throw new DslError(`不支持的操作符 ${op}`)
        if (op === '$in' || op === '$nin') {
          if (!Array.isArray(v) || v.length > MAX_IN_ITEMS || !v.every(isPrimitive))
            throw new DslError(`${op} 需要不超过 ${MAX_IN_ITEMS} 个基础值组成的数组`)
        }
        else if (op === '$exists') {
          if (typeof v !== 'boolean')
            throw new DslError('$exists 需要布尔值')
        }
        else if (!isPrimitive(v)) {
          throw new DslError(`${op} 需要基础值`)
        }
      }
    }
  }
  if (where !== undefined)
    walk(where, 1)
  return fields
}

export interface NormalizedQuery {
  where: Where
  orderBy: OrderBy
  limit: number
  skip: number
  mine: boolean
  fields?: string[]
  /** where 与 orderBy 中用到的字段 */
  usedFields: Set<string>
  sortFields: string[]
}

export function normalizeQuery(input: unknown): NormalizedQuery {
  const q = (input ?? {}) as QueryInput
  if (typeof q !== 'object' || Array.isArray(q))
    throw new DslError('查询参数必须是对象')
  const usedFields = validateWhere(q.where)
  const orderBy: OrderBy = []
  if (q.orderBy !== undefined) {
    if (!Array.isArray(q.orderBy) || q.orderBy.length > 3)
      throw new DslError('orderBy 最多 3 个字段')
    for (const item of q.orderBy) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || !FIELD_PATH_RE.test(item[0]) || !['asc', 'desc'].includes(item[1]))
        throw new DslError('orderBy 格式应为 [["字段", "asc"|"desc"]]')
      orderBy.push([item[0], item[1]])
    }
  }
  const limit = q.limit === undefined ? 20 : Number(q.limit)
  const skip = q.skip === undefined ? 0 : Number(q.skip)
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_LIMIT_MAX)
    throw new DslError(`limit 需在 1–${QUERY_LIMIT_MAX} 之间`)
  if (!Number.isInteger(skip) || skip < 0 || skip > QUERY_SKIP_MAX)
    throw new DslError(`skip 需在 0–${QUERY_SKIP_MAX} 之间`)
  let fields: string[] | undefined
  if (q.fields !== undefined) {
    if (!Array.isArray(q.fields) || q.fields.length > 50 || !q.fields.every(f => typeof f === 'string' && FIELD_PATH_RE.test(f)))
      throw new DslError('fields 需为字段名数组')
    fields = q.fields
  }
  return {
    where: (q.where ?? {}) as Where,
    orderBy,
    limit,
    skip,
    mine: Boolean(q.mine),
    fields,
    usedFields,
    sortFields: orderBy.map(o => o[0]),
  }
}

/** 文档数据里禁止以 $ 开头或包含 . 的 key（防 NoSQL 注入） */
export function assertSafeDocument(value: unknown, path = ''): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafeDocument(v, `${path}[${i}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.'))
        throw new DslError(`非法字段名 ${path ? `${path}.` : ''}${k}`)
      assertSafeDocument(v, path ? `${path}.${k}` : k)
    }
  }
}
