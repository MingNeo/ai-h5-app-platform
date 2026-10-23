export type Channel = 'prod' | 'beta' | 'dev'
export type DataEnv = 'prod' | 'dev'

/** 3–30 位小写字母/数字/连字符，首尾不能是连字符，不能出现 `--`（`--` 用作渠道分隔符） */
export const APP_ID_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,28}[a-z0-9]$/

export const RESERVED_APP_IDS = new Set([
  'admin', 'api', 'www', 'sso', 'static', 'cdn', 'assets', 'm', 'app', 'apps',
  'beta', 'dev', 'test', 'preview', 'platform', 'login', 'auth', 'mail', 'img', 'file', 'files',
])

/** 应用页面的固定路径前缀：/a/{appId}[--dev|--beta]/ */
export const APP_PATH_PREFIX = '/a'

export function validateAppId(appId: string): string | null {
  if (!APP_ID_RE.test(appId))
    return 'appId 需为 3–30 位小写字母、数字或连字符，首尾不能是连字符，且不能包含连续的 --'
  if (RESERVED_APP_IDS.has(appId))
    return `appId「${appId}」为平台保留字`
  return null
}

export type SiteInfo =
  | { kind: 'admin' }
  | { kind: 'app', appId: string, channel: Channel, /** 去掉前缀后的应用内路径，以 / 开头 */ path: string }

/** 后台页面与后台接口都挂在同一个 origin 下 */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/admin-api' || pathname.startsWith('/admin-api/')
}

/**
 * 解析 /a/{appId}[--dev|--beta]/...。
 * `--` 不允许出现在 appId 里，所以渠道后缀不会产生歧义。
 */
export function parseAppPath(pathname: string): { appId: string, channel: Channel, path: string } | null {
  const m = /^\/a\/([^/]+?)(\/.*)?$/.exec(pathname)
  if (!m)
    return null
  const label = m[1]!
  const cm = /^(.+?)(?:--(dev|beta))?$/.exec(label)
  if (!cm)
    return null
  const appId = cm[1]!
  if (!APP_ID_RE.test(appId) || RESERVED_APP_IDS.has(appId))
    return null
  return { appId, channel: (cm[2] as Channel | undefined) ?? 'prod', path: m[2] || '/' }
}

/**
 * 根据 Host + URL 解析站点。平台只有一个入口域名：
 * - `/admin`、`/admin/...`、`/admin-api/...` → 后台
 * - `/a/{appId}[--dev|--beta]/...`        → 应用
 * - 其他路径不是站点（平台运行时文件、健康检查等由各自路由处理）
 */
export function parseSite(host: string | undefined, url: string, baseDomain: string, extraHosts: string[] = []): SiteInfo | null {
  if (!host)
    return null
  const hostname = host.split(':')[0]!.toLowerCase()
  if (hostname !== baseDomain.toLowerCase() && !extraHosts.includes(hostname))
    return null
  const pathname = url.split('?')[0] || '/'
  if (isAdminPath(pathname))
    return { kind: 'admin' }
  const app = parseAppPath(pathname)
  return app ? { kind: 'app', ...app } : null
}

/** 应用根路径（不带结尾斜杠），例：/a/vote、/a/vote--dev */
export function appPath(appId: string, channel: Channel): string {
  return `${APP_PATH_PREFIX}/${appId}${channel === 'prod' ? '' : `--${channel}`}`
}

/** 应用根 URL，结尾带斜杠 */
export function appUrl(appId: string, channel: Channel, baseDomain: string): string {
  return `https://${baseDomain}${appPath(appId, channel)}/`
}

export function dataEnvOf(channel: Channel): DataEnv {
  return channel === 'prod' ? 'prod' : 'dev'
}
