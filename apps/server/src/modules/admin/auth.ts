import { APP_PERMS, type AppPerm, type AppRole, PERM_LABELS, permsOf } from '@app-platform/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../../config'
import { adminViewCollections } from '../../core/admin-view'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody, parseCookies } from '../../lib/http'
import { type AdminUserDoc, type AppDoc, col } from '../../lib/mongo'
import { store } from '../../lib/store'
import { hashToken, newId, randomToken, signToken, verifyToken } from '../../lib/tokens'

const SESSION_TTL = 7 * 86400
const TICKET_TTL = 60
/** 刷新免跳飞书用的恢复 cookie：Path 限定在登录相关接口，应用代码读写不到 /admin-api/auth/ 之外的任何请求 */
const RESUME_COOKIE = '__Secure-adm_resume'
const RESUME_PATH = '/admin-api/auth/'

/**
 * 后台与应用同源，**不能使用 cookie 会话**：应用页面发起的同源请求会自动带上后台 cookie，
 * `Origin` 与 `X-App-Admin` 都能伪造，等于任何应用都能冒充管理员。
 * 因此会话 token 通过 URL fragment 一次性下发、前端只存内存、
 * 请求时用 Authorization 头携带。
 * 刷新后 token 必丢：额外发一个 HttpOnly + Path=/admin-api/auth/ + SameSite=Strict 的恢复 cookie，
 * 只能在浏览器顶层导航时换一次性票据重新交换，fetch/iframe 发起的请求会被拒；记录哈希后存 Mongo，
 * 跨进程重启存活。详见 docs/security-boundary.md。
 */
function bearerToken(req: FastifyRequest): string | undefined {
  const raw = req.headers.authorization
  if (raw?.startsWith('Bearer '))
    return raw.slice(7).trim() || undefined
  return undefined
}

async function createSession(userId: string) {
  const token = randomToken()
  await store.set(`adm:sess:${token}`, userId, SESSION_TTL)
  return token
}

/** 登录成功时一并发恢复 cookie；只存哈希，泄库拿不到可用原文 */
async function issueResume(reply: FastifyReply, userId: string) {
  const token = randomToken()
  const now = new Date()
  await col.adminResumes.insertOne({
    _id: hashToken(token),
    userId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL * 1000),
  })
  reply.setCookie(RESUME_COOKIE, token, {
    path: RESUME_PATH,
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: SESSION_TTL,
  })
}

function clearResumeCookie(reply: FastifyReply) {
  reply.clearCookie(RESUME_COOKIE, { path: RESUME_PATH })
}

/** 只接受浏览器顶层导航（地址栏跳转/location.href），拒绝应用页面用 fetch/iframe 带 cookie 调用 */
function isTopNavigation(req: FastifyRequest) {
  const mode = req.headers['sec-fetch-mode']
  const dest = req.headers['sec-fetch-dest']
  if (mode !== undefined && mode !== 'navigate')
    return false
  if (dest !== undefined && dest !== 'document')
    return false
  return true
}

async function loadAdmin(req: FastifyRequest): Promise<AdminUserDoc | null> {
  const token = bearerToken(req)
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

export interface AppAccess {
  app: AppDoc
  role: AppRole
  perms: Set<AppPerm>
}

/** 平台管理员对所有应用等价于 owner，权限全开 */
export async function appAccess(user: AdminUserDoc, appId: string): Promise<{ role: AppRole, perms: Set<AppPerm> } | null> {
  if (user.isPlatformAdmin)
    return { role: 'owner', perms: new Set<AppPerm>(APP_PERMS) }
  const m = await col.members.findOne({ appId, userId: user._id })
  if (!m)
    return null
  return { role: m.role, perms: permsOf(m.role, m.perms) }
}

function denied(perm: AppPerm) {
  return err.forbidden(`需要「${PERM_LABELS[perm]}」权限`)
}

/** 鉴权的唯一入口：按权限判断，不按角色等级比较 */
export async function requirePerm(req: FastifyRequest, appId: string, ...need: AppPerm[]) {
  const user = requireAdmin(req)
  const app = await col.apps.findOne({ _id: appId, status: { $ne: 'deleted' } })
  if (!app)
    throw err.notFound('应用不存在')
  const access = await appAccess(user, appId)
  if (!access)
    throw err.forbidden('没有该应用的权限')
  for (const p of need) {
    if (!access.perms.has(p))
      throw denied(p)
  }
  return { user, app, role: access.role, perms: access.perms } satisfies { user: AdminUserDoc, app: AppDoc, role: AppRole, perms: Set<AppPerm> }
}

/**
 * 读数据：有 data.read 可读任意已声明集合；
 * 只有 console.view 时，仅能读后台视图（admin.json）里引用到的集合。
 */
export async function requireDataRead(req: FastifyRequest, appId: string, env: 'dev' | 'prod', colName: string) {
  const user = requireAdmin(req)
  const app = await col.apps.findOne({ _id: appId, status: { $ne: 'deleted' } })
  if (!app)
    throw err.notFound('应用不存在')
  const access = await appAccess(user, appId)
  if (!access)
    throw err.forbidden('没有该应用的权限')
  if (!access.perms.has('data.read')) {
    if (!access.perms.has('console.view'))
      throw denied('data.read')
    const declared = await adminViewCollections(appId, env)
    if (!declared.has(colName))
      throw err.forbidden(`需要「${PERM_LABELS['data.read']}」权限才能读取集合 ${colName}`)
  }
  return { user, app, role: access.role, perms: access.perms }
}

function meView(u: AdminUserDoc) {
  return { id: u._id, name: u.name, avatar: u.avatar, email: u.email, isPlatformAdmin: u.isPlatformAdmin }
}

/** 邮箱或 openId 命中 PLATFORM_ADMINS 配置 */
export function isConfiguredAdmin(email: string, openId: string | undefined) {
  return config.admin.platformAdmins.some(a => a === email || a === openId)
}

/** 服务启动时把 PLATFORM_ADMINS 配置同步到库里，不用等对应账号重新登录 */
export async function syncPlatformAdmins() {
  const list = config.admin.platformAdmins
  if (!list.length)
    return
  const res = await col.adminUsers.updateMany(
    { isPlatformAdmin: false, $or: [{ email: { $in: list } }, { feishuOpenId: { $in: list } }] },
    { $set: { isPlatformAdmin: true } },
  )
  if (res.modifiedCount)
    console.log(`[auth] PLATFORM_ADMINS 生效：${res.modifiedCount} 个账号成为平台管理员`)
}

async function upsertUser(info: { openId: string, name: string, avatar: string, email: string }) {
  const isListed = isConfiguredAdmin(info.email, info.openId)
  // 「首位登录者自动成为平台管理员」只在完全没配置 PLATFORM_ADMINS 时才兜底（纯本地/演示环境），
  // 一旦配置了白名单，谁都不能靠「抢先登录」绕过去——否则任何能登上飞书的人都可能抢到平台管理员。
  const first = config.admin.platformAdmins.length === 0 && (await col.adminUsers.estimatedDocumentCount()) === 0
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

/** 后台请求的 Origin：生产只认入口域名；本地免登时额外放行 localhost / 127.0.0.1 */
function originAllowed(origin: string) {
  if (origin === config.adminOrigin)
    return true
  if (!config.devHosts.length)
    return false
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && config.devHosts.includes(u.hostname.toLowerCase())
  }
  catch {
    return false
  }
}

/** 前端路由路径（不含 /admin 前缀），只允许站内路径 */
function safeRedirect(r: unknown) {
  if (typeof r !== 'string' || !r.startsWith('/') || r.startsWith('//'))
    return '/'
  const path = r.startsWith('/admin/') ? r.slice('/admin'.length) : r
  if (path.startsWith('/admin-api') || path === '/admin')
    return '/'
  return path
}

/** 一次性登录票据：放 URL fragment，很短的有效期，交换后立即作废 */
async function issueLoginTicket(userId: string) {
  const jti = newId()
  const ticket = signToken({ kind: 'adm-ticket', uid: userId, jti }, TICKET_TTL)
  await store.set(`adm:tkt:${jti}`, userId, TICKET_TTL + 60)
  return ticket
}

export function registerAdminAuth(app: FastifyInstance) {
  // 后台接口：Bearer 鉴权；非 GET 仍校验 Origin（无 cookie，天然免疫 CSRF）
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin-api/'))
      return
    if (req.site?.kind !== 'admin')
      throw err.notFound('后台接口需要通过平台入口域名访问')
    if (req.method === 'OPTIONS')
      return reply.status(403).send()
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin
      if (origin && !originAllowed(origin))
        throw err.forbidden('非法来源')
    }
    req.admin = (await loadAdmin(req)) ?? undefined
  })

  app.get('/admin-api/auth/options', async () => {
    // 本地免登时把已有账号列出来，方便切身份（也用于测不同应用角色）
    const devUsers = config.admin.devBypass
      ? (await col.adminUsers.find({}, { projection: { name: 1, email: 1, avatar: 1, isPlatformAdmin: 1, lastLoginAt: 1 } })
          .sort({ lastLoginAt: -1 })
          .limit(50)
          .toArray())
          .map(u => ({ id: u._id, name: u.name, email: u.email, avatar: u.avatar, isPlatformAdmin: u.isPlatformAdmin }))
      : []
    return ok({
      feishu: Boolean(config.admin.feishuAppId),
      devBypass: config.admin.devBypass,
      devUsers,
    })
  })

  // 前端展示用的平台信息（域名后缀等），不涉及敏感数据
  app.get('/admin-api/meta', async () => ok({ baseDomain: config.baseDomain }))

  app.get('/admin-api/auth/me', async (req) => {
    const u = requireAdmin(req)
    return ok(meView(u))
  })

  app.post('/admin-api/auth/logout', async (req, reply) => {
    const token = bearerToken(req)
    if (token)
      await store.del(`adm:sess:${token}`)
    const resumeToken = parseCookies(req.headers.cookie)[RESUME_COOKIE]
    if (resumeToken)
      await col.adminResumes.deleteOne({ _id: hashToken(resumeToken) })
    clearResumeCookie(reply)
    return ok({})
  })

  app.post('/admin-api/auth/dev-login', async (req, reply) => {
    if (!config.admin.devBypass)
      throw err.forbidden('未开启本地免登（DEV_ADMIN_BYPASS）')
    const body = (req.body ?? {}) as { name?: string, userId?: string }
    let id: string
    if (body.userId) {
      // 选已有账号：保留它真实的平台/应用权限，方便本地切身份验证权限
      const existing = await col.adminUsers.findOne({ _id: body.userId })
      if (!existing)
        throw err.notFound('用户不存在')
      id = existing._id
      await col.adminUsers.updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } })
    }
    else {
      const name = String(body.name || '本地开发者').slice(0, 20)
      const openId = `dev:${name}`
      id = await upsertUser({ openId, name, avatar: '', email: '' })
      await col.adminUsers.updateOne({ _id: id }, { $set: { isPlatformAdmin: true } })
    }
    const token = await createSession(id)
    await issueResume(reply, id)
    audit(id, 'admin.login', undefined, { via: 'dev', ...(body.userId ? { asUser: body.userId } : {}) })
    const user = await col.adminUsers.findOne({ _id: id })
    return ok({ token, user: user ? meView(user) : null })
  })

  // 票据换会话：票据一次性，交换后删除
  app.post('/admin-api/auth/exchange', async (req, reply) => {
    const { ticket } = parseBody(z.object({ ticket: z.string().min(1).max(4096) }), req.body)
    const claims = verifyToken<{ kind: string, uid: string, jti: string }>(ticket)
    if (!claims || claims.kind !== 'adm-ticket')
      throw err.forbidden('登录票据无效或已过期')
    const uid = await store.get(`adm:tkt:${claims.jti}`)
    if (!uid || uid !== claims.uid)
      throw err.forbidden('登录票据无效或已过期')
    await store.del(`adm:tkt:${claims.jti}`)
    const user = await col.adminUsers.findOne({ _id: uid })
    if (!user)
      throw err.forbidden('用户不存在')
    const token = await createSession(uid)
    await issueResume(reply, uid)
    return ok({ token, user: meView(user) })
  })

  // 刷新页面后免跳飞书：顶层导航带恢复 cookie 换一次性票据，再走一遍票据交换
  app.get('/admin-api/auth/resume', async (req, reply) => {
    const next = safeRedirect((req.query as any).next)
    if (!isTopNavigation(req))
      return reply.status(403).send()
    const token = parseCookies(req.headers.cookie)[RESUME_COOKIE]
    const doc = token ? await col.adminResumes.findOne({ _id: hashToken(token) }) : null
    const user = doc ? await col.adminUsers.findOne({ _id: doc.userId }) : null
    if (!doc || !user) {
      if (doc)
        await col.adminResumes.deleteOne({ _id: doc._id })
      clearResumeCookie(reply)
      // 恢复失败：走回原来的路径（有飞书配置就自动跳一次，没有就回登录页）
      if (config.admin.feishuAppId)
        return reply.redirect(`/admin-api/auth/feishu/login?redirect=${encodeURIComponent(next)}`)
      return reply.redirect(`/admin/login?redirect=${encodeURIComponent(next)}`)
    }
    // 轮换：旧记录失效，换发新 cookie，避免同一个值被长期重放
    await col.adminResumes.deleteOne({ _id: doc._id })
    await issueResume(reply, user._id)
    const newTicket = await issueLoginTicket(user._id)
    return reply.redirect(`/admin#t=${encodeURIComponent(newTicket)}&next=${encodeURIComponent(next)}`)
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
    audit(id, 'admin.login', undefined, { via: 'feishu', tenantKey: info.data.tenant_key })
    await issueResume(reply, id)
    // fragment 不会发给服务端，也不会出现在 Referer；前端兑换后立即清掉
    const ticket = await issueLoginTicket(id)
    const next = safeRedirect(state.redirect)
    return reply.redirect(`${config.adminOrigin}/admin#t=${encodeURIComponent(ticket)}&next=${encodeURIComponent(next)}`)
  })
}
