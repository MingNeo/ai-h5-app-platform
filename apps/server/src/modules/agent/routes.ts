import type { Attachment } from '@app-platform/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config'
import { getSnapshot, restoreSnapshot, createSnapshot } from '../../core/drafts'
import { audit } from '../../lib/audit'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { availableModels, llmConfigured } from '../../lib/llm'
import { col } from '../../lib/mongo'
import { store } from '../../lib/store'
import { newId } from '../../lib/tokens'
import { requireAppRole } from '../admin/auth'
import { subscribeSession } from './events'
import { enqueueTurn, stopTurn } from './runner'

const attachmentSchema = z.object({
  type: z.enum(['file', 'collection', 'error', 'image']),
  value: z.string().max(4 * 1024 * 1024),
  label: z.string().max(100).optional(),
})

async function sessionOf(sessionId: string) {
  const s = await col.sessions.findOne({ _id: sessionId })
  if (!s)
    throw err.notFound('会话不存在')
  return s
}

export function registerAgentRoutes(app: FastifyInstance) {
  app.get('/admin-api/agent/config', async () => ok({
    configured: llmConfigured(),
    models: availableModels(),
    defaultModel: availableModels().includes(config.llm.defaultModel) ? config.llm.defaultModel : availableModels()[0],
    visionModels: config.llm.visionModels,
    contextTokens: config.llm.contextTokens,
  }))

  app.get('/admin-api/apps/:appId/sessions', async (req) => {
    const { appId } = req.params as { appId: string }
    await requireAppRole(req, appId, 'viewer')
    const list = await col.sessions.find({ appId }).sort({ updatedAt: -1 }).limit(100).toArray()
    const running = await col.turns.find({ appId, status: { $in: ['queued', 'running'] } }, { projection: { sessionId: 1, status: 1 } }).toArray()
    const runningBy = new Map(running.map(t => [t.sessionId, t.status]))
    const tokens = Number(await store.get(`agent:apptok:${appId}:${new Date().toISOString().slice(0, 10)}`) ?? 0)
    return ok({
      sessions: list.map(s => ({ id: s._id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, usage: s.usage, status: runningBy.get(s._id) ?? 'idle' })),
      todayTokens: tokens,
    })
  })

  app.post('/admin-api/apps/:appId/sessions', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'developer')
    const { title } = parseBody(z.object({ title: z.string().max(50).default('新会话') }), req.body)
    const now = new Date()
    const id = newId()
    await col.sessions.insertOne({ _id: id, appId, title, createdBy: user._id, createdAt: now, updatedAt: now, eventSeq: 0, usage: { inputTokens: 0, outputTokens: 0 } })
    return ok({ id, title })
  })

  app.patch('/admin-api/sessions/:id', async (req) => {
    const s = await sessionOf((req.params as { id: string }).id)
    await requireAppRole(req, s.appId, 'developer')
    const { title } = parseBody(z.object({ title: z.string().trim().min(1).max(50) }), req.body)
    await col.sessions.updateOne({ _id: s._id }, { $set: { title } })
    return ok({})
  })

  app.delete('/admin-api/sessions/:id', async (req) => {
    const s = await sessionOf((req.params as { id: string }).id)
    await requireAppRole(req, s.appId, 'developer')
    if (await col.turns.findOne({ sessionId: s._id, status: { $in: ['queued', 'running'] } }))
      throw err.invalid('会话中还有任务在执行，请先停止')
    await Promise.all([col.sessions.deleteOne({ _id: s._id }), col.turns.deleteMany({ sessionId: s._id }), col.events.deleteMany({ sessionId: s._id })])
    return ok({})
  })

  /** 会话的全部事件（首次加载），之后用 /stream?after=seq 续传 */
  app.get('/admin-api/sessions/:id/events', async (req) => {
    const s = await sessionOf((req.params as { id: string }).id)
    await requireAppRole(req, s.appId, 'viewer')
    const events = await col.events.find({ sessionId: s._id }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray()
    const turns = await col.turns.find({ sessionId: s._id }, { projection: { messages: 0 } }).sort({ index: 1 }).toArray()
    return ok({
      session: { id: s._id, title: s.title, usage: s.usage, summary: Boolean(s.summary) },
      events,
      turns: turns.map(t => ({ id: t._id, status: t.status, planMode: t.planMode, createdBy: t.createdBy })),
    })
  })

  app.get('/admin-api/sessions/:id/stream', async (req, reply) => {
    const s = await sessionOf((req.params as { id: string }).id)
    await requireAppRole(req, s.appId, 'viewer')
    const after = Number((req.query as { after?: string }).after ?? 0)
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', 'connection': 'keep-alive' })
    const buffered: unknown[] = []
    let ready = false
    // seq 按轮次分段预留，排队的 turn.queued 会越过运行中轮次的段，
    // 所以不能按单调递增过滤，只按是否已发送去重
    const sent = new Set<number>()
    const send = (ev: { seq: number }) => {
      if (ev.seq <= after || sent.has(ev.seq))
        return
      sent.add(ev.seq)
      raw.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`)
    }
    // 先订阅再补发历史，避免中间漏事件
    const unsub = subscribeSession(s._id, (ev) => {
      if (!ready)
        buffered.push(ev)
      else send(ev)
    })
    const missed = await col.events.find({ sessionId: s._id, seq: { $gt: after } }, { projection: { _id: 0 } }).sort({ seq: 1 }).toArray()
    for (const ev of missed)
      send(ev as any)
    for (const ev of buffered.sort((a: any, b: any) => a.seq - b.seq))
      send(ev as any)
    ready = true
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000)
    req.raw.on('close', () => {
      clearInterval(ping)
      unsub()
    })
  })

  app.post('/admin-api/sessions/:id/messages', async (req) => {
    const s = await sessionOf((req.params as { id: string }).id)
    const { user } = await requireAppRole(req, s.appId, 'developer')
    const body = parseBody(z.object({
      message: z.string().trim().min(1).max(20000),
      attachments: z.array(attachmentSchema).max(10).default([]),
      planMode: z.boolean().default(false),
      model: z.string().optional(),
    }), req.body)
    if (!llmConfigured())
      throw err.invalid('平台未配置模型服务（LLM_BASE_URL）')
    const models = availableModels()
    const model = body.model && models.includes(body.model) ? body.model : (models.includes(config.llm.defaultModel) ? config.llm.defaultModel : models[0]!)
    if ((await col.turns.countDocuments({ sessionId: s._id })) === 0 && s.title === '新会话')
      await col.sessions.updateOne({ _id: s._id }, { $set: { title: body.message.replace(/\s+/g, ' ').slice(0, 24) } })
    try {
      const turn = await enqueueTurn({ sessionId: s._id, appId: s.appId, userId: user._id, message: body.message, attachments: body.attachments as Attachment[], planMode: body.planMode, model })
      return ok({ turnId: turn._id })
    }
    catch (e) {
      throw err.quota((e as Error).message)
    }
  })

  app.post('/admin-api/turns/:id/stop', async (req) => {
    const t = await col.turns.findOne({ _id: (req.params as { id: string }).id })
    if (!t)
      throw err.notFound('任务不存在')
    await requireAppRole(req, t.appId, 'developer')
    await stopTurn(t._id)
    return ok({})
  })

  /** 撤销某一轮的改动：只恢复该轮改过的文件；之后又被改过的文件会提示冲突 */
  app.post('/admin-api/turns/:id/revert', async (req) => {
    const t = await col.turns.findOne({ _id: (req.params as { id: string }).id })
    if (!t)
      throw err.notFound('任务不存在')
    const { user } = await requireAppRole(req, t.appId, 'developer')
    if (!t.snapshotBefore || !t.changes.length)
      throw err.invalid('这一轮没有文件改动')
    const before = await getSnapshot(t.appId, t.snapshotBefore)
    const paths = t.changes.map(c => c.path)
    const { force } = parseBody(z.object({ force: z.boolean().default(false) }), req.body)
    if (t.snapshotAfter && !force) {
      const after = await getSnapshot(t.appId, t.snapshotAfter)
      const afterMap = new Map(after.files.map(f => [f.path, f.hash]))
      const draft = await col.draftFiles.find({ appId: t.appId, path: { $in: paths } }).toArray()
      const draftMap = new Map(draft.map(f => [f.path, f.hash]))
      const conflicts = paths.filter(p => afterMap.get(p) !== draftMap.get(p))
      if (conflicts.length)
        throw err.invalid(`以下文件在这一轮之后又被修改过：${conflicts.join('、')}。确认撤销会一并丢弃这些后续修改。`, { conflicts })
    }
    const changes = await restoreSnapshot(t.appId, before, { userId: user._id, paths })
    const snap = await createSnapshot(t.appId, { kind: 'rollback', message: `撤销 AI 改动：${t.message.slice(0, 30)}`, userId: user._id })
    audit(user._id, 'turn.revert', t.appId, { turnId: t._id })
    return ok({ changes, snapshotId: snap._id })
  })

  /** 从某条消息处回滚：恢复到该轮开始前的代码 */
  app.post('/admin-api/turns/:id/rollback', async (req) => {
    const t = await col.turns.findOne({ _id: (req.params as { id: string }).id })
    if (!t?.snapshotBefore)
      throw err.notFound('任务不存在')
    const { user } = await requireAppRole(req, t.appId, 'developer')
    const before = await getSnapshot(t.appId, t.snapshotBefore)
    const changes = await restoreSnapshot(t.appId, before, { userId: user._id })
    const snap = await createSnapshot(t.appId, { kind: 'rollback', message: `回滚到「${t.message.slice(0, 30)}」之前`, userId: user._id })
    audit(user._id, 'turn.rollback', t.appId, { turnId: t._id })
    return ok({ changes, snapshotId: snap._id })
  })
}
