import { config } from '../config'

export interface ModerationResult {
  pass: boolean
  reason?: string
}

/**
 * 内容安全审核。默认按关键词拦截；配置 MODERATION_URL 后改调公司内容安全服务
 * （POST {text, scene}，期望返回 {pass: boolean, reason?: string}）。
 */
export async function moderateText(text: string, scene: 'ugc'): Promise<ModerationResult> {
  if (!text)
    return { pass: true }
  const url = process.env.MODERATION_URL
  if (url) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 10000), scene }),
        signal: AbortSignal.timeout(3000),
      })
      const body = await res.json() as ModerationResult
      return { pass: Boolean(body.pass), reason: body.reason }
    }
    catch (e) {
      console.warn('[moderation] 调用失败，降级为关键词审核', (e as Error).message)
    }
  }
  const hit = config.moderation.blockedWords.find(w => text.includes(w))
  return hit ? { pass: false, reason: '内容包含敏感信息' } : { pass: true }
}
