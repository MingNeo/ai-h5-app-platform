import type { Channel } from '@app-platform/shared'
import { parseCookies } from '../lib/http'
import { signToken, verifyToken } from '../lib/tokens'

/**
 * 预览 cookie 每个「应用 × 渠道」一个名字。
 * `__Host-` 前缀强制 Path=/ 且不能带 Domain，无法按路径隔离；用名字区分，
 * 避免同时预览多个应用/渠道时互相覆盖。票据与 cookie 里都带 appId、channel 并逐一校验，
 * 渠道不匹配的 cookie 一律视为无效——预览一个渠道不能顺带放开另一个渠道。
 */
export const PREVIEW_COOKIE_PREFIX = '__Host-app_preview__'
export type PreviewIdentity = 'self' | 'guest' | 'test'

function assertPreviewChannel(channel: Channel): Channel {
  // 线上渠道不会签发预览 cookie
  if (channel === 'prod')
    throw new Error('prod 渠道不签发预览票据')
  return channel
}

export function previewCookieName(appId: string, channel: Channel) {
  return `${PREVIEW_COOKIE_PREFIX}${appId}__${assertPreviewChannel(channel)}`
}

export interface PreviewClaims extends Record<string, unknown> {
  kind: 'preview'
  appId: string
  channel: Channel
  uid: string
  identity: PreviewIdentity
}

/** 一次性换取 cookie 的预览票据（放在 URL / 二维码里，短有效期） */
export function issuePreviewTicket(appId: string, channel: Channel, uid: string, identity: PreviewIdentity, ttlSec = 600) {
  return signToken({ kind: 'preview-ticket', appId, channel: assertPreviewChannel(channel), uid, identity }, ttlSec)
}

export function verifyPreviewTicket(t: string | undefined, appId?: string, channel?: Channel) {
  const claims = verifyToken<{ kind: string, appId: string, channel: Channel, uid: string, identity: PreviewIdentity }>(t)
  if (!claims || claims.kind !== 'preview-ticket')
    return null
  if (appId && claims.appId !== appId)
    return null
  if (channel && claims.channel !== channel)
    return null
  if (claims.channel !== 'beta' && claims.channel !== 'dev')
    return null
  return claims
}

export function previewCookieValue(appId: string, channel: Channel, uid: string, identity: PreviewIdentity) {
  return signToken({ kind: 'preview', appId, channel: assertPreviewChannel(channel), uid, identity }, 24 * 3600)
}

/** 读取并校验预览 cookie：appId 与 channel 都必须精确匹配 */
export function readPreviewClaims(cookieHeader: string | undefined, appId: string, channel: Channel): PreviewClaims | null {
  if (channel === 'prod')
    return null
  const raw = parseCookies(cookieHeader)[previewCookieName(appId, channel)]
  const claims = verifyToken<PreviewClaims>(raw)
  if (!claims || claims.kind !== 'preview' || claims.appId !== appId || claims.channel !== channel)
    return null
  return claims
}

export function testUserFor(adminUid: string) {
  return { uid: `test_${adminUid}`, nickname: '测试用户', avatar: '' }
}
