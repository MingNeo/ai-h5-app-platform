import { col } from './mongo'

export function audit(actor: string, action: string, appId?: string, detail?: Record<string, unknown>) {
  col.audit.insertOne({ actor, action, appId, detail, createdAt: new Date() }).catch((e) => {
    console.error('[audit] 写入失败', e)
  })
}
