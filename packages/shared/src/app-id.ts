export type Channel = 'prod' | 'beta' | 'dev'
export type DataEnv = 'prod' | 'dev'

/** 3–30 位小写字母/数字/连字符，首尾不能是连字符，不能出现 `--`（`--` 用作渠道分隔符） */
export const APP_ID_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,28}[a-z0-9]$/

export const RESERVED_APP_IDS = new Set([
  'admin', 'api', 'www', 'sso', 'static', 'cdn', 'assets', 'm', 'app', 'apps',
  'beta', 'dev', 'test', 'preview', 'platform', 'login', 'auth', 'mail', 'img', 'file', 'files',
])

export function validateAppId(appId: string): string | null {
  if (!APP_ID_RE.test(appId))
    return 'appId 需为 3–30 位小写字母、数字或连字符，首尾不能是连字符，且不能包含连续的 --'
  if (RESERVED_APP_IDS.has(appId))
    return `appId「${appId}」为平台保留字`
  return null
}

export type SiteInfo =
  | { kind: 'admin' }
  | { kind: 'app', appId: string, channel: Channel }

/**
 * 根据 Host 解析站点：admin.<base> 为后台，{appId}[--dev|--beta].<base> 为应用。
 */
export function parseSiteHost(host: string | undefined, baseDomain: string): SiteInfo | null {
  if (!host)
    return null
  const hostname = host.split(':')[0]!.toLowerCase()
  const suffix = `.${baseDomain.toLowerCase()}`
  if (!hostname.endsWith(suffix))
    return null
  const label = hostname.slice(0, -suffix.length)
  if (label === 'admin')
    return { kind: 'admin' }
  const m = /^(.+?)(?:--(dev|beta))?$/.exec(label)
  if (!m)
    return null
  const appId = m[1]!
  if (!APP_ID_RE.test(appId) || RESERVED_APP_IDS.has(appId))
    return null
  return { kind: 'app', appId, channel: (m[2] as Channel | undefined) ?? 'prod' }
}

export function appHost(appId: string, channel: Channel, baseDomain: string): string {
  return channel === 'prod' ? `${appId}.${baseDomain}` : `${appId}--${channel}.${baseDomain}`
}

export function dataEnvOf(channel: Channel): DataEnv {
  return channel === 'prod' ? 'prod' : 'dev'
}
