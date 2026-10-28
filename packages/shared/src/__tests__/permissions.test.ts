import { describe, expect, it } from 'vitest'
import { APP_PERMS, isAppPerm, isAppRole, permsOf, ROLE_PERMS } from '../permissions'

describe('应用权限', () => {
  it('owner 拥有全部权限', () => {
    expect(new Set(ROLE_PERMS.owner)).toEqual(new Set(APP_PERMS))
  })

  it('角色之间是正交的，不是等级包含', () => {
    // 发布员不能改代码，数据管理员不能发布，运营看不到数据页
    expect(permsOf('publisher').has('app.edit')).toBe(false)
    expect(permsOf('publisher').has('app.publish')).toBe(true)
    expect(permsOf('data').has('app.publish')).toBe(false)
    expect(permsOf('data').has('data.write.prod')).toBe(true)
    expect(permsOf('operator').has('data.read')).toBe(false)
    expect(permsOf('operator').has('console.view')).toBe(true)
    // 开发者不能发布线上，只能写测试数据
    expect(permsOf('developer').has('app.publish')).toBe(false)
    expect(permsOf('developer').has('data.write.dev')).toBe(true)
    expect(permsOf('developer').has('data.write.prod')).toBe(false)
  })

  it('观察者只能查看应用概览', () => {
    expect(new Set(permsOf('observer'))).toEqual(new Set(['app.view']))
    expect(permsOf('observer').has('console.view')).toBe(false)
    expect(permsOf('observer').has('data.read')).toBe(false)
    expect(permsOf('observer').has('app.edit')).toBe(false)
  })

  it('现有角色都能查看应用概览', () => {
    for (const role of ['viewer', 'operator', 'developer', 'publisher', 'data', 'owner'] as const)
      expect(permsOf(role).has('app.view')).toBe(true)
  })

  it('显式 perms 覆盖角色包，并过滤非法值', () => {
    const p = permsOf('viewer', ['app.publish', 'nope' as never])
    expect([...p]).toEqual(['app.publish'])
  })

  it('空覆盖回落到角色包', () => {
    expect(permsOf('viewer', [])).toEqual(new Set(ROLE_PERMS.viewer))
    expect(permsOf('viewer', null)).toEqual(new Set(ROLE_PERMS.viewer))
  })

  it('角色与权限校验', () => {
    expect(isAppRole('observer')).toBe(true)
    expect(isAppRole('publisher')).toBe(true)
    expect(isAppRole('admin')).toBe(false)
    expect(isAppPerm('app.view')).toBe(true)
    expect(isAppPerm('data.write.prod')).toBe(true)
    expect(isAppPerm('data.write')).toBe(false)
  })
})
