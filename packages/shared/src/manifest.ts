import { z } from 'zod'

export const ACL_PRESETS = ['private', 'public_read', 'submit_only', 'readonly', 'admin_only'] as const
export type AclPreset = typeof ACL_PRESETS[number]

export const ACL_DESCRIPTIONS: Record<AclPreset, string> = {
  private: '仅本人可读写',
  public_read: '所有人可读（含游客），本人可增删改',
  submit_only: '本人可提交、可读自己的，不能修改',
  readonly: '所有人可读，仅后台可写',
  admin_only: '应用端不可访问，仅后台可见',
}

/** ACL 越靠后对外越开放，用于发布审批时识别「权限放宽」 */
export const ACL_OPENNESS: Record<AclPreset, number> = {
  admin_only: 0,
  private: 1,
  submit_only: 1,
  readonly: 2,
  public_read: 3,
}

/** 可申请的平台能力注册表（平台内建，不走 HTTP；业务接口走 bizApis） */
export const CAPABILITIES: readonly string[] = []
export type Capability = string

/** 能力的中文名，未登记时直接显示 key */
export const CAPABILITY_LABELS: Partial<Record<string, string>> = {}

export const COLLECTION_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,47}$/
export const FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/

const fieldTypeSchema = z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array'])

const fieldDefSchema = z.union([
  fieldTypeSchema,
  z.object({
    type: fieldTypeSchema,
    required: z.boolean().optional(),
    maxLength: z.number().int().positive().max(20000).optional(),
    minLength: z.number().int().nonnegative().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    enum: z.array(z.union([z.string(), z.number()])).max(200).optional(),
    /** array 元素类型 */
    items: fieldTypeSchema.optional(),
    maxItems: z.number().int().positive().max(1000).optional(),
  }).strict(),
])
export type FieldDef = z.infer<typeof fieldDefSchema>

const indexSchema = z.object({
  fields: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])),
  unique: z.boolean().optional(),
}).strict()
export type IndexDef = z.infer<typeof indexSchema>

export const collectionSchema = z.object({
  acl: z.enum(ACL_PRESETS),
  description: z.string().max(200).optional(),
  fields: z.record(z.string(), fieldDefSchema).default({}),
  indexes: z.array(indexSchema).max(8).default([]),
  limits: z.object({
    perUserDocs: z.number().int().positive().max(100000).optional(),
    writesPerMinute: z.number().int().positive().max(600).optional(),
  }).strict().default({}),
  /** 写入前需要过内容安全审核的字符串字段 */
  moderate: z.array(z.string()).default([]),
}).strict()
export type CollectionDef = z.infer<typeof collectionSchema>

export const manifestSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(200).optional(),
  requireLogin: z.boolean().default(false),
  orientation: z.enum(['portrait', 'landscape', 'auto']).default('portrait'),
  capabilities: z.array(z.string()).max(20).default([])
    .refine(keys => keys.every(k => CAPABILITIES.includes(k)), { message: '包含未登记的能力' }),
  /** 业务接口路径前缀（需在后台申请并通过审批） */
  bizApis: z.array(z.string().regex(/^\/[\w\-./]*$/)).max(50).default([]),
  /** 额外使用的白名单依赖 */
  dependencies: z.array(z.string()).default([]),
  collections: z.record(z.string(), collectionSchema).default({}),
}).strict()
export type AppManifest = z.infer<typeof manifestSchema>

export const MANIFEST_FILE = 'manifest.json'

export function parseManifest(input: unknown): { ok: true, manifest: AppManifest } | { ok: false, errors: string[] } {
  const res = manifestSchema.safeParse(input)
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  const errors: string[] = []
  for (const [name, col] of Object.entries(res.data.collections)) {
    if (!COLLECTION_NAME_RE.test(name))
      errors.push(`collections.${name}: 集合名需以小写字母开头，只能包含字母、数字、下划线，最长 48 位`)
    for (const field of Object.keys(col.fields)) {
      if (!FIELD_NAME_RE.test(field))
        errors.push(`collections.${name}.fields.${field}: 字段名需以字母开头，只能包含字母、数字、下划线`)
    }
    for (const m of col.moderate) {
      if (!col.fields[m])
        errors.push(`collections.${name}.moderate: 字段 ${m} 未在 fields 中声明`)
    }
    for (const idx of col.indexes) {
      for (const f of Object.keys(idx.fields)) {
        if (!f.startsWith('_') && !col.fields[f.split('.')[0]!])
          errors.push(`collections.${name}.indexes: 字段 ${f} 未在 fields 中声明`)
        if (f.startsWith('_') && !SYSTEM_FIELDS.includes(f as SystemField))
          errors.push(`collections.${name}.indexes: 未知系统字段 ${f}`)
      }
    }
  }
  if (errors.length)
    return { ok: false, errors }
  return { ok: true, manifest: res.data }
}

export function parseManifestText(text: string) {
  let json: unknown
  try {
    json = JSON.parse(text)
  }
  catch (e) {
    return { ok: false as const, errors: [`manifest.json 不是合法 JSON：${(e as Error).message}`] }
  }
  return parseManifest(json)
}

export const SYSTEM_FIELDS = ['_id', '_owner', '_createdAt', '_updatedAt'] as const
export type SystemField = typeof SYSTEM_FIELDS[number]

/** 把字段简写转换为 JSON Schema（additionalProperties: false） */
export function fieldsToJsonSchema(fields: Record<string, FieldDef>) {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, def] of Object.entries(fields)) {
    const d = typeof def === 'string' ? { type: def } : def
    const prop: Record<string, unknown> = { type: d.type }
    if ('maxLength' in d && d.maxLength !== undefined)
      prop.maxLength = d.maxLength
    if ('minLength' in d && d.minLength !== undefined)
      prop.minLength = d.minLength
    if ('min' in d && d.min !== undefined)
      prop.minimum = d.min
    if ('max' in d && d.max !== undefined)
      prop.maximum = d.max
    if ('enum' in d && d.enum)
      prop.enum = d.enum
    if (d.type === 'array') {
      if ('items' in d && d.items)
        prop.items = { type: d.items }
      prop.maxItems = ('maxItems' in d && d.maxItems) || 200
    }
    if (d.type === 'string' && prop.maxLength === undefined)
      prop.maxLength = 2000
    properties[name] = prop
    if ('required' in d && d.required)
      required.push(name)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

export interface AclRules {
  /** 游客能否读 */
  guestRead: boolean
  /** 读取范围：all=所有人数据，own=仅自己，none=不可读 */
  read: 'all' | 'own' | 'none'
  create: boolean
  update: boolean
  remove: boolean
}

export function aclRules(acl: AclPreset): AclRules {
  switch (acl) {
    case 'private':
      return { guestRead: false, read: 'own', create: true, update: true, remove: true }
    case 'public_read':
      return { guestRead: true, read: 'all', create: true, update: true, remove: true }
    case 'submit_only':
      return { guestRead: false, read: 'own', create: true, update: false, remove: false }
    case 'readonly':
      return { guestRead: true, read: 'all', create: false, update: false, remove: false }
    case 'admin_only':
      return { guestRead: false, read: 'none', create: false, update: false, remove: false }
  }
}

export const DEFAULT_MANIFEST: AppManifest = {
  name: '新应用',
  requireLogin: false,
  orientation: 'portrait',
  capabilities: [],
  bizApis: [],
  dependencies: [],
  collections: {},
}
