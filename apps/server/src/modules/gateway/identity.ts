// 应用端用户身份：线上走主站 cookie（.example.test 自动带到平台接口），本地开发可用 mock。
import type { Channel } from '@app-platform/shared'
import { config } from '../../config'
import { readPreviewClaims, testUserFor } from '../../core/preview-access'
import { sha256 } from '../../lib/blob'
import { parseCookies } from '../../lib/http'
import { store } from '../../lib/store'

export interface AppUser {
  uid: string
  nickname: string
  avatar: string
}

export interface Identity {
  user: AppUser | null
  /** 预览身份被后台锁定 */
  locked: boolean
}

export const MOCK_COOKIE = 'app_mock_user'

function decodeMock(raw: string | undefined): AppUser | null {
  if (!raw)
    return null
  try {
    const u = JSON.parse(Buffer.from(raw, 'base64url').toString())
    if (typeof u.uid === 'string' && u.uid)
      return { uid: u.uid, nickname: String(u.nickname ?? ''), avatar: String(u.avatar ?? '') }
  }
  catch {}
  return null
}

export function encodeMock(u: AppUser) {
  return Buffer.from(JSON.stringify(u)).toString('base64url')
}

/** 只把主站 cookie 转发给用户信息接口，去掉平台自己的 cookie */
function mainSiteCookieHeader(header: string | undefined) {
  if (!header)
    return ''
  return header.split(';').map(s => s.trim()).filter(s => s && !s.startsWith('__Host-') && !s.startsWith(`${MOCK_COOKIE}=`)).join('; ')
}

function parseJsonp(text: string) {
  const t = text.trim()
  const m = /^[\w$.]+\(([\s\S]*)\);?$/.exec(t)
  return JSON.parse(m ? m[1]! : t)
}

/** 兼容主站用户信息接口的字段：按 AUTH_UID_FIELDS 依次取，全为空或 0 视为未登录 */
export function mapMainSiteUser(body: any): AppUser | null {
  const d = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? { ...body, ...body.data } : body
  const uid = config.auth.uidFields.map(f => d?.[f]).find(v => v !== undefined && v !== null && v !== '')
  if (!uid || uid === 0 || uid === '0')
    return null
  return {
    uid: String(uid),
    nickname: String(d.nickname ?? d.nick_name ?? d.display_name ?? d.user_name ?? ''),
    avatar: String(d.avatar ?? d.avatar_url ?? d.user_avatar ?? d.head_img ?? ''),
  }
}

async function mainSiteUser(cookieHeader: string | undefined, ua: string | undefined): Promise<AppUser | null> {
  const cookies = mainSiteCookieHeader(cookieHeader)
  if (!cookies)
    return null
  const parsed = parseCookies(cookies)
  // 主站会话 cookie 优先作为缓存键，避免埋点类 cookie 变化导致缓存失效
  const key = `auth:main-site:${sha256(parsed.sess ?? cookies)}`
  const cached = await store.get(key)
  if (cached)
    return cached === 'null' ? null : JSON.parse(cached)
  let user: AppUser | null = null
  try {
    const res = await fetch(`${config.auth.userInfoUrl}${config.auth.userInfoUrl.includes('?') ? '&' : '?'}t=${Date.now()}`, {
      headers: { 'cookie': cookies, 'user-agent': ua ?? 'app-platform-gateway', 'referer': `https://${config.baseDomain}/` },
      signal: AbortSignal.timeout(3000),
    })
    user = mapMainSiteUser(parseJsonp(await res.text()))
  }
  catch (e) {
    console.warn('[auth] 查询主站用户信息失败', (e as Error).message)
    return null
  }
  await store.set(key, JSON.stringify(user), config.auth.cacheSeconds)
  return user
}

export async function resolveIdentity(req: { headers: Record<string, any> }, appId: string, channel: Channel): Promise<Identity> {
  if (channel !== 'prod') {
    const claims = readPreviewClaims(req.headers.cookie, appId, channel)
    if (claims?.identity === 'guest')
      return { user: null, locked: true }
    if (claims?.identity === 'test')
      return { user: testUserFor(claims.uid), locked: true }
  }
  if (config.auth.provider === 'mock')
    return { user: decodeMock(parseCookies(req.headers.cookie)[MOCK_COOKIE]), locked: false }
  if (!config.auth.userInfoUrl)
    return { user: null, locked: false }
  return { user: await mainSiteUser(req.headers.cookie, req.headers['user-agent']), locked: false }
}
