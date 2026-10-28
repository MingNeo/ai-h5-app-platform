import { createHash } from 'node:crypto'
import { assertSafeDocument, COLLECTION_NAME_RE } from '@app-platform/shared'
import { MAX_FILE_BYTES, MAX_FILES, validatePath } from './drafts'
import { TEXT_EXT, UPLOAD_MIME } from '../lib/mime'

/** 应用包格式：ZIP 内 app.json + files/ + data/ + blobs/ */
export const PACKAGE_FORMAT = 'app-platform.app-package'
export const PACKAGE_VERSION = 2
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
export const MAX_UNCOMPRESSED_BYTES = 300 * 1024 * 1024
export const MAX_DATA_DOCS = 50_000
export const MAX_MANIFEST_BYTES = 5 * 1024 * 1024
export const MAX_GRANTS = 200
export const MAX_HISTORY_SESSIONS = 5_000
export const MAX_HISTORY_TURNS = 50_000
export const MAX_HISTORY_EVENTS = 500_000
const HISTORY_FILES = {
  sessions: 'history/sessions.ndjson',
  turns: 'history/turns.ndjson',
  events: 'history/events.ndjson',
} as const
const SHA256_RE = /^[a-f0-9]{64}$/
const KV_KEY_RE = /^[\w.:-]{1,64}$/
const SYSTEM_KEYS = new Set(['_id', '_owner', '_ownerProfile', '_createdAt', '_updatedAt'])

export interface PackageFileEntry {
  path: string
  size: number
  sha256: string
}

export interface PackageGrantEntry {
  type: 'capability' | 'biz'
  key: string
}

export interface PackageCollectionEntry {
  count: number
  file: string
}

export interface PackageDataEnv {
  collections: Record<string, PackageCollectionEntry>
  kvApp?: string
  kvUser?: string
  files?: string
  blobs: string[]
}

export interface PackageHistory {
  sessions: { count: number, file: string }
  turns: { count: number, file: string }
  events: { count: number, file: string }
}

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT
  version: typeof PACKAGE_VERSION
  exportedAt: string
  source: {
    baseDomain: string
    appId: string
    urls: { prod: string, beta: string, dev: string } | null
  }
  app: {
    name: string
    description: string
    icon: string
    schedule: { startAt: string | null, endAt: string | null } | null
  }
  files: PackageFileEntry[]
  grants: PackageGrantEntry[]
  data?: { dev?: PackageDataEnv, prod?: PackageDataEnv }
  history?: PackageHistory
}

export interface PackageLimits {
  maxDocBytes: number
  maxUploadBytes: number
  maxKvBytes: number
}

export function packageFilename(appId: string) {
  return `${appId}.app.zip`
}

export function sha256Hex(data: Buffer) {
  return createHash('sha256').update(data).digest('hex')
}

export function isTextPath(path: string) {
  return TEXT_EXT.test(path)
}

export type PackageEntry =
  | { kind: 'manifest' }
  | { kind: 'file', path: string }
  | { kind: 'data', path: string }
  | { kind: 'blob', hash: string }

/**
 * 校验并映射 ZIP 条目名。只接受：
 * app.json、files/<草稿路径>、data/<dev|prod>/<集合>.ndjson、data/<dev|prod>/_kv_app.ndjson、
 * _kv_user.ndjson、_files.json、blobs/<sha256>。
 * ZIP 里的路径统一用 /；拒绝绝对路径、..、反斜杠和空段。
 */
export function validatePackageEntry(name: string): PackageEntry {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0'))
    throw new Error(`应用包含有非法条目名：${String(name).slice(0, 100)}`)
  if (name.startsWith('/') || name.split('/').some(part => part === '' || part === '.' || part === '..'))
    throw new Error(`应用包含有非法条目名：${name.slice(0, 100)}`)
  if (name === 'app.json')
    return { kind: 'manifest' }
  if (name.startsWith('files/')) {
    const path = name.slice('files/'.length)
    validateDraftPath(path)
    return { kind: 'file', path }
  }
  if (name.startsWith('data/')) {
    const rest = name.slice('data/'.length)
    const m = /^(dev|prod)\/((?:[a-z][a-zA-Z0-9_]{0,47}\.ndjson)|_kv_app\.ndjson|_kv_user\.ndjson|_files\.json)$/.exec(rest)
    if (!m)
      throw new Error(`应用包含有非法数据文件：${name.slice(0, 100)}`)
    return { kind: 'data', path: name }
  }
  if (name.startsWith('history/')) {
    const rest = name.slice('history/'.length)
    if (rest === 'sessions.ndjson' || rest === 'turns.ndjson' || rest === 'events.ndjson')
      return { kind: 'data', path: name }
    throw new Error(`应用包含有非法会话历史文件：${name.slice(0, 100)}`)
  }
  if (name.startsWith('blobs/')) {
    const hash = name.slice('blobs/'.length)
    if (!SHA256_RE.test(hash))
      throw new Error(`应用包含有非法文件哈希：${name.slice(0, 100)}`)
    return { kind: 'blob', hash }
  }
  throw new Error(`应用包含有未知条目：${name.slice(0, 100)}`)
}

function validateDraftPath(path: string) {
  try {
    validatePath(path)
  }
  catch (e) {
    throw new Error(`应用包含有非法文件路径：${path.slice(0, 100)}（${(e as Error).message}）`)
  }
}

function rejectUnsafeKeys(value: unknown, path = '') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => rejectUnsafeKeys(v, `${path}[${i}]`))
    return
  }
  if (!value || typeof value !== 'object')
    return
  for (const [k, v] of Object.entries(value)) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor')
      throw new Error(`应用包含有非法字段名：${path ? `${path}.` : ''}${k}`)
    rejectUnsafeKeys(v, path ? `${path}.${k}` : k)
  }
}

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${what} 需要是对象`)
  return value as Record<string, unknown>
}

function stringField(value: unknown, what: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required)
      throw new Error(`缺少 ${what}`)
    return ''
  }
  if (typeof value !== 'string' || value.length > max)
    throw new Error(`${what} 需要是长度不超过 ${max} 的字符串`)
  if (required && !value)
    throw new Error(`缺少 ${what}`)
  return value
}

function isoOrNull(value: unknown, what: string): string | null {
  if (value === undefined || value === null || value === '')
    return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new Error(`${what} 需要是 ISO 时间或 null`)
  return value
}

function validateCollectionName(name: string) {
  if (!COLLECTION_NAME_RE.test(name) || name.startsWith('_'))
    throw new Error(`集合名 ${name} 不合法`)
}

function dataFilename(env: 'dev' | 'prod', name: string) {
  return `data/${env}/${name}.ndjson`
}

/** 解析并校验 app.json；任何不确定的内容都拒绝，不返回半成品 */
export function parsePackageManifest(text: string, limits: PackageLimits): PackageManifest {
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES)
    throw new Error('app.json 不能超过 5MB')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    throw new Error('app.json 不是合法的 JSON')
  }
  rejectUnsafeKeys(raw)
  const doc = plainObject(raw, 'app.json')
  if (doc.format !== PACKAGE_FORMAT)
    throw new Error('不是本平台的应用包')
  if (doc.version !== PACKAGE_VERSION)
    throw new Error(`不支持的应用包版本 ${String(doc.version)}，当前只支持 ${PACKAGE_VERSION}`)
  const exportedAt = stringField(doc.exportedAt, 'exportedAt', 64, true)
  if (Number.isNaN(Date.parse(exportedAt)))
    throw new Error('exportedAt 不是合法时间')

  const source = plainObject(doc.source, 'source')
  const sourceAppId = stringField(source.appId, 'source.appId', 64, true)
  const baseDomain = stringField(source.baseDomain, 'source.baseDomain', 200)
  let urls: PackageManifest['source']['urls'] = null
  if (source.urls !== undefined && source.urls !== null) {
    const u = plainObject(source.urls, 'source.urls')
    urls = { prod: stringField(u.prod, 'source.urls.prod', 500), beta: stringField(u.beta, 'source.urls.beta', 500), dev: stringField(u.dev, 'source.urls.dev', 500) }
  }

  const appRaw = plainObject(doc.app, 'app')
  const name = stringField(appRaw.name, 'app.name', 40, true)
  if (!name.trim())
    throw new Error('app.name 不能为空')
  const app = {
    name,
    description: stringField(appRaw.description, 'app.description', 200),
    icon: stringField(appRaw.icon, 'app.icon', 500),
    schedule: null as PackageManifest['app']['schedule'],
  }
  if (appRaw.schedule !== undefined && appRaw.schedule !== null) {
    const s = plainObject(appRaw.schedule, 'app.schedule')
    app.schedule = { startAt: isoOrNull(s.startAt, 'app.schedule.startAt'), endAt: isoOrNull(s.endAt, 'app.schedule.endAt') }
  }

  if (!Array.isArray(doc.files))
    throw new Error('app.json 缺少 files 列表')
  if (doc.files.length > MAX_FILES)
    throw new Error(`文件数量超过上限 ${MAX_FILES}`)
  const seen = new Set<string>()
  const files: PackageFileEntry[] = doc.files.map((item) => {
    const f = plainObject(item, 'files 项')
    const path = stringField(f.path, 'files.path', 200, true)
    validateDraftPath(path)
    if (seen.has(path))
      throw new Error(`文件路径重复：${path}`)
    seen.add(path)
    const size = Number(f.size)
    if (!Number.isInteger(size) || size < 0)
      throw new Error(`文件 ${path} 的 size 不合法`)
    if (size > MAX_FILE_BYTES)
      throw new Error(`文件 ${path} 超过 ${MAX_FILE_BYTES / 1024 / 1024}MB`)
    const hash = stringField(f.sha256, 'files.sha256', 64, true)
    if (!SHA256_RE.test(hash))
      throw new Error(`文件 ${path} 的 sha256 不合法`)
    return { path, size, sha256: hash }
  })

  const grants: PackageGrantEntry[] = []
  if (doc.grants !== undefined) {
    if (!Array.isArray(doc.grants))
      throw new Error('grants 需要是数组')
    if (doc.grants.length > MAX_GRANTS)
      throw new Error(`授权数量超过上限 ${MAX_GRANTS}`)
    const keys = new Set<string>()
    for (const item of doc.grants) {
      const g = plainObject(item, 'grants 项')
      if (g.type !== 'capability' && g.type !== 'biz')
        throw new Error('授权类型只能是 capability 或 biz')
      const key = stringField(g.key, 'grants.key', 200, true)
      const id = `${g.type}:${key}`
      if (keys.has(id))
        continue
      keys.add(id)
      grants.push({ type: g.type, key })
    }
  }

  let data: PackageManifest['data']
  if (doc.data !== undefined) {
    const dataRaw = plainObject(doc.data, 'data')
    for (const key of Object.keys(dataRaw)) {
      if (key !== 'dev' && key !== 'prod')
        throw new Error(`data 只支持 dev / prod，收到 ${key}`)
    }
    data = {}
    for (const env of ['dev', 'prod'] as const) {
      const envRaw = dataRaw[env]
      if (envRaw === undefined)
        continue
      const e = plainObject(envRaw, `data.${env}`)
      const collectionsRaw = e.collections === undefined ? {} : plainObject(e.collections, `data.${env}.collections`)
      const collections: Record<string, PackageCollectionEntry> = {}
      for (const [colName, colRaw] of Object.entries(collectionsRaw)) {
        validateCollectionName(colName)
        const c = plainObject(colRaw, `data.${env}.collections.${colName}`)
        const count = Number(c.count)
        if (!Number.isInteger(count) || count < 0)
          throw new Error(`data.${env}.collections.${colName}.count 不合法`)
        if (count > MAX_DATA_DOCS)
          throw new Error(`集合 ${colName} 超过 ${MAX_DATA_DOCS} 条，无法导入`)
        const file = stringField(c.file, `data.${env}.collections.${colName}.file`, 200, true)
        if (file !== dataFilename(env, colName))
          throw new Error(`集合 ${colName} 的数据文件名应为 ${dataFilename(env, colName)}`)
        collections[colName] = { count, file }
      }
      const kvApp = e.kvApp === undefined ? undefined : stringField(e.kvApp, `data.${env}.kvApp`, 200)
      if (kvApp !== undefined && kvApp !== `data/${env}/_kv_app.ndjson`)
        throw new Error(`data.${env}.kvApp 路径不合法`)
      const kvUser = e.kvUser === undefined ? undefined : stringField(e.kvUser, `data.${env}.kvUser`, 200)
      if (kvUser !== undefined && kvUser !== `data/${env}/_kv_user.ndjson`)
        throw new Error(`data.${env}.kvUser 路径不合法`)
      const filesPath = e.files === undefined ? undefined : stringField(e.files, `data.${env}.files`, 200)
      if (filesPath !== undefined && filesPath !== `data/${env}/_files.json`)
        throw new Error(`data.${env}.files 路径不合法`)
      const blobsRaw = e.blobs === undefined ? [] : e.blobs
      if (!Array.isArray(blobsRaw))
        throw new Error(`data.${env}.blobs 需要是数组`)
      const blobSet = new Set<string>()
      for (const b of blobsRaw) {
        if (typeof b !== 'string' || !SHA256_RE.test(b))
          throw new Error(`data.${env}.blobs 含有非法哈希`)
        blobSet.add(b)
      }
      data[env] = { collections, kvApp, kvUser, files: filesPath, blobs: [...blobSet] }
    }
    // 空的 data 对象没有意义，直接去掉
    if (!data.dev && !data.prod)
      data = undefined
  }

  let history: PackageHistory | undefined
  if (doc.history !== undefined && doc.history !== null) {
    const h = plainObject(doc.history, 'history')
    const read = (key: keyof typeof HISTORY_FILES, max: number) => {
      const item = plainObject(h[key], `history.${key}`)
      const count = Number(item.count)
      if (!Number.isInteger(count) || count < 0 || count > max)
        throw new Error(`history.${key}.count 不合法`)
      if (item.file !== HISTORY_FILES[key])
        throw new Error(`history.${key}.file 应为 ${HISTORY_FILES[key]}`)
      return { count, file: HISTORY_FILES[key] }
    }
    history = {
      sessions: read('sessions', MAX_HISTORY_SESSIONS),
      turns: read('turns', MAX_HISTORY_TURNS),
      events: read('events', MAX_HISTORY_EVENTS),
    }
  }

  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    exportedAt,
    source: { baseDomain, appId: sourceAppId, urls },
    app,
    files,
    grants,
    ...(data ? { data } : {}),
    ...(history ? { history } : {}),
  }
}

/** 校验一条应用数据文档（NDJSON 的每一行） */
export function validateDataDoc(value: unknown, limits: PackageLimits) {
  const doc = plainObject(value, '数据文档')
  assertSafeDocument(doc)
  for (const key of Object.keys(doc)) {
    if (key.startsWith('_') && !SYSTEM_KEYS.has(key))
      throw new Error(`数据文档包含非法系统字段 ${key}`)
  }
  if (doc._id !== undefined) {
    if (typeof doc._id !== 'string' || !doc._id || doc._id.length > 64 || /[$.]/.test(doc._id))
      throw new Error('数据文档的 _id 需要是不超过 64 位的字符串')
  }
  if (Buffer.byteLength(JSON.stringify(doc)) > limits.maxDocBytes)
    throw new Error(`单条数据文档不能超过 ${limits.maxDocBytes / 1024}KB`)
  return doc
}

/** 校验 _files 里的一条上传文件元数据 */
export function validateFileMeta(value: unknown, limits: PackageLimits) {
  const meta = plainObject(value, '文件元数据')
  const id = stringField(meta._id, '文件 _id', 64, true)
  const owner = stringField(meta.owner, '文件 owner', 200)
  const name = stringField(meta.name, '文件名', 200)
  const mime = stringField(meta.mime, '文件 mime', 100, true)
  if (!UPLOAD_MIME.test(mime))
    throw new Error(`文件 ${id} 的 mime 不支持：${mime}`)
  const size = Number(meta.size)
  if (!Number.isInteger(size) || size < 0 || size > limits.maxUploadBytes)
    throw new Error(`文件 ${id} 的大小不合法`)
  const hash = stringField(meta.hash, '文件 hash', 64, true)
  if (!SHA256_RE.test(hash))
    throw new Error(`文件 ${id} 的 hash 不合法`)
  if (typeof meta.public !== 'boolean')
    throw new Error(`文件 ${id} 的 public 需要是布尔值`)
  const createdAt = Number(meta.createdAt)
  if (!Number.isFinite(createdAt))
    throw new Error(`文件 ${id} 的 createdAt 不合法`)
  return { _id: id, owner, name, mime, size, hash, public: meta.public, createdAt }
}

/** 校验 _kv_app / _kv_user 的一条文档 */export function validateKvDoc(value: unknown, limits: PackageLimits, user: boolean) {
  const doc = plainObject(value, 'KV 文档')
  const id = stringField(doc._id, 'KV _id', 200, true)
  if (user) {
    const uid = stringField(doc.uid, 'KV uid', 200, true)
    const key = stringField(doc.key, 'KV key', 64, true)
    if (!KV_KEY_RE.test(key))
      throw new Error(`KV key ${key} 不合法`)
    if (id !== `${uid}:${key}`)
      throw new Error(`KV 文档 _id 与 uid/key 不一致：${id}`)
    if (Buffer.byteLength(JSON.stringify(doc.value ?? null)) > limits.maxKvBytes)
      throw new Error(`KV ${id} 的值不能超过 ${limits.maxKvBytes / 1024}KB`)
    return { _id: id, uid, key, value: doc.value ?? null, ...(doc.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}) }
  }
  if (!KV_KEY_RE.test(id))
    throw new Error(`KV key ${id} 不合法`)
  if (Buffer.byteLength(JSON.stringify(doc.value ?? null)) > limits.maxKvBytes)
    throw new Error(`KV ${id} 的值不能超过 ${limits.maxKvBytes / 1024}KB`)
  return { _id: id, value: doc.value ?? null, ...(doc.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}) }
}

function dateField(value: unknown, what: string, fallback?: Date): Date {
  if (value === undefined || value === null || value === '') {
    if (fallback)
      return fallback
    throw new Error(`缺少 ${what}`)
  }
  const d = value instanceof Date ? value : new Date(value as string | number)
  if (Number.isNaN(d.getTime()))
    throw new Error(`${what} 不是合法时间`)
  return d
}

function intField(value: unknown, what: string, fallback = 0) {
  if (value === undefined || value === null)
    return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${what} 需要是非负整数`)
  return n
}

function usageField(value: unknown) {
  const usage = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    inputTokens: Math.max(0, Number(usage.inputTokens) || 0),
    outputTokens: Math.max(0, Number(usage.outputTokens) || 0),
  }
}

/** 校验会话历史里的一条会话（appId 由导入流程重写） */
export function validateSessionDoc(value: unknown) {
  const doc = plainObject(value, '会话')
  if (Buffer.byteLength(JSON.stringify(doc)) > 64 * 1024)
    throw new Error('单条会话记录不能超过 64KB')
  const createdAt = dateField(doc.createdAt, '会话 createdAt')
  return {
    _id: stringField(doc._id, '会话 _id', 64, true),
    title: stringField(doc.title, '会话标题', 100) || '会话',
    createdBy: stringField(doc.createdBy, '会话 createdBy', 200),
    createdAt,
    updatedAt: dateField(doc.updatedAt, '会话 updatedAt', createdAt),
    eventSeq: intField(doc.eventSeq, '会话 eventSeq'),
    usage: usageField(doc.usage),
    ...(typeof doc.summary === 'string' ? { summary: doc.summary.slice(0, 200_000) } : {}),
    ...(doc.summaryUpToTurn !== undefined ? { summaryUpToTurn: intField(doc.summaryUpToTurn, 'summaryUpToTurn') } : {}),
  }
}

/** 校验会话历史里的一条轮次；快照指针不随包迁移，导入后不能撤销历史改动 */
export function validateTurnDoc(value: unknown) {
  const doc = plainObject(value, '轮次')
  if (Buffer.byteLength(JSON.stringify(doc)) > 8 * 1024 * 1024)
    throw new Error('单条轮次记录不能超过 8MB')
  const status = ['queued', 'running', 'completed', 'stopped', 'failed'].includes(String(doc.status))
    ? String(doc.status) as 'queued' | 'running' | 'completed' | 'stopped' | 'failed'
    : 'stopped'
  const createdAt = dateField(doc.createdAt, '轮次 createdAt')
  return {
    _id: stringField(doc._id, '轮次 _id', 64, true),
    sessionId: stringField(doc.sessionId, '轮次 sessionId', 64, true),
    index: intField(doc.index, '轮次 index'),
    // 源实例里排队/运行中的轮次在目标实例不会继续执行，统一记为已停止
    status: status === 'queued' || status === 'running' ? 'stopped' : status,
    message: stringField(doc.message, '轮次 message', 20_000, true),
    attachments: Array.isArray(doc.attachments) ? doc.attachments.slice(0, 20) : [],
    planMode: Boolean(doc.planMode),
    model: stringField(doc.model, '轮次 model', 100),
    createdBy: stringField(doc.createdBy, '轮次 createdBy', 200),
    createdAt,
    ...(doc.startedAt ? { startedAt: dateField(doc.startedAt, '轮次 startedAt') } : {}),
    ...(doc.finishedAt ? { finishedAt: dateField(doc.finishedAt, '轮次 finishedAt') } : {}),
    usage: usageField(doc.usage),
    changes: Array.isArray(doc.changes) ? doc.changes.slice(0, 500) : [],
    ...(typeof doc.error === 'string' ? { error: doc.error.slice(0, 20_000) } : {}),
    messages: Array.isArray(doc.messages) ? doc.messages.slice(0, 500) : [],
  }
}

/** 校验会话历史里的一条 SSE 事件；保留事件体，ui 靠它还原对话 */
export function validateEventDoc(value: unknown) {
  const doc = plainObject(value, '会话事件')
  if (Buffer.byteLength(JSON.stringify(doc)) > 256 * 1024)
    throw new Error('单条会话事件不能超过 256KB')
  // 事件 _id 是源库 ObjectId，导入时重新生成，避免同实例导入撞主键
  const { _id: _ignored, ...rest } = doc
  return {
    ...rest,
    sessionId: stringField(doc.sessionId, '事件 sessionId', 64, true),
    turnId: stringField(doc.turnId, '事件 turnId', 64, true),
    seq: intField(doc.seq, '事件 seq'),
    ts: Number(doc.ts) || Date.now(),
  }
}
