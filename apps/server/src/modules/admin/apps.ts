import { appUrl, validateAppId } from '@app-platform/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config'
import { draftManifest, invalidateApp } from '../../core/apps'
import { initDraft } from '../../core/drafts'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { type AppDoc, col } from '../../lib/mongo'
import { newId } from '../../lib/tokens'
import { appRole, requireAdmin, requireAppRole } from './auth'

export function appUrls(appId: string) {
  return {
    prod: appUrl(appId, 'prod', config.baseDomain),
    beta: appUrl(appId, 'beta', config.baseDomain),
    dev: appUrl(appId, 'dev', config.baseDomain),
  }
}

function view(app: AppDoc, role: string | null) {
  return {
    appId: app._id,
    name: app.name,
    description: app.description,
    icon: app.icon,
    status: app.status,
    schedule: app.schedule ?? null,
    betaBuildId: app.betaBuildId ?? null,
    prodBuildId: app.prodBuildId ?? null,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    role,
    urls: appUrls(app._id),
  }
}

const createSchema = z.object({
  appId: z.string(),
  name: z.string().trim().min(1).max(40),
  description: z.string().max(200).default(''),
})

const patchSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  description: z.string().max(200).optional(),
  icon: z.string().max(500).optional(),
  status: z.enum(['active', 'offline']).optional(),
  schedule: z.object({
    startAt: z.string().datetime().nullable().optional(),
    endAt: z.string().datetime().nullable().optional(),
  }).optional(),
})

export function registerAppRoutes(app: FastifyInstance) {
  app.get('/admin-api/apps', async (req) => {
    const user = requireAdmin(req)
    let apps: AppDoc[]
    const roles = new Map<string, string>()
    if (user.isPlatformAdmin) {
      apps = await col.apps.find({ status: { $ne: 'deleted' } }).sort({ updatedAt: -1 }).toArray()
      for (const a of apps)
        roles.set(a._id, 'owner')
    }
    else {
      const members = await col.members.find({ userId: user._id }).toArray()
      for (const m of members)
        roles.set(m.appId, m.role)
      apps = await col.apps.find({ _id: { $in: [...roles.keys()] }, status: { $ne: 'deleted' } }).sort({ updatedAt: -1 }).toArray()
    }
    return ok(apps.map(a => view(a, roles.get(a._id) ?? null)))
  })

  app.post('/admin-api/apps', async (req) => {
    const user = requireAdmin(req)
    const body = parseBody(createSchema, req.body)
    const appId = body.appId.trim().toLowerCase()
    const invalid = validateAppId(appId)
    if (invalid)
      throw err.invalid(invalid)
    if (await col.apps.findOne({ _id: appId }))
      throw err.duplicate(`appId「${appId}」已被使用`)
    const now = new Date()
    const doc: AppDoc = { _id: appId, name: body.name, description: body.description, icon: '', status: 'active', createdBy: user._id, createdAt: now, updatedAt: now }
    await col.apps.insertOne(doc)
    await col.members.insertOne({ _id: newId(), appId, userId: user._id, role: 'owner', createdAt: now })
    await initDraft(appId, body.name, user._id)
    audit(user._id, 'app.create', appId, { name: body.name })
    return ok(view(doc, 'owner'))
  })

  app.get('/admin-api/apps/:appId', async (req) => {
    const { appId } = req.params as { appId: string }
    const { app: doc, role } = await requireAppRole(req, appId, 'viewer')
    const manifest = await draftManifest(appId)
    const grants = await col.grants.find({ appId }).sort({ createdAt: -1 }).toArray()
    return ok({ ...view(doc, role), manifest: manifest.manifest, manifestErrors: manifest.errors, grants })
  })

  app.patch('/admin-api/apps/:appId', async (req) => {
    const { appId } = req.params as { appId: string }
    const body = parseBody(patchSchema, req.body)
    const { user } = await requireAppRole(req, appId, body.status || body.schedule ? 'owner' : 'developer')
    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (body.name !== undefined)
      set.name = body.name
    if (body.description !== undefined)
      set.description = body.description
    if (body.icon !== undefined)
      set.icon = body.icon
    if (body.status)
      set.status = body.status
    if (body.schedule) {
      set.schedule = {
        startAt: body.schedule.startAt ? new Date(body.schedule.startAt) : null,
        endAt: body.schedule.endAt ? new Date(body.schedule.endAt) : null,
      }
    }
    await col.apps.updateOne({ _id: appId }, { $set: set })
    invalidateApp(appId)
    audit(user._id, 'app.update', appId, body)
    const doc = await col.apps.findOne({ _id: appId })
    return ok(view(doc!, await appRole(user, appId)))
  })

  app.delete('/admin-api/apps/:appId', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'owner')
    await col.apps.updateOne({ _id: appId }, { $set: { status: 'deleted', deletedAt: new Date(), updatedAt: new Date() } })
    invalidateApp(appId)
    audit(user._id, 'app.delete', appId)
    return ok({})
  })

  // ---------- 成员 ----------
  app.get('/admin-api/apps/:appId/members', async (req) => {
    const { appId } = req.params as { appId: string }
    await requireAppRole(req, appId, 'viewer')
    const members = await col.members.find({ appId }).toArray()
    const users = await col.adminUsers.find({ _id: { $in: members.map(m => m.userId) } }).toArray()
    const byId = new Map(users.map(u => [u._id, u]))
    return ok(members.map(m => ({ userId: m.userId, role: m.role, name: byId.get(m.userId)?.name ?? m.userId, avatar: byId.get(m.userId)?.avatar ?? '', email: byId.get(m.userId)?.email ?? '' })))
  })

  app.put('/admin-api/apps/:appId/members/:userId', async (req) => {
    const { appId, userId } = req.params as { appId: string, userId: string }
    const { user } = await requireAppRole(req, appId, 'owner')
    const { role } = parseBody(z.object({ role: z.enum(['owner', 'developer', 'viewer']) }), req.body)
    if (!await col.adminUsers.findOne({ _id: userId }))
      throw err.notFound('用户不存在（需要先登录过后台）')
    if (userId === user._id && role !== 'owner' && (await col.members.countDocuments({ appId, role: 'owner' })) <= 1)
      throw err.invalid('应用至少需要一位负责人')
    await col.members.updateOne({ appId, userId }, { $set: { role }, $setOnInsert: { _id: newId(), appId, userId, createdAt: new Date() } }, { upsert: true })
    audit(user._id, 'member.set', appId, { userId, role })
    return ok({})
  })

  app.delete('/admin-api/apps/:appId/members/:userId', async (req) => {
    const { appId, userId } = req.params as { appId: string, userId: string }
    const { user } = await requireAppRole(req, appId, 'owner')
    const m = await col.members.findOne({ appId, userId })
    if (m?.role === 'owner' && (await col.members.countDocuments({ appId, role: 'owner' })) <= 1)
      throw err.invalid('应用至少需要一位负责人')
    await col.members.deleteOne({ appId, userId })
    audit(user._id, 'member.remove', appId, { userId })
    return ok({})
  })

  app.get('/admin-api/users', async (req) => {
    requireAdmin(req)
    const q = String((req.query as { q?: string }).q ?? '').trim()
    const filter = q ? { $or: [{ name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { email: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }] } : {}
    const users = await col.adminUsers.find(filter).limit(20).toArray()
    return ok(users.map(u => ({ id: u._id, name: u.name, avatar: u.avatar, email: u.email, isPlatformAdmin: u.isPlatformAdmin })))
  })
}
