/**
 * 应用级权限。角色只是权限包，鉴权一律按权限判断：
 * 需求里「能开发」「能发布」「能看后台视图」「能管数据」是正交的，不能用角色等级比较表示。
 */
export const APP_PERMS = [
  'console.view',
  'data.read',
  'data.write.dev',
  'data.write.prod',
  'data.export',
  'app.edit',
  'app.publish',
  'app.manage',
] as const

export type AppPerm = typeof APP_PERMS[number]

export const APP_ROLES = ['viewer', 'operator', 'developer', 'publisher', 'data', 'owner'] as const

export type AppRole = typeof APP_ROLES[number]

export const ROLE_LABELS: Record<AppRole, string> = {
  viewer: '只读',
  operator: '运营（只看后台视图）',
  developer: '开发者',
  publisher: '发布员',
  data: '数据管理员',
  owner: '负责人',
}

/** 每个角色的权限包；新增角色在这里加一行即可，不用改鉴权代码 */
export const ROLE_PERMS: Record<AppRole, AppPerm[]> = {
  viewer: ['console.view', 'data.read'],
  operator: ['console.view'],
  developer: ['console.view', 'data.read', 'data.write.dev', 'app.edit'],
  publisher: ['console.view', 'data.read', 'app.publish'],
  data: ['console.view', 'data.read', 'data.write.dev', 'data.write.prod', 'data.export'],
  owner: [...APP_PERMS],
}

export function isAppPerm(v: unknown): v is AppPerm {
  return typeof v === 'string' && (APP_PERMS as readonly string[]).includes(v)
}

export function isAppRole(v: unknown): v is AppRole {
  return typeof v === 'string' && (APP_ROLES as readonly string[]).includes(v)
}

/** 成员的权限：显式 perms 覆盖角色包（平台管理员在服务端直接给全量） */
export function permsOf(role: AppRole, override?: readonly string[] | null): Set<AppPerm> {
  const list = override?.length ? override.filter(isAppPerm) : ROLE_PERMS[role]
  return new Set(list)
}

export const PERM_LABELS: Record<AppPerm, string> = {
  'console.view': '查看后台视图与监控',
  'data.read': '读取数据',
  'data.write.dev': '写测试环境数据',
  'data.write.prod': '写线上数据',
  'data.export': '导出与同步数据',
  'app.edit': '开发与编辑应用',
  'app.publish': '发布与回滚',
  'app.manage': '应用设置与成员管理',
}
