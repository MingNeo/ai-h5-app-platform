import type { Channel } from '@app-platform/shared'
import { parseCookies } from '../lib/http'
import { signToken, verifyToken } from '../lib/tokens'

/**
 * 预览 cookie 每个应用一个名字。
 * `__Host-` 前缀强制 Path=/ 且不能带 Domain，无法按路径隔离；用名字区分应用，
 * 避免同时预览两个应用时互相覆盖。票据与 cookie 里都带 appId 并校验。
 */
export const PREVIEW_COOKIE_PREFIX = '__Host-app_preview__'
export type PreviewIdentity = 'self' | 'guest' | 'test'

export function previewCookieName(appId: string) {
  return `${PREVIEW_COOKIE_PREFIX}${appId}`
}

export interface PreviewClaims extends Record<string, unknown> {
  kind: 'preview'
  appId: string
  uid: string
  identity: PreviewIdentity
}

/** 一次性换取 cookie 的预览票据（放在 URL / 二维码里，短有效期） */
export function issuePreviewTicket(appId: string, channel: Channel, uid: string, identity: PreviewIdentity, ttlSec = 600) {
  return signToken({ kind: 'preview-ticket', appId, channel, uid, identity }, ttlSec)
}

export function verifyPreviewTicket(t: string | undefined, appId?: string) {
  const claims = verifyToken<{ kind: string, appId: string, channel: Channel, uid: string, identity: PreviewIdentity }>(t)
  if (!claims || claims.kind !== 'preview-ticket')
    return null
  if (appId && claims.appId !== appId)
    return null
  return claims
}

export function previewCookieValue(appId: string, uid: string, identity: PreviewIdentity) {
  return signToken({ kind: 'preview', appId, uid, identity }, 24 * 3600)
}

export function readPreviewClaims(cookieHeader: string | undefined, appId: string): PreviewClaims | null {
  const raw = parseCookies(cookieHeader)[previewCookieName(appId)]
  const claims = verifyToken<PreviewClaims>(raw)
  if (!claims || claims.kind !== 'preview' || claims.appId !== appId)
    return null
  return claims
}

export function testUserFor(adminUid: string) {
  return { uid: `test_${adminUid}`, nickname: '测试用户', avatar: '' }
}
