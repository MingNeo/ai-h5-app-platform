import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CAPABILITIES, validateAppId } from '@app-platform/shared'
import type { AppManifest } from '@app-platform/shared'
import type { FastifyInstance } from 'fastify'
import type { Document } from 'mongodb'
import * as yauzl from 'yauzl'
import * as yazl from 'yazl'
import { config } from '../../config'
import { draftManifest, effectiveManifest, invalidateApp } from '../../core/apps'
import {
  isTextPath,
  MAX_ARCHIVE_BYTES,
  MAX_DATA_DOCS,
  MAX_GRANTS,
  MAX_HISTORY_EVENTS,
  MAX_HISTORY_SESSIONS,
  MAX_HISTORY_TURNS,
  MAX_UNCOMPRESSED_BYTES,
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  packageFilename,
  parsePackageManifest,
  type PackageDataEnv,
  type PackageHistory,
  type PackageManifest,
  sha256Hex,
  validateDataDoc,
  validateEventDoc,
  validateFileMeta,
  validateKvDoc,
  validatePackageEntry,
  validateSessionDoc,
  validateTurnDoc,
} from '../../core/app-package'
import { createSnapshot, currentFiles, writeDraft } from '../../core/drafts'
import { audit } from '../../lib/audit'
import { blobs } from '../../lib/blob'
import { err } from '../../lib/errors'
import { ok } from '../../lib/http'
import { appCollection, col, mongoClient, type AppDoc } from '../../lib/mongo'
import { store } from '../../lib/store'
import { newId } from '../../lib/tokens'
import { ensureIndexes } from '../gateway/data'
import { appUrls } from './apps'
import { requireAdmin, requirePerm } from './auth'

const LIMITS = {
  maxDocBytes: config.limits.docBytes,
  maxUploadBytes: config.limits.uploadBytes,
  maxKvBytes: config.limits.kvValueBytes,
}

const STALE_IMPORT_MS = 30 * 60_000
const IMPORT_LOCK_TTL = 30 * 60
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface FileEntry {
  path: string
  size: number
  sha256: string
}

interface ExportCollection {
  name: string
  count: number
  def: AppManifest['collections'][string]
}

interface ExportEnv {
  env: 'dev' | 'prod'
  collections: ExportCollection[]
  kvApp: Array<Record<string, unknown>>
  kvUser: Array<Record<string, unknown>>
  fileMetas: Array<Record<string, unknown>>
  blobHashes: string[]
}

interface DataFlags {
  collections: boolean
  files: boolean
  kv: boolean
}

/** 读取一个集合的所有文档；超过上限直接失败，不静默截断 */
async function readAllCapped<T extends Document>(appId: string, env: 'dev' | 'prod', name: string) {
  const list = await appCollection<T>(appId, env, name).find().sort({ _id: 1 }).limit(MAX_DATA_DOCS + 1).toArray()
  if (list.length > MAX_DATA_DOCS)
    throw err.invalid(`集合 ${name}（${env}）超过 ${MAX_DATA_DOCS} 条，无法完整导出`)
  return list
}

async function collectEnvData(appId: string, env: 'dev' | 'prod', manifest: AppManifest | null, flags: DataFlags): Promise<ExportEnv> {
  const collections: ExportCollection[] = []
  if (flags.collections) {
    for (const [name, def] of Object.entries(manifest?.collections ?? {})) {
      const count = await appCollection(appId, env, name).countDocuments({})
      if (count > MAX_DATA_DOCS)
        throw err.invalid(`集合 ${name}（${env}）超过 ${MAX_DATA_DOCS} 条，无法完整导出`)
      collections.push({ name, count, def })
    }
  }
  const kvApp = flags.kv ? await readAllCapped<Record<string, unknown>>(appId, env, '_kv_app') : []
  const kvUser = flags.kv ? await readAllCapped<Record<string, unknown>>(appId, env, '_kv_user') : []
  const fileMetas = flags.files ? await readAllCapped<Record<string, unknown>>(appId, env, '_files') : []
  const blobHashes = flags.files ? [...new Set(fileMetas.map(m => m.hash).filter((h): h is string => typeof h === 'string'))] : []
  for (const hash of blobHashes) {
    if (!await blobs.has(hash))
      throw err.invalid(`上传文件内容缺失：${hash}`)
  }
  return { env, collections, kvApp, kvUser, fileMetas, blobHashes }
}

function entryToJson(entry: FileEntry) {
  return { path: entry.path, size: entry.size, sha256: entry.sha256 }
}

function ndjsonStream(docs: () => AsyncIterable<Document>, onBytes: (n: number) => void) {
  return Readable.from((async function* () {
    for await (const doc of docs()) {
      const line = `${JSON.stringify(doc)}\n`
      onBytes(Buffer.byteLength(line))
      yield line
    }
  })())
}

function blobStream(hash: string, onBytes: (n: number) => void) {
  return Readable.from((async function* () {
    const data = await blobs.get(hash)
    if (!data)
      throw new Error(`上传文件内容缺失：${hash}`)
    onBytes(data.length)
    yield data
  })())
}

export function registerTransferRoutes(app: FastifyInstance) {
  app.get('/admin-api/apps/:appId/export', async (req, reply) => {
    const { appId } = req.params as { appId: string }
    const q = req.query as { includeData?: string, data?: string }
    // includeData=1 兼容旧链接：等同全选；data=collections,files,kv 可选部分
    const selected = new Set(String(q.data ?? '').split(',').map(s => s.trim()).filter(Boolean))
    const all = ['1', 'true'].includes(String(q.includeData ?? ''))
    const flags: DataFlags = {
      collections: all || selected.has('collections'),
      files: all || selected.has('files'),
      kv: all || selected.has('kv'),
    }
    const includeData = flags.collections || flags.files || flags.kv
    const { app: appDoc } = await requirePerm(req, appId, ...(includeData ? ['app.edit', 'data.export'] as const : ['app.edit'] as const))

    const files = await currentFiles(appId)
    const draftBytes = files.reduce((n, f) => n + f.size, 0)
    if (draftBytes > MAX_UNCOMPRESSED_BYTES)
      throw err.invalid(`草稿文件共 ${(draftBytes / 1024 / 1024).toFixed(1)}MB，超过应用包上限，无法导出`)
    const fileBuffers = new Map<string, Buffer>()
    for (const f of files) {
      const data = await blobs.get(f.hash)
      if (!data)
        throw err.invalid(`草稿文件内容缺失：${f.path}`)
      fileBuffers.set(f.path, data)
    }

    const devManifest = (await draftManifest(appId)).manifest
    const prodManifest = await effectiveManifest(appId, 'prod')
    const envs: ExportEnv[] = includeData
      ? [await collectEnvData(appId, 'dev', devManifest, flags), await collectEnvData(appId, 'prod', prodManifest, flags)]
      : []

    const grants: Array<{ type: 'capability' | 'biz', key: string }> = []
    const approved = await col.grants.find({ appId, status: 'approved' }).sort({ createdAt: 1 }).toArray()
    if (approved.length) {
      const catalog = new Set((await col.bizApis.find({}, { projection: { prefix: 1 } }).toArray()).map(b => b.prefix))
      for (const g of approved) {
        const matched = g.type === 'capability' ? CAPABILITIES.includes(g.key) : catalog.has(g.key)
        if (matched)
          grants.push({ type: g.type, key: g.key })
      }
    }

    const data = includeData
      ? Object.fromEntries(envs.map((e) => {
          const plan: PackageDataEnv = {
            collections: flags.collections
              ? Object.fromEntries(e.collections.map(c => [c.name, { count: c.count, file: `data/${e.env}/${c.name}.ndjson` }]))
              : {},
            blobs: flags.files ? e.blobHashes : [],
          }
          if (flags.kv) {
            plan.kvApp = `data/${e.env}/_kv_app.ndjson`
            plan.kvUser = `data/${e.env}/_kv_user.ndjson`
          }
          if (flags.files)
            plan.files = `data/${e.env}/_files.json`
          return [e.env, plan]
        })) as { dev?: PackageDataEnv, prod?: PackageDataEnv }
      : undefined

    const sessionIds = (await col.sessions.find({ appId }, { projection: { _id: 1 } }).toArray()).map(s => s._id)
    if (sessionIds.length > MAX_HISTORY_SESSIONS)
      throw err.invalid(`会话数量超过 ${MAX_HISTORY_SESSIONS}，无法完整导出`)
    const historyCounts = {
      sessions: sessionIds.length,
      turns: await col.turns.countDocuments({ appId }),
      events: sessionIds.length ? await col.events.countDocuments({ sessionId: { $in: sessionIds } }) : 0,
    }
    if (historyCounts.turns > MAX_HISTORY_TURNS)
      throw err.invalid(`会话轮次超过 ${MAX_HISTORY_TURNS}，无法完整导出`)
    if (historyCounts.events > MAX_HISTORY_EVENTS)
      throw err.invalid(`会话事件超过 ${MAX_HISTORY_EVENTS}，无法完整导出`)
    const history: PackageHistory = {
      sessions: { count: historyCounts.sessions, file: 'history/sessions.ndjson' },
      turns: { count: historyCounts.turns, file: 'history/turns.ndjson' },
      events: { count: historyCounts.events, file: 'history/events.ndjson' },
    }

    const fileEntries: FileEntry[] = files.map(f => ({ path: f.path, size: f.size, sha256: f.hash }))
    const packageMeta = {
      format: PACKAGE_FORMAT,
      version: PACKAGE_VERSION,
      exportedAt: new Date().toISOString(),
      source: { baseDomain: config.baseDomain, appId, urls: appUrls(appId) },
      app: {
        name: appDoc.name,
        description: appDoc.description,
        icon: appDoc.icon,
        schedule: appDoc.schedule
          ? { startAt: appDoc.schedule.startAt?.toISOString() ?? null, endAt: appDoc.schedule.endAt?.toISOString() ?? null }
          : null,
      },
      files: fileEntries.map(entryToJson),
      grants,
      ...(data ? { data } : {}),
      history,
    }

    const filename = packageFilename(appId)
    const zip = new yazl.ZipFile()
    let total = Buffer.byteLength(JSON.stringify(packageMeta))
    const count = (n: number) => {
      total += n
      if (total > MAX_UNCOMPRESSED_BYTES)
        throw new Error(`应用包解压后超过 ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024}MB，请取消勾选运行数据后重试`)
    }
    for (const f of files)
      count(f.size)

    zip.addBuffer(Buffer.from(JSON.stringify(packageMeta)), 'app.json', { compress: true })
    for (const f of files) {
      const buf = fileBuffers.get(f.path)!
      zip.addBuffer(buf, `files/${f.path}`, { compress: isTextPath(f.path) })
    }
    const addHistory = (expected: number, name: string, docs: () => AsyncIterable<Document>) => {
      if (expected)
        zip.addReadStream(ndjsonStream(docs, count), name, { compress: true })
      else
        zip.addBuffer(Buffer.alloc(0), name, { compress: true })
    }
    addHistory(history.sessions.count, history.sessions.file, () => col.sessions.find({ appId }).sort({ createdAt: 1 }))
    addHistory(history.turns.count, history.turns.file, () => col.turns.find({ appId }).sort({ createdAt: 1 }))
    addHistory(history.events.count, history.events.file, () => col.events.find({ sessionId: { $in: sessionIds } }).sort({ sessionId: 1, seq: 1 }))
    for (const e of envs) {
      if (flags.collections) {
        for (const c of e.collections) {
          const name = `data/${e.env}/${c.name}.ndjson`
          zip.addReadStream(ndjsonStream(() => appCollection(appId, e.env, c.name).find().sort({ _id: 1 }), count), name, { compress: true })
        }
      }
      if (flags.kv) {
        const kvApp = Buffer.from(e.kvApp.map(d => `${JSON.stringify(d)}\n`).join(''))
        const kvUser = Buffer.from(e.kvUser.map(d => `${JSON.stringify(d)}\n`).join(''))
        zip.addBuffer(kvApp, `data/${e.env}/_kv_app.ndjson`, { compress: true })
        zip.addBuffer(kvUser, `data/${e.env}/_kv_user.ndjson`, { compress: true })
        count(kvApp.length + kvUser.length)
      }
      if (flags.files) {
        const metas = Buffer.from(JSON.stringify(e.fileMetas))
        zip.addBuffer(metas, `data/${e.env}/_files.json`, { compress: true })
        count(metas.length)
        for (const hash of e.blobHashes)
          zip.addReadStream(blobStream(hash, count), `blobs/${hash}`, { compress: false })
      }
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
    })
    zip.outputStream.on('error', (e) => {
      req.log.error({ err: e, appId }, '[transfer] 导出流中断')
      reply.raw.destroy()
    })
    zip.outputStream.on('end', () => {
      audit(String(req.admin?._id ?? ''), 'app.export', appId, {
        includeData,
        files: fileEntries.length,
        grants: grants.length,
        bytes: total,
      })
    })
    zip.outputStream.pipe(reply.raw)
    zip.end()
  })

  // 说明：导入必须先解压到临时目录、再按 app.json 执行；apps 文档最后插入，作为唯一提交点。
  app.post('/admin-api/apps/import', async (req, reply) => {
    const user = requireAdmin(req)
    await mkdir(config.dataDir, { recursive: true })
    const tempDir = await mkdtemp(join(config.dataDir, 'app-import-'))
    try {
      const zipPath = join(tempDir, 'package.zip')
      let targetId = ''
      let saved = false
      for await (const part of req.parts({ limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1, fields: 4 } })) {
        if (part.type === 'field') {
          if (part.fieldname === 'appId')
            targetId = String(part.value).trim().toLowerCase()
          continue
        }
        if (part.fieldname !== 'file' || saved) {
          part.file.resume()
          continue
        }
        let bytes = 0
        const limiter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.length
            if (bytes > MAX_ARCHIVE_BYTES)
              cb(err.invalid(`应用包不能超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB`))
            else cb(null, chunk)
          },
        })
        await pipeline(part.file, limiter, createWriteStream(zipPath))
        if (part.file.truncated)
          throw err.invalid(`应用包不能超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB`)
        saved = true
      }
      if (!saved)
        throw err.invalid('缺少应用包文件')

      const extractedDir = join(tempDir, 'extracted')
      await mkdir(extractedDir, { recursive: true })
      let extracted: ExtractedZip
      try {
        extracted = await extractZip(zipPath, extractedDir)
      }
      catch (e) {
        throw err.invalid(`应用包无法读取：${(e as Error).message}`)
      }
      const manifestText = await readFile(join(extractedDir, 'app.json'), 'utf8').catch(() => null)
      if (!manifestText)
        throw err.invalid('应用包缺少 app.json')
      let pkg: PackageManifest
      try {
        pkg = parsePackageManifest(manifestText, LIMITS)
      }
      catch (e) {
        throw err.invalid((e as Error).message)
      }

      const appId = targetId || pkg.source.appId
      const invalid = validateAppId(appId)
      if (invalid)
        throw err.invalid(invalid)
      if (await col.apps.findOne({ _id: appId }))
        throw err.duplicate(`appId「${appId}」已被使用（含已删除的应用），请换一个`)
      if (await col.importJobs.findOne({ appId }) || await hasAppCollections(appId))
        throw err.duplicate(`appId「${appId}」存在未清理的导入残留，请换一个 appId`)

      const manifestPaths = new Set(pkg.files.map(f => f.path))
      const extraFiles = extracted.files.filter(p => !manifestPaths.has(p))
      if (extraFiles.length)
        throw err.invalid(`应用包含有未在 app.json 中声明的文件：${extraFiles.slice(0, 5).join('、')}`)

      const token = newId()
      const lockKey = `app:import:${appId}`
      if (!await store.setNX(lockKey, token, IMPORT_LOCK_TTL))
        throw err.duplicate('该 appId 正在导入，请稍后再试')
      let committed = false
      try {
        await col.importJobs.insertOne({ _id: token, appId, createdAt: new Date() })
        await col.members.insertOne({ _id: newId(), appId, userId: user._id, role: 'owner', createdAt: new Date() })

        const warnings: string[] = []
        if (!pkg.files.some(f => f.path === 'index.html'))
          warnings.push('应用包缺少 index.html，生成测试版会失败')
        let fileCount = 0
        for (const f of pkg.files) {
          const data = await readFile(join(extractedDir, 'files', f.path)).catch(() => null)
          if (!data)
            throw err.invalid(`应用包缺少文件：${f.path}`)
          if (data.length !== f.size || sha256Hex(data) !== f.sha256)
            throw err.invalid(`文件 ${f.path} 的内容与 app.json 不一致`)
          await writeDraft(appId, f.path, data, { userId: user._id, silent: true })
          fileCount++
        }
        await createSnapshot(appId, { kind: 'init', message: '从应用包导入', userId: user._id })

        const importedManifestResult = await draftManifest(appId)
        const importedManifest = importedManifestResult.manifest
        if (!importedManifest && importedManifestResult.errors.length)
          warnings.push(`manifest.json 未能通过校验：${importedManifestResult.errors.join('；')}`)

        const dataSummary = await importData(appId, pkg, extractedDir, importedManifest, warnings, user._id)
        const historySummary = await importHistory(appId, pkg, extractedDir, warnings)

        const catalog = new Set((await col.bizApis.find({}, { projection: { prefix: 1 } }).toArray()).map(b => b.prefix))
        let approvedGrants = 0
        let pendingGrants = 0
        const skippedGrants: string[] = []
        for (const g of pkg.grants.slice(0, MAX_GRANTS)) {
          const matched = g.type === 'capability' ? CAPABILITIES.includes(g.key) : catalog.has(g.key)
          if (!matched) {
            skippedGrants.push(`${g.type}:${g.key}`)
            warnings.push(`${g.type === 'capability' ? '能力' : '业务接口'} ${g.key} 在本环境未登记，已跳过`)
            continue
          }
          const approvedNow = user.isPlatformAdmin
          const status = approvedNow ? 'approved' : 'pending'
          await col.grants.insertOne({
            _id: newId(),
            appId,
            type: g.type,
            key: g.key,
            status,
            reason: approvedNow ? '从应用包导入' : '从应用包导入，待审批',
            requestedBy: user._id,
            ...(approvedNow ? { reviewedBy: user._id, reviewNote: '从应用包导入', reviewedAt: new Date() } : {}),
            createdAt: new Date(),
          })
          if (approvedNow)
            approvedGrants++
          else pendingGrants++
        }

        const now = new Date()
        const appDoc: AppDoc = {
          _id: appId,
          name: pkg.app.name,
          description: pkg.app.description,
          icon: pkg.app.icon,
          status: 'active',
          ...(pkg.app.schedule ? { schedule: { startAt: pkg.app.schedule.startAt ? new Date(pkg.app.schedule.startAt) : null, endAt: pkg.app.schedule.endAt ? new Date(pkg.app.schedule.endAt) : null } } : {}),
          createdBy: user._id,
          createdAt: now,
          updatedAt: now,
          importToken: token,
        }
        // 唯一提交点：apps 文档插入成功后，应用才对外可见
        await col.apps.insertOne(appDoc)
        committed = true

        await col.importJobs.deleteOne({ _id: token }).catch(e => req.log.warn({ err: e, appId }, '[transfer] 清理导入标记失败'))
        await col.apps.updateOne({ _id: appId }, { $unset: { importToken: '' } }).catch(() => {})
        invalidateApp(appId)
        audit(user._id, 'app.import', appId, {
          sourceAppId: pkg.source.appId,
          files: fileCount,
          grants: { approved: approvedGrants, pending: pendingGrants, skipped: skippedGrants },
          data: dataSummary,
          history: historySummary,
        })

        return ok({
          appId,
          name: pkg.app.name,
          files: fileCount,
          grants: { approved: approvedGrants, pending: pendingGrants, skipped: skippedGrants },
          data: dataSummary,
          history: historySummary,
          warnings,
        })
      }
      catch (e) {
        if (!committed) {
          await cleanupImport(appId, token).catch(cleanupError => req.log.error({ err: cleanupError, appId }, '[transfer] 导入失败清理未完成'))
        }
        if ((e as { code?: number }).code === 11000)
          throw err.duplicate(`应用包内存在重复数据，导入已回滚：${(e as Error).message}`)
        throw e
      }
      finally {
        await store.del(lockKey).catch(() => {})
      }
    }
    finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  })
}

async function importData(
  appId: string,
  pkg: PackageManifest,
  extractedDir: string,
  manifest: AppManifest | null,
  warnings: string[],
  userId: string,
) {
  if (!pkg.data)
    return null
  let collections = 0
  let docs = 0
  let files = 0
  for (const env of ['dev', 'prod'] as const) {
    const plan = pkg.data[env]
    if (!plan)
      continue
    const hasCollections = Object.keys(plan.collections).length > 0
    const manifestCollections = manifest?.collections ?? {}
    if (hasCollections && !Object.keys(manifestCollections).length)
      warnings.push(`${env === 'dev' ? '测试环境' : '正式环境'} 没有可用的数据集合定义，已跳过运行数据`)
    if (hasCollections && env === 'prod')
      warnings.push('正式环境尚无发布版本，已按草稿 manifest 导入正式数据')
    for (const [name, entry] of Object.entries(plan.collections)) {
      const def = manifestCollections[name]
      if (!def) {
        warnings.push(`集合 ${name} 未在 manifest 中声明，已跳过`)
        continue
      }
      if (entry.count > MAX_DATA_DOCS)
        throw err.invalid(`集合 ${name} 超过 ${MAX_DATA_DOCS} 条`)
      const file = join(extractedDir, entry.file)
      const inserted = await importNdjson(file, (raw) => {
        const doc = invalidAs(() => {
          validateDataDoc(raw, LIMITS)
          return raw as Record<string, unknown>
        })
        const now = Date.now()
        return {
          ...doc,
          _owner: doc._owner ?? `admin:${userId}`,
          _createdAt: doc._createdAt ?? now,
          _updatedAt: doc._updatedAt ?? now,
        }
      }, batch => appCollection<any>(appId, env, name).insertMany(batch, { ordered: true }))
      if (inserted > MAX_DATA_DOCS)
        throw err.invalid(`集合 ${name} 超过 ${MAX_DATA_DOCS} 条`)
      if (inserted !== entry.count)
        warnings.push(`集合 ${name}（${env}）条数与 app.json 不一致：声明 ${entry.count}，实际 ${inserted}（导出期间数据可能有变化）`)
      await ensureIndexes(appId, env, name, def)
      collections++
      docs += inserted
    }

    if (plan.kvApp) {
      const path = join(extractedDir, plan.kvApp)
      await importNdjson(path, raw => invalidAs(() => validateKvDoc(raw, LIMITS, false)), async (batch) => {
        await upsertKv(appId, env, '_kv_app', batch)
      })
    }
    if (plan.kvUser) {
      const path = join(extractedDir, plan.kvUser)
      await importNdjson(path, raw => invalidAs(() => validateKvDoc(raw, LIMITS, true)), async (batch) => {
        await upsertKv(appId, env, '_kv_user', batch)
      })
    }
    if (plan.files) {
      const path = join(extractedDir, plan.files)
      if (!await fileExists(path))
        throw err.invalid(`缺少数据文件：${plan.files}`)
      const rawText = await readFile(path, 'utf8')
      const raw = invalidAs(() => JSON.parse(rawText) as unknown)
      if (!Array.isArray(raw))
        throw err.invalid(`${plan.files} 需要是数组`)
      const metas = raw.map(item => invalidAs(() => validateFileMeta(item, LIMITS)))
      const metaDocs: Array<Record<string, unknown>> = []
      for (const meta of metas) {
        const blobPath = join(extractedDir, 'blobs', meta.hash)
        if (!await fileExists(blobPath))
          throw err.invalid(`上传文件内容缺失：${meta.hash}`)
        const data = await readFile(blobPath)
        if (data.length !== meta.size)
          throw err.invalid(`上传文件 ${meta._id} 的大小与元数据不一致`)
        const computed = sha256Hex(data)
        const hash = computed === meta.hash ? meta.hash : computed
        if (hash !== meta.hash)
          warnings.push(`上传文件 ${meta._id} 的 hash 与内容不符，已按内容重新计算`)
        await blobs.put(data)
        metaDocs.push({ ...meta, hash, size: data.length })
        files++
      }
      if (metaDocs.length)
        await appCollection<Record<string, unknown>>(appId, env, '_files').insertMany(metaDocs, { ordered: true })
    }
  }
  return { collections, docs, files }
}

async function upsertKv(appId: string, env: 'dev' | 'prod', name: '_kv_app' | '_kv_user', batch: Array<Record<string, unknown>>) {
  await appCollection<any>(appId, env, name).bulkWrite(
    batch.map((doc) => {
      const { _id, ...rest } = doc
      return { updateOne: { filter: { _id }, update: { $set: rest }, upsert: true } }
    }),
    { ordered: true },
  )
}

/** 导入 AI 会话历史：会话 → 轮次 → 事件。所有 id 重新分配，避免同实例重复导入时撞主键 */
async function importHistory(appId: string, pkg: PackageManifest, extractedDir: string, warnings: string[]) {
  const history = pkg.history
  if (!history)
    return null
  const sessionIds = new Map<string, string>()
  const sessions = await importNdjson(join(extractedDir, history.sessions.file), (raw) => {
    const doc = invalidAs(() => validateSessionDoc(raw))
    if (sessionIds.has(doc._id))
      throw err.invalid(`应用包内会话 _id 重复：${doc._id}`)
    const id = newId()
    sessionIds.set(doc._id, id)
    return { ...doc, _id: id, appId }
  }, batch => col.sessions.insertMany(batch as any, { ordered: true }))
  if (sessions !== history.sessions.count)
    warnings.push(`会话数量与 app.json 不一致：声明 ${history.sessions.count}，实际 ${sessions}`)

  const turnIds = new Map<string, string>()
  const turns = await importNdjson(join(extractedDir, history.turns.file), (raw) => {
    const doc = invalidAs(() => validateTurnDoc(raw))
    const sid = sessionIds.get(doc.sessionId)
    if (!sid)
      throw err.invalid(`轮次 ${doc._id} 引用了不存在的会话：${doc.sessionId}`)
    if (turnIds.has(doc._id))
      throw err.invalid(`应用包内轮次 _id 重复：${doc._id}`)
    const id = newId()
    turnIds.set(doc._id, id)
    return { ...doc, _id: id, sessionId: sid, appId }
  }, batch => col.turns.insertMany(batch as any, { ordered: true }))
  if (turns !== history.turns.count)
    warnings.push(`会话轮次数量与 app.json 不一致：声明 ${history.turns.count}，实际 ${turns}`)

  const events = await importNdjson(join(extractedDir, history.events.file), (raw) => {
    const doc = invalidAs(() => validateEventDoc(raw))
    const sid = sessionIds.get(doc.sessionId)
    if (!sid)
      throw err.invalid(`会话事件引用了不存在的会话：${doc.sessionId}`)
    const tid = turnIds.get(doc.turnId)
    if (!tid)
      throw err.invalid(`会话事件引用了不存在的轮次：${doc.turnId}`)
    return { ...doc, sessionId: sid, turnId: tid }
  }, batch => col.events.insertMany(batch as any, { ordered: true }))
  if (events !== history.events.count)
    warnings.push(`会话事件数量与 app.json 不一致：声明 ${history.events.count}，实际 ${events}`)
  return { sessions, turns, events }
}

/** 逐行读取 NDJSON，批量交给写入函数；返回读取到的文档数 */
async function importNdjson<T>(
  file: string,
  map: (raw: unknown) => Promise<T> | T,
  writeBatch: (batch: T[]) => Promise<unknown>,
  batchSize = 500,
) {
  if (!await fileExists(file))
    throw err.invalid(`缺少数据文件：${relative(process.cwd(), file)}`)
  let count = 0
  let batch: T[] = []
  for await (const line of readLines(file)) {
    if (!line.trim())
      continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    }
    catch {
      throw err.invalid(`数据文件 ${relative(process.cwd(), file)} 存在非法 JSON 行`)
    }
    batch.push(await map(raw))
    count++
    if (batch.length >= batchSize) {
      await writeBatch(batch)
      batch = []
    }
  }
  if (batch.length)
    await writeBatch(batch)
  return count
}

async function* readLines(file: string) {
  let pending = ''
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk
    let i: number
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i).replace(/\r$/, '')
      pending = pending.slice(i + 1)
      yield line
    }
  }
  if (pending.trim())
    yield pending
}

async function fileExists(path: string) {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

/** 格式校验函数抛普通 Error，这里统一转成 422 */
function invalidAs<T>(fn: () => T): T {
  try {
    return fn()
  }
  catch (e) {
    throw err.invalid((e as Error).message)
  }
}

interface ExtractedZip {
  /** files/ 下的草稿文件相对路径 */
  files: string[]
}

/** 解压到临时目录；逐条校验条目名、大小和累计解压量 */
async function extractZip(zipPath: string, dir: string): Promise<ExtractedZip> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (e, z) => e ? reject(e) : resolve(z))
  })
  const files: string[] = []
  const seen = new Set<string>()
  let total = 0
  try {
    await new Promise<void>((done, fail) => {
      zip.on('error', fail)
      zip.on('end', () => done())
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          try {
            if (entry.fileName.endsWith('/')) {
              zip.readEntry()
              return
            }
            if (seen.has(entry.fileName))
              throw new Error(`应用包含有重复条目：${entry.fileName}`)
            seen.add(entry.fileName)
            const mapped = validatePackageEntry(entry.fileName)
            const dest = resolve(dir, entry.fileName)
            if (!dest.startsWith(`${resolve(dir)}${sep}`))
              throw new Error(`应用包含有非法条目名：${entry.fileName}`)
            if (entry.uncompressedSize > MAX_UNCOMPRESSED_BYTES)
              throw new Error(`应用包解压后超过 ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024}MB`)
            const limiter = new Transform({
              transform(chunk: Buffer, _enc, cb) {
                total += chunk.length
                if (total > MAX_UNCOMPRESSED_BYTES)
                  cb(new Error(`应用包解压后超过 ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024}MB`))
                else cb(null, chunk)
              },
            })
            await mkdir(dirname(dest), { recursive: true })
            await pipeline(await openEntryStream(zip, entry), limiter, createWriteStream(dest))
            if (mapped.kind === 'file')
              files.push(mapped.path)
            zip.readEntry()
          }
          catch (e) {
            fail(e)
            zip.close()
          }
        })()
      })
      zip.readEntry()
    })
  }
  finally {
    try {
      zip.close()
    }
    catch {}
  }
  return { files }
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (e, stream) => e ? reject(e) : resolve(stream))
  })
}

/** 删除一次导入产生的所有记录；blobs 是共享内容寻址存储，不删除 */
export async function cleanupImport(appId: string, token?: string) {
  const sessionIds = (await col.sessions.find({ appId }, { projection: { _id: 1 } }).toArray()).map(s => s._id)
  await Promise.all([
    // 有 token 时只删本次导入插入的 apps 文档，避免误删同时提交的其他应用
    col.apps.deleteOne(token ? { _id: appId, importToken: token } : { _id: appId }),
    col.members.deleteMany({ appId }),
    col.draftFiles.deleteMany({ appId }),
    col.grants.deleteMany({ appId }),
    col.snapshots.deleteMany({ appId }),
    col.sessions.deleteMany({ appId }),
    col.turns.deleteMany({ appId }),
    ...(sessionIds.length ? [col.events.deleteMany({ sessionId: { $in: sessionIds } })] : []),
    col.importJobs.deleteMany({ appId }),
  ])
  const db = mongoClient().db()
  const prefix = `appdata_${appId}_`
  const names: string[] = []
  for await (const info of db.listCollections({}, { nameOnly: true }))
    names.push(info.name)
  for (const name of names) {
    if (!name.startsWith(prefix))
      continue
    await db.collection(name).drop().catch(() => {})
  }
}

async function hasAppCollections(appId: string) {
  const db = mongoClient().db()
  const prefix = `appdata_${appId}_`
  const re = new RegExp(`^${escaped(prefix)}`)
  for await (const info of db.listCollections({}, { nameOnly: true })) {
    if (re.test(info.name))
      return true
  }
  return false
}

/** 服务启动时清理崩溃残留：有匹配 importToken 的 apps 文档说明已提交，否则删除半成品 */
export async function recoverImports() {
  const jobs = await col.importJobs.find({ createdAt: { $lt: new Date(Date.now() - STALE_IMPORT_MS) } }).toArray()
  for (const job of jobs) {
    try {
      const app = await col.apps.findOne({ _id: job.appId })
      if (app?.importToken === job._id) {
        await col.apps.updateOne({ _id: job.appId }, { $unset: { importToken: '' } })
        await col.importJobs.deleteOne({ _id: job._id })
        continue
      }
      if (app) {
        // 不是本次导入创建的应用，保留应用，只清理标记
        await col.importJobs.deleteOne({ _id: job._id })
        continue
      }
      await cleanupImport(job.appId)
      console.warn(`[transfer] 已清理未完成的导入：${job.appId}`)
    }
    catch (e) {
      console.error(`[transfer] 清理导入残留失败：${job.appId}`, e)
    }
  }
}
