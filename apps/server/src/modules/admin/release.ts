import { appUrl } from '@app-platform/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config'
import { getDevErrors, clearDevErrors } from '../../core/dev-errors'
import { issuePreviewTicket } from '../../core/preview-access'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { col } from '../../lib/mongo'
import { compareManifest, release, requestBuild } from '../build/service'
import { requirePerm } from './auth'

export function registerReleaseRoutes(app: FastifyInstance) {
  // ---------- 预览 ----------
  app.post('/admin-api/apps/:appId/preview-url', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user, perms } = await requirePerm(req, appId, 'app.view')
    const body = parseBody(z.object({
      channel: z.enum(['dev', 'beta', 'prod']).default('dev'),
      identity: z.enum(['self', 'guest', 'test']).default('self'),
      path: z.string().startsWith('/').max(500).default('/'),
      /** 保留兼容；普通和二维码预览票据统一有效 30 分钟 */
      qr: z.boolean().default(false),
    }), req.body)
    // 观察者只能看已构建的测试版，开发版草稿仍要求后台视图权限。
    if (body.channel === 'dev' && !perms.has('console.view'))
      throw err.forbidden('需要「查看后台视图与监控」权限才能预览开发版')
    const origin = `https://${config.baseDomain}`
    if (body.channel === 'prod')
      return ok({ url: `${appUrl(appId, 'prod', config.baseDomain)}${body.path.replace(/^\/+/, '')}` })
    const t = issuePreviewTicket(appId, body.channel, user._id, body.identity, 30 * 60)
    return ok({ url: `${origin}/__platform/preview-auth?t=${encodeURIComponent(t)}&next=${encodeURIComponent(body.path)}` })
  })

  app.get('/admin-api/apps/:appId/dev-errors', async (req) => {
    const { appId } = req.params as { appId: string }
    await requirePerm(req, appId, 'console.view')
    const since = Number((req.query as { since?: string }).since ?? 0)
    return ok(await getDevErrors(appId, since, 100))
  })

  app.delete('/admin-api/apps/:appId/dev-errors', async (req) => {
    const { appId } = req.params as { appId: string }
    await requirePerm(req, appId, 'app.edit')
    await clearDevErrors(appId)
    return ok({})
  })

  // ---------- 构建 / 发布 ----------
  app.get('/admin-api/apps/:appId/builds', async (req) => {
    const { appId } = req.params as { appId: string }
    await requirePerm(req, appId, 'console.view')
    const builds = await col.builds.find({ appId }, { projection: { files: 0 } }).sort({ createdAt: -1 }).limit(30).toArray()
    const releases = await col.releases.find({ appId }).sort({ createdAt: -1 }).limit(30).toArray()
    const ids = [...new Set([...builds.map(b => b.createdBy), ...releases.map(r => r.createdBy)])]
    const users = await col.adminUsers.find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray()
    const names = new Map(users.map(u => [u._id, u.name]))
    return ok({
      builds: builds.map(b => ({ ...b, id: b._id, createdByName: names.get(b.createdBy) ?? b.createdBy })),
      releases: releases.map(r => ({ ...r, id: r._id, createdByName: names.get(r.createdBy) ?? r.createdBy })),
    })
  })

  app.post('/admin-api/apps/:appId/builds', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requirePerm(req, appId, 'app.edit')
    const b = await requestBuild(appId, user._id)
    return ok({ id: b._id, status: b.status })
  })

  app.get('/admin-api/apps/:appId/builds/:buildId', async (req) => {
    const { appId, buildId } = req.params as { appId: string, buildId: string }
    await requirePerm(req, appId, 'console.view')
    const b = await col.builds.findOne({ _id: buildId, appId }, { projection: { files: 0 } })
    if (!b)
      throw err.notFound('构建不存在')
    // 审批前重新对比（期间可能有能力审批通过或线上版本变化）
    const cmp = b.status === 'success' ? await compareManifest(appId, b.manifest ?? null) : null
    return ok({ ...b, id: b._id, confirmations: cmp?.confirmations ?? b.confirmations })
  })

  app.post('/admin-api/apps/:appId/release', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requirePerm(req, appId, 'app.publish')
    const body = parseBody(z.object({ buildId: z.string(), note: z.string().max(200).default(''), confirmed: z.boolean().default(false) }), req.body)
    const b = await col.builds.findOne({ _id: body.buildId, appId })
    if (!b || b.status !== 'success')
      throw err.invalid('只能发布构建成功的测试版')
    const cmp = await compareManifest(appId, b.manifest ?? null)
    if (cmp.confirmations.length && !body.confirmed)
      throw err.invalid('本次发布包含需要确认的变更', { confirmations: cmp.confirmations })
    const rel = await release(appId, b._id, user._id, body.note, 'release')
    return ok({ id: rel._id })
  })

  app.post('/admin-api/apps/:appId/rollback', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requirePerm(req, appId, 'app.publish')
    const { releaseId } = parseBody(z.object({ releaseId: z.string() }), req.body)
    const r = await col.releases.findOne({ _id: releaseId, appId })
    if (!r)
      throw err.notFound('发布记录不存在')
    const rel = await release(appId, r.buildId, user._id, `回滚到 ${r.createdAt.toLocaleString('zh-CN')} 的版本`, 'rollback')
    return ok({ id: rel._id })
  })
}
