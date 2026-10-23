import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { col } from '../../lib/mongo'
import { newId, randomToken } from '../../lib/tokens'
import { requireAdmin, requirePlatformAdmin } from './auth'

const clientSchema = z.object({
  name: z.string().min(1).max(40),
  appIds: z.array(z.string().max(30)).min(1).max(100),
  scopes: z.array(z.enum(['read', 'write', 'export', 'dev'])).min(1),
  allowedIps: z.array(z.string().max(64)).max(20).optional(),
})

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

export function registerApiClientRoutes(app: FastifyInstance) {
  /** 对外开放 token 的管理：只给平台管理员 */
  app.get('/admin-api/api-clients', async (req) => {
    requirePlatformAdmin(req)
    const list = await col.apiClients.find({}, { projection: { tokenHash: 0 } }).sort({ createdAt: -1 }).toArray()
    return ok({ clients: list.map(c => ({ ...c, id: c._id })) })
  })

  app.post('/admin-api/api-clients', async (req) => {
    const user = requirePlatformAdmin(req)
    const body = parseBody(clientSchema, req.body)
    const token = `zdm_${randomToken(32)}`
    const doc = {
      _id: newId(),
      name: body.name,
      tokenHash: sha256(token),
      appIds: body.appIds,
      scopes: body.scopes,
      allowedIps: body.allowedIps?.length ? body.allowedIps : undefined,
      createdBy: user._id,
      createdAt: new Date(),
    }
    await col.apiClients.insertOne(doc)
    audit(user._id, 'api-client.create', undefined, { clientId: doc._id, name: doc.name, scopes: doc.scopes })
    // 明文 token 只在这里返回一次
    return ok({ id: doc._id, token })
  })

  app.post('/admin-api/api-clients/:id/revoke', async (req) => {
    const user = requireAdmin(req)
    const { id } = req.params as { id: string }
    const res = await col.apiClients.updateOne({ _id: id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } })
    if (!res.modifiedCount)
      throw err.notFound('token 不存在或已经吊销')
    audit(user._id, 'api-client.revoke', undefined, { clientId: id })
    return ok({})
  })

  app.delete('/admin-api/api-clients/:id', async (req) => {
    const user = requirePlatformAdmin(req)
    const { id } = req.params as { id: string }
    await col.apiClients.deleteOne({ _id: id })
    audit(user._id, 'api-client.delete', undefined, { clientId: id })
    return ok({})
  })
}
