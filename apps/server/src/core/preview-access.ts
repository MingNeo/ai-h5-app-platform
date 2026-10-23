import { parseCookies } from '../lib/http'
import { signToken, verifyToken } from '../lib/tokens'

export const PREVIEW_COOKIE = '__Host-app_preview'
export type PreviewIdentity = 'self' | 'guest' | 'test'

export interface PreviewClaims extends Record<string, unknown> {
  kind: 'preview'
  appId: string
  uid: string
  identity: PreviewIdentity
}

/** 一次性换取 cookie 的预览票据（放在 URL / 二维码里，短有效期） */
export function issuePreviewTicket(appId: string, uid: string, identity: PreviewIdentity, ttlSec = 600) {
  return signToken({ kind: 'preview-ticket', appId, uid, identity }, ttlSec)
}

export function verifyPreviewTicket(t: string | undefined, appId: string) {
  const claims = verifyToken<{ kind: string, appId: string, uid: string, identity: PreviewIdentity }>(t)
  if (!claims || claims.kind !== 'preview-ticket' || claims.appId !== appId)
    return null
  return claims
}

export function previewCookieValue(appId: string, uid: string, identity: PreviewIdentity) {
  return signToken({ kind: 'preview', appId, uid, identity }, 24 * 3600)
}

export function readPreviewClaims(cookieHeader: string | undefined, appId: string): PreviewClaims | null {
  const raw = parseCookies(cookieHeader)[PREVIEW_COOKIE]
  const claims = verifyToken<PreviewClaims>(raw)
  if (!claims || claims.kind !== 'preview' || claims.appId !== appId)
    return null
  return claims
}

export function testUserFor(adminUid: string) {
  return { uid: `test_${adminUid}`, nickname: '测试用户', avatar: '' }
}
