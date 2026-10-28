import { ACL_PRESETS, APP_PERMS, APP_ROLES, type AppPerm, appUrl, MANIFEST_FILE, permsOf, ROLE_PERMS, validateAppId } from '@app-platform/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config'
import { draftManifest, invalidateApp } from '../../core/apps'
import { initDraft, readDraftText, writeDraft } from '../../core/drafts'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { type AppDoc, col } from '../../lib/mongo'
import { newId } from '../../lib/tokens'
import { appAccess, requireAdmin, requirePerm } from './auth'

async function readDraftManifestObject(appId: string): Promise<Record<string, any>> {
  const text = await readDraftText(appId, MANIFEST_FILE)
  if (text === null)
    throw err.notFound('缺少 manifest.json')
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  }
  catch {
    throw err.invalid('manifest.json 不是合法的 JSON，请先在代码里修正')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw err.invalid('manifest.json 内容需要是对象')
  return manifest as Record<string, any>
}

export function appUrls(appId: string) {
  return {
    prod: appUrl(appId, 'prod', config.baseDomain),
    beta: appUrl(appId, 'beta', config.baseDomain),
    dev: appUrl(appId, 'dev', config.baseDomain),
  }
}

function view(app: AppDoc, role: string | null, perms: AppPerm[] = []) {
  const urls = appUrls(app._id)
  // 开发渠道入口只对能看后台视图的人展示；观察者只能拿线上和测试版。
  const full = perms.includes('console.view')
  return {
    appId: app._id,
    name: app.name,
    description: app.description,
    icon: app.icon,
    status: app.status,
    schedule: app.schedule ?? null,
    observeOpen: Boolean(app.observeOpen),
    betaBuildId: app.betaBuildId ?? null,
    prodBuildId: app.prodBuildId ?? null,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    role,
    perms,
    urls: full ? urls : { prod: urls.prod, beta: urls.beta },
  }
}

const createSchema = z.object({
  appId: z.string().trim().optional(),
  name: z.string().trim().min(1).max(40),
  description: z.string().max(200).default(''),
})

/** 从应用名推导 slug；中文名等无可读字符时回退到 app */
function slugOf(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '')
  return slug.length >= 3 ? slug : ''
}

/** 自动生成 appId：名字可读时用 slug，否则用 app；冲突或非法时追加随机后缀重试 */
async function generateAppId(name: string) {
  const base = slugOf(name) || 'app'
  for (let i = 0; i < 10; i++) {
    const candidate = i === 0 && !validateAppId(base) && !(await col.apps.findOne({ _id: base }))
      ? base
      : `${base}-${newId(4)}`
    if (!validateAppId(candidate) && !(await col.apps.findOne({ _id: candidate })))
      return candidate
  }
  throw err.invalid('自动生成 appId 失败，请手动填写')
}

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
    const access = new Map<string, { role: string, perms: AppPerm[] }>()
    if (user.isPlatformAdmin) {
      apps = await col.apps.find({ status: { $ne: 'deleted' } }).sort({ updatedAt: -1 }).toArray()
      for (const a of apps)
        access.set(a._id, { role: 'owner', perms: [...ROLE_PERMS.owner] })
    }
    else {
      const members = await col.members.find({ userId: user._id }).toArray()
      for (const m of members)
        access.set(m.appId, { role: m.role, perms: [...permsOf(m.role, m.perms)] })
      // 「允许观察」的应用也出现在列表里，观察者点进去只能看到概览
      apps = await col.apps.find({
        $or: [{ _id: { $in: [...access.keys()] } }, { observeOpen: true }],
        status: { $ne: 'deleted' },
      }).sort({ updatedAt: -1 }).toArray()
    }
    return ok(apps.map((a) => {
      const acc = access.get(a._id)
      return view(a, acc?.role ?? 'observer', acc?.perms ?? [...ROLE_PERMS.observer])
    }))
  })

  app.post('/admin-api/apps', async (req) => {
    const user = requireAdmin(req)
    const body = parseBody(createSchema, req.body)
    const manual = body.appId?.trim().toLowerCase() ?? ''
    const appId = manual || await generateAppId(body.name)
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
    return ok(view(doc, 'owner', [...ROLE_PERMS.owner]))
  })

  app.get('/admin-api/apps/:appId', async (req) => {
    const { appId } = req.params as { appId: string }
    const { app: doc, role, perms } = await requirePerm(req, appId, 'app.view')
    const base = view(doc, role, [...perms])
    // 只有 app.view 的人只拿概览字段；草稿 manifest 与能力授权属于运营/开发信息。
    if (!perms.has('console.view'))
      return ok({ ...base, manifest: null, manifestErrors: [], grants: [] })
    const manifest = await draftManifest(appId)
    const grants = await col.grants.find({ appId }).sort({ createdAt: -1 }).toArray()
    return ok({ ...base, manifest: manifest.manifest, manifestErrors: manifest.errors, grants })
  })

  app.patch('/admin-api/apps/:appId', async (req) => {
    const { appId } = req.params as { appId: string }
    const body = parseBody(patchSchema, req.body)
    const manage = Boolean(body.status || body.schedule)
    const { user, perms } = await requirePerm(req, appId, ...(manage ? ['app.edit', 'app.manage'] as const : ['app.edit'] as const))
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
    return ok(view(doc!, (await appAccess(user, appId))?.role ?? null, [...perms]))
  })

  // 登录要求由 manifest.json 的 requireLogin 控制，这里做便捷开关（改草稿文件，随发布生效）
  app.put('/admin-api/apps/:appId/require-login', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requirePerm(req, appId, 'app.edit')
    const { requireLogin } = parseBody(z.object({ requireLogin: z.boolean() }), req.body)
    const manifest = await readDraftManifestObject(appId)
    if (manifest.requireLogin === requireLogin)
      return ok({ requireLogin })
    manifest.requireLogin = requireLogin
    await writeDraft(appId, MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, { userId: user._id })
    audit(user._id, 'app.requireLogin', appId, { requireLogin })
    return ok({ requireLogin })
  })

  // 「允许其他人观察」：打开后任何登录后台的人都能看到概览和内嵌预览，无需加成员
  app.put('/admin-api/apps/:appId/observe', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requirePerm(req, appId, 'app.manage')
    const { open } = parseBody(z.object({ open: z.boolean() }), req.body)
    await col.apps.updateOne({ _id: appId }, { $set: { observeOpen: open, updatedAt: new Date() } })
    invalidateApp(appId)
    audit(user._id, 'app.observe', appId, { open })
    return ok({ observeOpen: open })
  })

  // 数据集合的访问权限（acl）同样来自 manifest.json，这里做便捷开关（改草稿文件，随发布生效）
  app.put('/admin-api/apps/:appId/collections/:name/acl', async (req) => {
    const { appId, name } = req.params as { appId: string, name: string }
    const { user } = await requirePerm(req, appId, 'app.edit')
    const { acl } = parseBody(z.object({ acl: z.enum(ACL_PRESETS) }), req.body)
    const manifest = await readDraftManifestObject(appId)
    const collections = manifest.collections as Record<string, { acl?: string }> | undefined
    const col = collections?.[name]
    if (!col)
      throw err.notFound(`集合 ${name} 不存在`)
    if (col.acl === acl)
      return ok({ acl })
    if (acl === 'public_submit')
      throw err.invalid('public_submit 已废弃：按用户隔离数据必须要求登录，不允许靠游客身份免登录隔离，请改用 submit_only')
    const from = col.acl
    col.acl = acl
    await writeDraft(appId, MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, { userId: user._id })
    audit(user._id, 'app.collectionAcl', appId, { collection: name, from, to: acl })
    return ok({ acl })
  })

  app.delete('/admin-api/apps/:appId', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requirePerm(req, appId, 'app.manage')
    await col.apps.updateOne({ _id: appId }, { $set: { status: 'deleted', deletedAt: new Date(), updatedAt: new Date() } })
    invalidateApp(appId)
    audit(user._id, 'app.delete', appId)
    return ok({})
  })
  app.get('/admin-api/apps/:appId/members', async (req) => {
    const { appId } = req.params as { appId: string }
    await requirePerm(req, appId, 'console.view')
    const members = await col.members.find({ appId }).toArray()
    const users = await col.adminUsers.find({ _id: { $in: members.map(m => m.userId) } }).toArray()
    const byId = new Map(users.map(u => [u._id, u]))
    return ok(members.map(m => ({
      userId: m.userId,
      role: m.role,
      perms: [...permsOf(m.role, m.perms)],
      name: byId.get(m.userId)?.name ?? m.userId,
      avatar: byId.get(m.userId)?.avatar ?? '',
      email: byId.get(m.userId)?.email ?? '',
    })))
  })

  app.put('/admin-api/apps/:appId/members/:userId', async (req) => {
    const { appId, userId } = req.params as { appId: string, userId: string }
    const { user } = await requirePerm(req, appId, 'app.manage')
    const { role, perms } = parseBody(z.object({
      role: z.enum(APP_ROLES),
      /** 可选：显式覆盖角色包；不传则按角色推导 */
      perms: z.array(z.enum(APP_PERMS)).max(APP_PERMS.length).optional(),
    }), req.body)
    if (!await col.adminUsers.findOne({ _id: userId }))
      throw err.notFound('用户不存在（需要先登录过后台）')
    if (!user.isPlatformAdmin && userId === user._id && role !== 'owner' && (await col.members.countDocuments({ appId, role: 'owner' })) <= 1)
      throw err.invalid('不能将应用唯一负责人降级，请先指定其他负责人')
    // perms 为 null 表示沿用角色包
    await col.members.updateOne({ appId, userId }, {
      $set: { role, perms: perms ?? null },
      $setOnInsert: { _id: newId(), appId, userId, createdAt: new Date() },
    }, { upsert: true })
    audit(user._id, 'member.set', appId, { userId, role, perms })
    return ok({})
  })

  app.delete('/admin-api/apps/:appId/members/:userId', async (req) => {
    const { appId, userId } = req.params as { appId: string, userId: string }
    const { user } = await requirePerm(req, appId, 'app.manage')
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
