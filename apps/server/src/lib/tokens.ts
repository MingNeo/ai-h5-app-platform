import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { customAlphabet } from 'nanoid'
import { config } from '../config'

export const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16)

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/** 存储前单向哈希：数据库里只留哈希，泄库拿不到可用的原始 token */
export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/** 签名令牌：base64url(json).base64url(hmac) */
export function signToken(payload: Record<string, unknown>, ttlSec: number) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url')
  const sig = createHmac('sha256', config.secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyToken<T extends Record<string, unknown>>(token: string | undefined): (T & { exp: number }) | null {
  if (!token || !token.includes('.'))
    return null
  const [body, sig] = token.split('.') as [string, string]
  const expected = createHmac('sha256', config.secret).update(body).digest()
  const given = Buffer.from(sig, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000)
      return null
    return payload
  }
  catch {
    return null
  }
}
