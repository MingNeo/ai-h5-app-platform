import { z } from 'zod'
import type { AppManifest } from './manifest'

/** 应用后台视图配置：AI 或人写 admin.json，由管理端渲染，不执行任何应用代码 */

const whereSchema = z.record(z.string(), z.unknown())
const collectionSchema = z.string().min(1).max(48)
const fieldSchema = z.string().min(1).max(64)

export const adminFilterSchema = z.object({
  field: fieldSchema,
  type: z.enum(['select', 'input', 'date']).default('select'),
  label: z.string().max(20).optional(),
  /** select 的可选项；不填时取字段的 enum。纯值数组，值本身就是展示文本，没有 label/value 映射 */
  options: z.array(z.union([z.string(), z.number()], {
    errorMap: () => ({ message: 'options 项只能是字符串或数字，不支持 { label, value } 对象；值本身就是展示文本，不填则取字段的 enum' }),
  })).max(50).optional(),
  placeholder: z.string().max(30).optional(),
}).strict()

export const adminActionsSchema = z.object({
  detail: z.boolean().default(true),
  edit: z.boolean().default(false),
  delete: z.boolean().default(false),
  create: z.boolean().default(false),
}).strict()

export const adminBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stat'),
    title: z.string().min(1).max(40),
    collection: collectionSchema,
    where: whereSchema.optional(),
    agg: z.enum(['count', 'sum', 'avg']).default('count'),
    /** agg=sum/avg 时必填 */
    field: fieldSchema.optional(),
    unit: z.string().max(10).optional(),
    hint: z.string().max(60).optional(),
  }).strict(),
  z.object({
    type: z.literal('chart'),
    title: z.string().max(40).optional(),
    collection: collectionSchema,
    chart: z.enum(['bar', 'pie', 'line']).default('bar'),
    /** bar / pie：分类字段 */
    field: fieldSchema.optional(),
    /** line：时间字段，默认 _createdAt */
    timeField: fieldSchema.optional(),
    interval: z.enum(['day', 'hour']).default('day'),
    where: whereSchema.optional(),
    limit: z.number().int().positive().max(50).default(12),
  }).strict(),
  z.object({
    type: z.literal('table'),
    title: z.string().max(40).optional(),
    collection: collectionSchema,
    columns: z.array(fieldSchema).max(20).optional(),
    where: whereSchema.optional(),
    orderBy: z.array(z.tuple([fieldSchema, z.enum(['asc', 'desc'])])).max(3).optional(),
    pageSize: z.number().int().positive().max(100).default(20),
    filters: z.array(adminFilterSchema).max(8).default([]),
    /** 关键字搜索：对所有列出的字段做不区分大小写的包含匹配 */
    search: z.object({
      fields: z.array(fieldSchema).min(1).max(6),
      placeholder: z.string().max(30).optional(),
    }).strict().optional(),
    actions: adminActionsSchema.default({ detail: true, edit: false, delete: false, create: false }),
  }).strict(),
  z.object({
    type: z.literal('text'),
    title: z.string().max(40).optional(),
    content: z.string().max(2000),
  }).strict(),
])

export const adminPageSchema = z.object({
  title: z.string().min(1).max(40),
  blocks: z.array(adminBlockSchema).max(30).default([]),
}).strict()

export const adminViewSchema = z.object({
  title: z.string().min(1).max(40).optional(),
  /** 一句话说明这个后台是给谁用的 */
  description: z.string().max(200).optional(),
  pages: z.array(adminPageSchema).max(10).default([]),
}).strict()

export type AdminFilter = z.infer<typeof adminFilterSchema>
export type AdminActions = z.infer<typeof adminActionsSchema>
export type AdminBlock = z.infer<typeof adminBlockSchema>
export type AdminPage = z.infer<typeof adminPageSchema>
export type AdminView = z.infer<typeof adminViewSchema>

export const ADMIN_VIEW_FILE = 'admin.json'

export function parseAdminView(input: unknown): { ok: true, view: AdminView } | { ok: false, errors: string[] } {
  const res = adminViewSchema.safeParse(input)
  if (!res.success)
    return { ok: false, errors: res.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`) }
  return { ok: true, view: res.data }
}

export function parseAdminViewText(text: string) {
  try {
    return parseAdminView(JSON.parse(text))
  }
  catch (e) {
    return { ok: false as const, errors: [`admin.json 不是合法 JSON：${(e as Error).message}`] }
  }
}

/** 校验视图里引用的集合、字段是否都在 manifest 中 */
export function validateAdminView(view: AdminView, manifest: AppManifest | null): string[] {
  const errors: string[] = []
  for (const [pi, page] of view.pages.entries()) {
    for (const [bi, block] of page.blocks.entries()) {
      const where = `pages.${pi}.blocks.${bi}`
      if (block.type === 'text')
        continue
      const col = manifest?.collections[block.collection]
      if (!col) {
        errors.push(`${where}: 集合 ${block.collection} 未在 manifest.json 中声明`)
        continue
      }
      const check = (field: string, label: string) => {
        if (!col.fields[field] && !field.startsWith('_'))
          errors.push(`${where}: ${label} ${field} 未在集合 ${block.collection} 的 fields 中声明`)
      }
      if (block.type === 'stat') {
        if (block.agg !== 'count' && !block.field)
          errors.push(`${where}: agg=${block.agg} 时必须指定 field`)
        if (block.field)
          check(block.field, '聚合字段')
        for (const f of Object.keys(block.where ?? {})) {
          if (!f.startsWith('_'))
            check(f, '筛选字段')
        }
      }
      if (block.type === 'chart') {
        if (block.chart === 'line') {
          const timeField = block.timeField ?? '_createdAt'
          if (!['_createdAt', '_updatedAt'].includes(timeField))
            check(timeField, '时间字段')
        }
        else if (!block.field) {
          errors.push(`${where}: chart=${block.chart} 时必须指定 field`)
        }
        else check(block.field, '分类字段')
      }
      if (block.type === 'table') {
        for (const c of block.columns ?? [])
          check(c, '列')
        for (const [f] of block.orderBy ?? [])
          check(f, '排序字段')
        for (const f of block.filters)
          check(f.field, '筛选字段')
        for (const f of block.search?.fields ?? [])
          check(f, '搜索字段')
      }
    }
  }
  return errors
}
