import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { FORBIDDEN_FILE_RE, LOCKED_FILES, TEMPLATE_FILES_DIR } from '@app-platform/app-template'
import type { FileChange } from '@app-platform/shared'
import { diffLines } from 'diff'
import { blobs } from '../lib/blob'
import { AppError, err } from '../lib/errors'
import { newId } from '../lib/tokens'
import { col, type DraftFileDoc, type SnapshotDoc, type SnapshotFile } from '../lib/mongo'
import { store } from '../lib/store'
import { TEXT_EXT } from '../lib/mime'

export interface DraftChange {
  path: string
  deleted?: boolean
}

/** 草稿文件变化事件（进程内），预览服务据此同步工作区 */
export const draftEvents = new EventEmitter().setMaxListeners(0)

const MAX_FILES = 500
const MAX_FILE_BYTES = 2 * 1024 * 1024
const PATH_RE = /^(?![./])(?!.*\/\.\.?\/)(?!.*\/\/)[\w\-./@ \u4E00-\u9FA5]{1,200}$/

export function validatePath(path: string, opts: { allowLocked?: boolean } = {}) {
  if (!PATH_RE.test(path) || path.includes('..') || path.endsWith('/'))
    throw err.invalid(`非法文件路径：${path}`)
  if (FORBIDDEN_FILE_RE.test(path))
    throw err.invalid(`${path} 由平台统一管理，不能在应用中创建`)
  if (!opts.allowLocked && LOCKED_FILES.includes(path))
    throw err.invalid(`${path} 是平台锁定文件，不能修改`)
  if (!(path === 'index.html' || path === 'manifest.json' || path.startsWith('src/') || path.startsWith('public/')))
    throw err.invalid('文件只能放在 src/、public/ 目录下，或者是根目录的 index.html、manifest.json')
}

function notify(appId: string, changes: DraftChange[]) {
  if (!changes.length)
    return
  draftEvents.emit('change', { appId, changes })
  void store.publish(`draft:${appId}`, JSON.stringify(changes))
}

export async function listDraft(appId: string) {
  return col.draftFiles.find({ appId }, { projection: { _id: 0 } }).sort({ path: 1 }).toArray()
}

export async function getDraftFile(appId: string, path: string) {
  return col.draftFiles.findOne({ appId, path })
}

export async function readDraft(appId: string, path: string): Promise<Buffer | null> {
  const f = await getDraftFile(appId, path)
  if (!f)
    return null
  return blobs.get(f.hash)
}

export async function readDraftText(appId: string, path: string): Promise<string | null> {
  const buf = await readDraft(appId, path)
  return buf ? buf.toString('utf8') : null
}

export async function writeDraft(
  appId: string,
  path: string,
  content: Buffer | string,
  opts: { userId: string, baseRev?: number, silent?: boolean },
): Promise<DraftFileDoc> {
  validatePath(path)
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  if (data.length > MAX_FILE_BYTES)
    throw err.invalid(`文件过大（上限 ${MAX_FILE_BYTES / 1024 / 1024}MB）`)
  const existing = await col.draftFiles.findOne({ appId, path })
  if (!existing && (await col.draftFiles.countDocuments({ appId })) >= MAX_FILES)
    throw err.invalid(`文件数量超过上限 ${MAX_FILES}`)
  if (opts.baseRev !== undefined && (existing?.rev ?? 0) !== opts.baseRev)
    throw new AppError('CONFLICT', `${path} 已被其他人或 AI 修改，请刷新后再保存`, 409, { currentRev: existing?.rev ?? 0 })
  const { hash, size } = await blobs.put(data)
  if (existing?.hash === hash)
    return existing
  const now = new Date()
  const doc = await col.draftFiles.findOneAndUpdate(
    { appId, path, ...(existing ? { rev: existing.rev } : {}) },
    {
      $set: { hash, size, updatedAt: now, updatedBy: opts.userId },
      $inc: { rev: 1 },
      $setOnInsert: { _id: `${appId}:${path}`, appId, path },
    },
    { upsert: !existing, returnDocument: 'after' },
  ).catch((e) => {
    if (e?.code === 11000)
      return null
    throw e
  })
  if (!doc)
    throw new AppError('CONFLICT', `${path} 刚被修改，请重试`, 409)
  if (!opts.silent)
    notify(appId, [{ path }])
  return doc
}

export async function deleteDraft(appId: string, path: string, opts: { userId: string, silent?: boolean }) {
  validatePath(path)
  const res = await col.draftFiles.deleteOne({ appId, path })
  if (!res.deletedCount)
    throw err.notFound(`文件不存在：${path}`)
  if (!opts.silent)
    notify(appId, [{ path, deleted: true }])
}

export async function moveDraft(appId: string, from: string, to: string, opts: { userId: string }) {
  validatePath(from)
  validatePath(to)
  const src = await col.draftFiles.findOne({ appId, path: from })
  if (!src)
    throw err.notFound(`文件不存在：${from}`)
  if (await col.draftFiles.findOne({ appId, path: to }))
    throw err.duplicate(`目标文件已存在：${to}`)
  await col.draftFiles.insertOne({ ...src, _id: `${appId}:${to}`, path: to, rev: 1, updatedAt: new Date(), updatedBy: opts.userId })
  await col.draftFiles.deleteOne({ appId, path: from })
  notify(appId, [{ path: from, deleted: true }, { path: to }])
}

function readTemplateFiles(): Array<{ path: string, data: Buffer }> {
  const out: Array<{ path: string, data: Buffer }> = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory())
        walk(p)
      else {
        const rel = relative(TEMPLATE_FILES_DIR, p).split('\\').join('/')
        if (!LOCKED_FILES.includes(rel))
          out.push({ path: rel, data: readFileSync(p) })
      }
    }
  }
  walk(TEMPLATE_FILES_DIR)
  return out
}

/** 用模板初始化草稿，并记录初始快照 */
export async function initDraft(appId: string, appName: string, userId: string) {
  for (const f of readTemplateFiles()) {
    let data = f.data
    if (f.path === 'manifest.json') {
      const m = JSON.parse(data.toString())
      m.name = appName
      data = Buffer.from(`${JSON.stringify(m, null, 2)}\n`)
    }
    if (f.path === 'index.html')
      data = Buffer.from(data.toString().replace('<title>新应用</title>', `<title>${escapeHtml(appName)}</title>`))
    if (f.path === 'src/pages/home.js')
      data = Buffer.from(data.toString().replace('新应用', escapeHtml(appName)))
    await writeDraft(appId, f.path, data, { userId, silent: true })
  }
  return createSnapshot(appId, { kind: 'init', message: '从模板创建', userId })
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!)
}

export async function currentFiles(appId: string): Promise<SnapshotFile[]> {
  const files = await col.draftFiles.find({ appId }, { projection: { path: 1, hash: 1, size: 1 } }).sort({ path: 1 }).toArray()
  return files.map(f => ({ path: f.path, hash: f.hash, size: f.size }))
}

export async function createSnapshot(appId: string, opts: { kind: SnapshotDoc['kind'], message: string, userId: string, turnId?: string, files?: SnapshotFile[] }) {
  const doc: SnapshotDoc = {
    _id: newId(),
    appId,
    files: opts.files ?? await currentFiles(appId),
    kind: opts.kind,
    message: opts.message,
    turnId: opts.turnId,
    createdBy: opts.userId,
    createdAt: new Date(),
  }
  await col.snapshots.insertOne(doc)
  return doc
}

export async function getSnapshot(appId: string, id: string) {
  const s = await col.snapshots.findOne({ _id: id, appId })
  if (!s)
    throw err.notFound('版本不存在')
  return s
}

/**
 * 把草稿恢复到快照。paths 不为空时只恢复这些文件（用于「撤销本轮改动」）。
 */
export async function restoreSnapshot(appId: string, snapshot: SnapshotDoc, opts: { userId: string, paths?: string[] }) {
  const target = new Map(snapshot.files.map(f => [f.path, f]))
  const current = await currentFiles(appId)
  const currentMap = new Map(current.map(f => [f.path, f]))
  const scope = opts.paths ? new Set(opts.paths) : new Set([...target.keys(), ...currentMap.keys()])
  const changes: DraftChange[] = []
  const now = new Date()
  for (const path of scope) {
    const want = target.get(path)
    const have = currentMap.get(path)
    if (want && have?.hash === want.hash)
      continue
    if (!want && have) {
      await col.draftFiles.deleteOne({ appId, path })
      changes.push({ path, deleted: true })
    }
    else if (want) {
      await col.draftFiles.updateOne(
        { appId, path },
        { $set: { hash: want.hash, size: want.size, updatedAt: now, updatedBy: opts.userId }, $inc: { rev: 1 }, $setOnInsert: { _id: `${appId}:${path}`, appId, path } },
        { upsert: true },
      )
      changes.push({ path })
    }
  }
  notify(appId, changes)
  return changes
}

/** 计算两组文件的差异（行数统计） */
export async function diffFiles(before: SnapshotFile[], after: SnapshotFile[]): Promise<FileChange[]> {
  const a = new Map(before.map(f => [f.path, f]))
  const b = new Map(after.map(f => [f.path, f]))
  const out: FileChange[] = []
  const countLines = async (hash: string) => {
    const buf = await blobs.get(hash)
    return buf ? buf.toString('utf8').split('\n').length : 0
  }
  for (const [path, f] of b) {
    const prev = a.get(path)
    if (!prev) {
      out.push({ path, status: 'added', added: TEXT_EXT.test(path) ? await countLines(f.hash) : 0, removed: 0 })
    }
    else if (prev.hash !== f.hash) {
      let added = 0
      let removed = 0
      if (TEXT_EXT.test(path)) {
        const [x, y] = await Promise.all([blobs.get(prev.hash), blobs.get(f.hash)])
        for (const part of diffLines(x?.toString('utf8') ?? '', y?.toString('utf8') ?? '')) {
          if (part.added)
            added += part.count ?? 0
          else if (part.removed)
            removed += part.count ?? 0
        }
      }
      out.push({ path, status: 'modified', added, removed })
    }
  }
  for (const [path, f] of a) {
    if (!b.has(path))
      out.push({ path, status: 'deleted', added: 0, removed: TEXT_EXT.test(path) ? await countLines(f.hash) : 0 })
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}
