import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../../config'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok } from '../../lib/http'
import { type AdminUserDoc, type AppRole, col } from '../../lib/mongo'
import { store } from '../../lib/store'
import { newId, randomToken, signToken, verifyToken } from '../../lib/tokens'

export const ADMIN_COOKIE = '__Host-app_admin'
const SESSION_TTL = 7 * 86400
const ROLE_RANK: Record<AppRole, number> = { viewer: 1, developer: 2, owner: 3 }

async function createSession(reply: FastifyReply, userId: string) {
  const token = randomToken()
  await store.set(`adm:sess:${token}`, userId, SESSION_TTL)
  reply.setCookie(ADMIN_COOKIE, token, { path: '/', httpOnly: true, secure: true, sameSite: 'strict', maxAge: SESSION_TTL })
}

async function loadAdmin(req: FastifyRequest): Promise<AdminUserDoc | null> {
  const token = (req.cookies as Record<string, string | undefined>)[ADMIN_COOKIE]
  if (!token)
    return null
  const uid = await store.get(`adm:sess:${token}`)
  if (!uid)
    return null
  void store.expire(`adm:sess:${token}`, SESSION_TTL)
  return col.adminUsers.findOne({ _id: uid })
}

export function requireAdmin(req: FastifyRequest): AdminUserDoc {
  if (!req.admin)
    throw err.login('请先登录后台')
  return req.admin
}

export function requirePlatformAdmin(req: FastifyRequest) {
  const u = requireAdmin(req)
  if (!u.isPlatformAdmin)
    throw err.forbidden('需要平台管理员权限')
  return u
}

export async function appRole(user: AdminUserDoc, appId: string): Promise<AppRole | null> {
  if (user.isPlatformAdmin)
    return 'owner'
  const m = await col.members.findOne({ appId, userId: user._id })
  return m?.role ?? null
}

export async function requireAppRole(req: FastifyRequest, appId: string, min: AppRole) {
  const user = requireAdmin(req)
  const app = await col.apps.findOne({ _id: appId, status: { $ne: 'deleted' } })
  if (!app)
    throw err.notFound('应用不存在')
  const role = await appRole(user, appId)
  if (!role || ROLE_RANK[role] < ROLE_RANK[min])
    throw err.forbidden(min === 'owner' ? '需要应用负责人权限' : '没有该应用的权限')
  return { user, app, role }
}

async function upsertUser(info: { openId: string, name: string, avatar: string, email: string }) {
  const isListed = config.admin.platformAdmins.some(a => a === info.email || a === info.openId)
  const first = (await col.adminUsers.estimatedDocumentCount()) === 0
  const now = new Date()
  const existing = await col.adminUsers.findOne({ feishuOpenId: info.openId })
  if (existing) {
    await col.adminUsers.updateOne({ _id: existing._id }, {
      $set: { name: info.name, avatar: info.avatar, email: info.email, lastLoginAt: now, ...(isListed ? { isPlatformAdmin: true } : {}) },
    })
    return existing._id
  }
  const id = newId()
  await col.adminUsers.insertOne({ _id: id, feishuOpenId: info.openId, name: info.name, avatar: info.avatar, email: info.email, isPlatformAdmin: isListed || first, createdAt: now, lastLoginAt: now })
  return id
}

function safeRedirect(r: unknown) {
  return typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') ? r : '/'
}

export function registerAdminAuth(app: FastifyInstance) {
  // 后台会话 + CSRF：所有非 GET 请求必须带自定义头（跨源请求会因此触发预检，而后台不开放 CORS）
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin-api/'))
      return
    if (req.site?.kind !== 'admin')
      throw err.notFound()
    if (req.method === 'OPTIONS')
      return reply.status(403).send()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['x-app-admin'] !== '1')
        throw err.forbidden('缺少后台请求头')
      const origin = req.headers.origin
      if (origin && origin !== config.adminOrigin)
        throw err.forbidden('非法来源')
    }
    req.admin = (await loadAdmin(req)) ?? undefined
  })

  app.get('/admin-api/auth/options', async () => ok({
    feishu: Boolean(config.admin.feishuAppId),
    devBypass: config.admin.devBypass,
  }))

  // 前端展示用的平台信息（域名后缀等），不涉及敏感数据
  app.get('/admin-api/meta', async () => ok({ baseDomain: config.baseDomain }))

  app.get('/admin-api/auth/me', async (req) => {
    const u = requireAdmin(req)
    return ok({ id: u._id, name: u.name, avatar: u.avatar, email: u.email, isPlatformAdmin: u.isPlatformAdmin })
  })

  app.post('/admin-api/auth/logout', async (req, reply) => {
    const token = (req.cookies as Record<string, string | undefined>)[ADMIN_COOKIE]
    if (token)
      await store.del(`adm:sess:${token}`)
    reply.clearCookie(ADMIN_COOKIE, { path: '/' })
    return ok({})
  })

  app.post('/admin-api/auth/dev-login', async (req, reply) => {
    if (!config.admin.devBypass)
      throw err.forbidden('未开启本地免登（DEV_ADMIN_BYPASS）')
    const name = String((req.body as { name?: string })?.name || '本地开发者').slice(0, 20)
    const openId = `dev:${name}`
    const id = await upsertUser({ openId, name, avatar: '', email: '' })
    await col.adminUsers.updateOne({ _id: id }, { $set: { isPlatformAdmin: true } })
    await createSession(reply, id)
    audit(id, 'admin.login', undefined, { via: 'dev' })
    return ok({})
  })

  app.get('/admin-api/auth/feishu/login', async (req, reply) => {
    if (!config.admin.feishuAppId)
      throw err.forbidden('未配置飞书登录')
    const state = signToken({ kind: 'feishu', redirect: safeRedirect((req.query as any).redirect) }, 600)
    const redirectUri = `${config.adminOrigin}/admin-api/auth/feishu/callback`
    const url = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=${encodeURIComponent(config.admin.feishuAppId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`
    return reply.redirect(url)
  })

  app.get('/admin-api/auth/feishu/callback', async (req, reply) => {
    const q = req.query as { code?: string, state?: string }
    const state = verifyToken<{ kind: string, redirect: string }>(q.state)
    if (!q.code || !state || state.kind !== 'feishu')
      throw err.forbidden('登录状态已失效，请重新登录')
    const redirectUri = `${config.adminOrigin}/admin-api/auth/feishu/callback`
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: config.admin.feishuAppId, client_secret: config.admin.feishuAppSecret, code: q.code, redirect_uri: redirectUri }),
    }).then(r => r.json() as Promise<{ code?: number, access_token?: string, error_description?: string }>)
    if (!tokenRes.access_token)
      throw err.forbidden(`飞书登录失败：${tokenRes.error_description ?? tokenRes.code}`)
    const info = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { authorization: `Bearer ${tokenRes.access_token}` },
    }).then(r => r.json() as Promise<{ code: number, msg?: string, data?: { open_id: string, name: string, avatar_url?: string, email?: string, enterprise_email?: string, tenant_key?: string } }>)
    if (info.code !== 0 || !info.data)
      throw err.forbidden(`获取飞书用户信息失败：${info.msg}`)
    if (config.admin.feishuTenantKey && info.data.tenant_key !== config.admin.feishuTenantKey)
      throw err.forbidden('仅限公司飞书账号登录')
    const id = await upsertUser({
      openId: info.data.open_id,
      name: info.data.name,
      avatar: info.data.avatar_url ?? '',
      email: info.data.enterprise_email || info.data.email || '',
    })
    await createSession(reply, id)
    audit(id, 'admin.login', undefined, { via: 'feishu' })
    return reply.redirect(state.redirect)
  })
}
