import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createSnapshot, currentFiles, deleteDraft, getSnapshot, listDraft, moveDraft, readDraft, restoreSnapshot, writeDraft } from '../../core/drafts'
import { audit } from '../../lib/audit'
import { blobs } from '../../lib/blob'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { TEXT_EXT } from '../../lib/mime'
import { col, type SnapshotFile } from '../../lib/mongo'
import { requireAppRole } from './auth'

function encode(path: string, data: Buffer) {
  return TEXT_EXT.test(path) ? { encoding: 'utf8' as const, content: data.toString('utf8') } : { encoding: 'base64' as const, content: data.toString('base64') }
}

async function fileAt(appId: string, ref: string, path: string): Promise<Buffer | null> {
  let files: SnapshotFile[]
  if (ref === 'draft')
    files = await currentFiles(appId)
  else files = (await getSnapshot(appId, ref)).files
  const f = files.find(x => x.path === path)
  return f ? blobs.get(f.hash) : null
}

export function registerFileRoutes(app: FastifyInstance) {
  app.get('/admin-api/apps/:appId/files', async (req) => {
    const { appId } = req.params as { appId: string }
    await requireAppRole(req, appId, 'viewer')
    const files = await listDraft(appId)
    const users = await col.adminUsers.find({ _id: { $in: [...new Set(files.map(f => f.updatedBy))] } }, { projection: { name: 1 } }).toArray()
    const names = new Map(users.map(u => [u._id, u.name]))
    return ok({
      files: files.map(f => ({ path: f.path, size: f.size, rev: f.rev, updatedAt: f.updatedAt, updatedBy: names.get(f.updatedBy) ?? f.updatedBy })),
    })
  })

  app.get('/admin-api/apps/:appId/files/content', async (req) => {
    const { appId } = req.params as { appId: string }
    await requireAppRole(req, appId, 'viewer')
    const { path, ref } = req.query as { path?: string, ref?: string }
    if (!path)
      throw err.invalid('缺少 path')
    if (ref && ref !== 'draft') {
      const data = await fileAt(appId, ref, path)
      if (!data)
        throw err.notFound('文件不存在')
      return ok({ path, rev: 0, ...encode(path, data) })
    }
    const f = await col.draftFiles.findOne({ appId, path })
    const data = f ? await blobs.get(f.hash) : null
    if (!f || !data)
      throw err.notFound('文件不存在')
    return ok({ path, rev: f.rev, ...encode(path, data) })
  })

  app.put('/admin-api/apps/:appId/files/content', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'developer')
    const body = parseBody(z.object({
      path: z.string(),
      content: z.string(),
      encoding: z.enum(['utf8', 'base64']).default('utf8'),
      baseRev: z.number().int().nonnegative().optional(),
    }), req.body)
    const data = body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8')
    const doc = await writeDraft(appId, body.path, data, { userId: user._id, baseRev: body.baseRev })
    return ok({ path: doc.path, rev: doc.rev })
  })

  app.delete('/admin-api/apps/:appId/files', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'developer')
    const { path } = req.query as { path?: string }
    if (!path)
      throw err.invalid('缺少 path')
    await deleteDraft(appId, path, { userId: user._id })
    return ok({})
  })

  app.post('/admin-api/apps/:appId/files/move', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'developer')
    const body = parseBody(z.object({ from: z.string(), to: z.string() }), req.body)
    await moveDraft(appId, body.from, body.to, { userId: user._id })
    return ok({})
  })

  /** 上传图片等素材到 public/ 或 src/assets/ */
  app.post('/admin-api/apps/:appId/files/upload', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'developer')
    const saved: string[] = []
    let dir = 'public'
    for await (const part of req.parts({ limits: { fileSize: 2 * 1024 * 1024, files: 10 } })) {
      if (part.type === 'field' && part.fieldname === 'dir') {
        dir = String(part.value).replace(/^\/+|\/+$/g, '') || 'public'
        continue
      }
      if (part.type === 'file') {
        const data = await part.toBuffer()
        if (part.file.truncated)
          throw err.invalid('单个素材不能超过 2MB')
        const name = part.filename.replace(/[^\w.\-一-龥]/g, '_')
        const path = `${dir}/${name}`
        await writeDraft(appId, path, data, { userId: user._id })
        saved.push(path)
      }
    }
    return ok({ paths: saved })
  })

  // ---------- 版本快照 ----------
  app.get('/admin-api/apps/:appId/snapshots', async (req) => {
    const { appId } = req.params as { appId: string }
    await requireAppRole(req, appId, 'viewer')
    const list = await col.snapshots.find({ appId, kind: { $ne: 'pre' } }, { projection: { files: 0 } }).sort({ createdAt: -1 }).limit(100).toArray()
    const users = await col.adminUsers.find({ _id: { $in: [...new Set(list.map(s => s.createdBy))] } }, { projection: { name: 1 } }).toArray()
    const names = new Map(users.map(u => [u._id, u.name]))
    return ok(list.map(s => ({ id: s._id, kind: s.kind, message: s.message, turnId: s.turnId, createdAt: s.createdAt, createdBy: names.get(s.createdBy) ?? s.createdBy })))
  })

  app.post('/admin-api/apps/:appId/snapshots', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'developer')
    const { message } = parseBody(z.object({ message: z.string().max(100).default('手动保存') }), req.body)
    const s = await createSnapshot(appId, { kind: 'manual', message, userId: user._id })
    return ok({ id: s._id })
  })

  app.post('/admin-api/apps/:appId/snapshots/:id/restore', async (req) => {
    const { appId, id } = req.params as { appId: string, id: string }
    const { user } = await requireAppRole(req, appId, 'developer')
    const snap = await getSnapshot(appId, id)
    const changes = await restoreSnapshot(appId, snap, { userId: user._id })
    const s = await createSnapshot(appId, { kind: 'rollback', message: `回滚到 ${snap.message}（${snap.createdAt.toLocaleString('zh-CN')}）`, userId: user._id })
    audit(user._id, 'draft.restore', appId, { snapshotId: id })
    return ok({ id: s._id, changes })
  })

  app.get('/admin-api/apps/:appId/diff', async (req) => {
    const { appId } = req.params as { appId: string }
    await requireAppRole(req, appId, 'viewer')
    const { from, to, path } = req.query as { from?: string, to?: string, path?: string }
    if (!from || !path)
      throw err.invalid('缺少参数')
    const [before, after] = await Promise.all([fileAt(appId, from, path), fileAt(appId, to || 'draft', path)])
    return ok({ path, before: before?.toString('utf8') ?? '', after: after?.toString('utf8') ?? '' })
  })
}
