import type { AppManifest } from '../manifest'
import { describe, expect, it } from 'vitest'
import { type AdminView, parseAdminView, validateAdminView } from '../admin-view'
import { parseManifest } from '../manifest'

const parsed = parseManifest({
  name: '投票',
  collections: {
    votes: { acl: 'public_read', fields: { option: { type: 'string', enum: ['a', 'b'] } } },
  },
})
const manifest = (parsed.ok ? parsed.manifest : null) as AppManifest
if (!parsed.ok)
  throw new Error(parsed.errors.join('; '))

describe('admin view', () => {
  it('解析合法配置', () => {
    const res = parseAdminView({
      title: '投票后台',
      pages: [{
        title: '概览',
        blocks: [
          { type: 'stat', title: '总票数', collection: 'votes', agg: 'count' },
          { type: 'chart', collection: 'votes', field: 'option', chart: 'pie' },
          { type: 'chart', collection: 'votes', chart: 'line', timeField: '_createdAt', interval: 'day' },
          { type: 'table', collection: 'votes', columns: ['option'], orderBy: [['_createdAt', 'desc']], filters: [{ field: 'option', type: 'select' }], search: { fields: ['option'] }, actions: { detail: true, edit: true } },
          { type: 'text', content: '说明' },
        ],
      }],
    })
    expect(res.ok).toBe(true)
  })

  it('拒绝未知区块和多余字段', () => {
    expect(parseAdminView({ pages: [{ title: 'x', blocks: [{ type: 'chart' }] }] }).ok).toBe(false)
    expect(parseAdminView({ pages: [{ title: 'x', blocks: [{ type: 'text', content: 'x', extra: 1 }] }] }).ok).toBe(false)
  })

  it('校验集合与字段引用', () => {
    const view = {
      pages: [{
        title: '概览',
        blocks: [
          { type: 'stat' as const, title: '总数', collection: 'nope' },
          { type: 'chart' as const, collection: 'votes', field: 'nope' },
        ],
      }],
    }
    const errors = validateAdminView(view as unknown as AdminView, manifest)
    expect(errors.some(e => e.includes('nope') && e.includes('集合'))).toBe(true)
    expect(errors.some(e => e.includes('分类字段'))).toBe(true)
  })
})
