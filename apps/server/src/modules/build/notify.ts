import { config } from '../../config'

/** 飞书群机器人通知（配置 FEISHU_BOT_WEBHOOK 后生效） */
export async function notifyFeishu(text: string) {
  if (!config.admin.feishuBotWebhook)
    return
  try {
    await fetch(config.admin.feishuBotWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: `${text}\n${config.adminOrigin}` } }),
      signal: AbortSignal.timeout(5000),
    })
  }
  catch (e) {
    console.warn('[notify] 飞书通知失败', (e as Error).message)
  }
}
