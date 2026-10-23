import { describe, expect, it } from 'vitest'
import { mapMainSiteUser } from './identity'

describe('主站用户信息映射', () => {
  it('用户信息接口已登录', () => {
    expect(mapMainSiteUser({ uid: 123, nickname: '小明', avatar: 'https://a/b.png' })).toEqual({ uid: '123', nickname: '小明', avatar: 'https://a/b.png' })
  })
  it('data 包裹的格式', () => {
    expect(mapMainSiteUser({ error_code: 0, data: { user_id: '9', nickname: 'x', avatar: '' } })?.uid).toBe('9')
  })
  it('未登录', () => {
    expect(mapMainSiteUser({ uid: 0 })).toBeNull()
    expect(mapMainSiteUser({})).toBeNull()
    expect(mapMainSiteUser(null)).toBeNull()
  })
})
