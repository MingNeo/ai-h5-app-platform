import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { col } from '../../lib/mongo'
import { isConfiguredAdmin, requirePlatformAdmin } from './auth'

function source(feishuOpenId: string) {
  return feishuOpenId.startsWith('dev:') ? 'dev' : 'feishu'
}

/** 平台级用户管理：仅平台管理员可见，跟应用内成员管理（members）分开 */
export function registerUserRoutes(app: FastifyInstance) {
  app.get('/admin-api/admin-users', async (req) => {
    requirePlatformAdmin(req)
    const q = String((req.query as { q?: string }).q ?? '').trim()
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const filter = q ? { $or: [{ name: { $regex: esc, $options: 'i' } }, { email: { $regex: esc, $options: 'i' } }] } : {}
    const users = await col.adminUsers.find(filter).sort({ lastLoginAt: -1 }).limit(200).toArray()
    return ok(users.map(u => ({
      id: u._id,
      name: u.name,
      avatar: u.avatar,
      email: u.email,
      isPlatformAdmin: u.isPlatformAdmin,
      source: source(u.feishuOpenId ?? ''),
      // 在 PLATFORM_ADMINS 配置里：页面上不能取消，否则下次登录/重启又会被加回来
      pinned: isConfiguredAdmin(u.email, u.feishuOpenId),
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    })))
  })

  app.patch('/admin-api/admin-users/:id', async (req) => {
    const operator = requirePlatformAdmin(req)
    const { id } = req.params as { id: string }
    const { isPlatformAdmin } = parseBody(z.object({ isPlatformAdmin: z.boolean() }), req.body)
    const target = await col.adminUsers.findOne({ _id: id })
    if (!target)
      throw err.notFound('用户不存在')
    if (!isPlatformAdmin) {
      if (id === operator._id)
        throw err.invalid('不能取消自己的平台管理员')
      if (isConfiguredAdmin(target.email, target.feishuOpenId))
        throw err.invalid('该账号在 PLATFORM_ADMINS 配置中，需先从配置移除')
    }
    await col.adminUsers.updateOne({ _id: id }, { $set: { isPlatformAdmin } })
    audit(operator._id, isPlatformAdmin ? 'platform-admin.grant' : 'platform-admin.revoke', undefined, { userId: id, name: target.name })
    return ok({})
  })
}
