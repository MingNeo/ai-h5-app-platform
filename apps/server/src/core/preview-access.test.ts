import { describe, expect, it } from 'vitest'
import { issuePreviewTicket, previewCookieName, previewCookieValue, readPreviewClaims, verifyPreviewTicket } from './preview-access'

const cookie = (appId: string, channel: 'dev' | 'beta', value: string) => `${previewCookieName(appId, channel)}=${value}`

describe('预览票据与 cookie 绑定渠道', () => {
  it('cookie 名按应用与渠道区分', () => {
    expect(previewCookieName('demo-app', 'dev')).not.toBe(previewCookieName('demo-app', 'beta'))
    expect(previewCookieName('demo-app', 'dev')).not.toBe(previewCookieName('other-app', 'dev'))
  })

  it('一个渠道的 cookie 不能用于另一个渠道', () => {
    const value = previewCookieValue('demo-app', 'dev', 'u1', 'self')
    const header = cookie('demo-app', 'dev', value)
    expect(readPreviewClaims(header, 'demo-app', 'dev')?.uid).toBe('u1')
    expect(readPreviewClaims(header, 'demo-app', 'beta')).toBeNull()
  })

  it('cookie 不能跨应用使用', () => {
    const value = previewCookieValue('demo-app', 'dev', 'u1', 'self')
    expect(readPreviewClaims(cookie('demo-app', 'dev', value), 'other-app', 'dev')).toBeNull()
  })

  it('prod 渠道永远不认预览 cookie', () => {
    const value = previewCookieValue('demo-app', 'dev', 'u1', 'self')
    expect(readPreviewClaims(cookie('demo-app', 'dev', value), 'demo-app', 'prod')).toBeNull()
  })

  it('prod 不签发预览票据 / cookie', () => {
    expect(() => issuePreviewTicket('demo-app', 'prod', 'u1', 'self')).toThrow()
    expect(() => previewCookieValue('demo-app', 'prod', 'u1', 'self')).toThrow()
  })

  it('票据的渠道与应用都必须匹配', () => {
    const t = issuePreviewTicket('demo-app', 'dev', 'u1', 'self')
    expect(verifyPreviewTicket(t, 'demo-app', 'dev')?.channel).toBe('dev')
    expect(verifyPreviewTicket(t, 'demo-app', 'beta')).toBeNull()
    expect(verifyPreviewTicket(t, 'other-app', 'dev')).toBeNull()
  })
})
