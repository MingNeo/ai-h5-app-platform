import type { AppManifest, AppPerm, AppRole, Attachment, BizApiSpec, CheckIssue, FileChange, TurnStatus, TurnUsage } from '@app-platform/shared'
import { type Collection, type Db, MongoClient } from 'mongodb'
import { config } from '../config'

export type { AppRole }

export interface AdminUserDoc {
  _id: string
  name: string
  avatar: string
  email: string
  feishuOpenId?: string
  isPlatformAdmin: boolean
  createdAt: Date
  lastLoginAt: Date
}

export interface AppDoc {
  _id: string
  name: string
  description: string
  icon: string
  status: 'active' | 'offline' | 'deleted'
  schedule?: { startAt?: Date | null, endAt?: Date | null }
  betaBuildId?: string
  prodBuildId?: string
  prodReleaseId?: string
  createdBy: string
  createdAt: Date
  updatedAt: Date
  deletedAt?: Date
}

export interface MemberDoc {
  _id: string
  appId: string
  userId: string
  role: AppRole
  /** 显式权限覆盖；为空时按角色包推导 */
  perms?: AppPerm[] | null
  createdAt: Date
}

export interface DraftFileDoc {
  _id: string
  appId: string
  path: string
  hash: string
  size: number
  rev: number
  updatedAt: Date
  updatedBy: string
}

export interface BlobDoc {
  _id: string
  data: Buffer
  size: number
  createdAt: Date
}

export interface SnapshotFile {
  path: string
  hash: string
  size: number
}

export interface SnapshotDoc {
  _id: string
  appId: string
  files: SnapshotFile[]
  kind: 'init' | 'ai' | 'manual' | 'rollback' | 'interrupted' | 'build' | 'pre'
  message: string
  turnId?: string
  createdBy: string
  createdAt: Date
}

export interface BuildDoc {
  _id: string
  appId: string
  snapshotId: string
  status: 'queued' | 'running' | 'success' | 'failed'
  issues: CheckIssue[]
  manifest?: AppManifest
  files: SnapshotFile[]
  sizeBytes: number
  summary?: string
  /** 与当前线上版本相比，需要审批人确认的变更 */
  confirmations: string[]
  createdBy: string
  createdAt: Date
  startedAt?: Date
  finishedAt?: Date
}

export interface ReleaseDoc {
  _id: string
  appId: string
  buildId: string
  kind: 'release' | 'rollback'
  note: string
  createdBy: string
  createdAt: Date
}

export interface GrantDoc {
  _id: string
  appId: string
  type: 'capability' | 'biz'
  key: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string
  requestedBy: string
  reviewedBy?: string
  reviewNote?: string
  createdAt: Date
  reviewedAt?: Date
}

export interface BizApiDoc {
  _id: string
  prefix: string
  title: string
  description: string
  /** OpenAPI 3 文档的解析结果，由管理员登记或导入 */
  spec?: BizApiSpec
  /** 文档原文（YAML 或 JSON），编辑时原样回显 */
  specText?: string
  /** 文档之外的补充说明（约定、示例、注意事项） */
  docs: string
  /** 目录级默认上游地址（内网服务），接口可用 x-upstream 覆盖 */
  upstream?: string
  /** 目录级附加请求头（服务令牌），值支持 env:变量名 */
  headers?: Record<string, string>
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface SessionDoc {
  _id: string
  appId: string
  title: string
  createdBy: string
  createdAt: Date
  updatedAt: Date
  eventSeq: number
  usage: TurnUsage
  /** 上下文压缩后的早期对话摘要 */
  summary?: string
  summaryUpToTurn?: number
}

/** OpenAI Chat Completions 消息格式 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | Array<{ type: 'text', text: string } | { type: 'image_url', image_url: { url: string } }>
  tool_calls?: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>
  /** 思考模式下必须原样回传给模型，否则工具调用轮次会 400 */
  reasoning_content?: string
  tool_call_id?: string
  name?: string
}

export interface TurnDoc {
  _id: string
  sessionId: string
  appId: string
  index: number
  status: TurnStatus
  message: string
  attachments: Attachment[]
  planMode: boolean
  model: string
  createdBy: string
  createdAt: Date
  startedAt?: Date
  finishedAt?: Date
  usage: TurnUsage
  snapshotBefore?: string
  snapshotAfter?: string
  changes: FileChange[]
  error?: string
  /** 本轮产生的模型消息（user + assistant + tool），用于后续轮次的上下文 */
  messages: ChatMessage[]
}

export interface EventDoc {
  sessionId: string
  turnId: string
  seq: number
  ts: number
  [k: string]: unknown
}

export interface AuditDoc {
  _id?: unknown
  actor: string
  action: string
  appId?: string
  detail?: Record<string, unknown>
  createdAt: Date
}

export interface ApiClientDoc {
  _id: string
  name: string
  /** sha256(token)，明文只在创建时返回一次 */
  tokenHash: string
  /** 允许访问的应用；["*"] 表示全部 */
  appIds: string[]
  scopes: Array<'read' | 'write' | 'export' | 'dev'>
  /** 可选 IP 白名单（精确匹配或 CIDR 前缀不支持的简化写法） */
  allowedIps?: string[]
  createdBy: string
  createdAt: Date
  lastUsedAt?: Date
  revokedAt?: Date
}

export interface TelemetryDoc {
  appId: string
  channel: string
  type: string
  ts: Date
  path?: string
  uid?: string
  vid?: string
  data: Record<string, unknown>
}

let client: MongoClient
let db: Db
let memoryServer: { stop: () => Promise<unknown> } | null = null

/** MONGO_URL=memory 时启动内置的 mongod（本地没有 Docker 时调试用，数据保存在 DATA_DIR/mongo） */
async function memoryUrl() {
  const { MongoMemoryServer } = await import('mongodb-memory-server')
  const { mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const dbPath = join(config.dataDir, 'mongo')
  mkdirSync(dbPath, { recursive: true })
  const server = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger', port: 27018 } })
  memoryServer = server
  return `${server.getUri()}app_platform`
}

export async function connectMongo(url = config.mongoUrl) {
  if (url === 'memory')
    url = await memoryUrl()
  client = new MongoClient(url, { maxPoolSize: 50 })
  await client.connect()
  db = client.db()
  await ensureIndexes()
  return db
}

export function mongoClient() {
  return client
}

export async function closeMongo() {
  await client?.close()
  await memoryServer?.stop()
}

export const col = {
  get adminUsers() { return db.collection<AdminUserDoc>('admin_users') },
  get apps() { return db.collection<AppDoc>('apps') },
  get members() { return db.collection<MemberDoc>('app_members') },
  get draftFiles() { return db.collection<DraftFileDoc>('draft_files') },
  get blobs() { return db.collection<BlobDoc>('blobs') },
  get snapshots() { return db.collection<SnapshotDoc>('snapshots') },
  get builds() { return db.collection<BuildDoc>('builds') },
  get releases() { return db.collection<ReleaseDoc>('releases') },
  get grants() { return db.collection<GrantDoc>('grants') },
  get bizApis() { return db.collection<BizApiDoc>('biz_api_catalog') },
  get sessions() { return db.collection<SessionDoc>('agent_sessions') },
  get turns() { return db.collection<TurnDoc>('agent_turns') },
  get events() { return db.collection<EventDoc>('agent_events') },
  get audit() { return db.collection<AuditDoc>('audit_logs') },
  get apiClients() { return db.collection<ApiClientDoc>('api_clients') },
  get telemetry() { return db.collection<TelemetryDoc>('telemetry_events') },
}

/** 应用数据库：每个「应用 × 环境」一个库 */
export function appDataDb(appId: string, env: 'dev' | 'prod'): Db {
  return client.db(`appdata_${appId}_${env}`)
}

export function appCollection<T extends object = Record<string, unknown>>(appId: string, env: 'dev' | 'prod', name: string): Collection<T> {
  return appDataDb(appId, env).collection<T>(name)
}

async function ensureIndexes() {
  await Promise.all([
    col.adminUsers.createIndex({ feishuOpenId: 1 }, { unique: true, sparse: true }),
    col.members.createIndex({ appId: 1, userId: 1 }, { unique: true }),
    col.members.createIndex({ userId: 1 }),
    col.draftFiles.createIndex({ appId: 1, path: 1 }, { unique: true }),
    col.snapshots.createIndex({ appId: 1, createdAt: -1 }),
    col.builds.createIndex({ appId: 1, createdAt: -1 }),
    col.builds.createIndex({ status: 1, createdAt: 1 }),
    col.releases.createIndex({ appId: 1, createdAt: -1 }),
    col.grants.createIndex({ appId: 1, type: 1, key: 1 }),
    col.grants.createIndex({ status: 1, createdAt: -1 }),
    col.bizApis.createIndex({ prefix: 1 }, { unique: true }),
    col.sessions.createIndex({ appId: 1, updatedAt: -1 }),
    col.turns.createIndex({ sessionId: 1, index: 1 }),
    col.turns.createIndex({ appId: 1, status: 1, createdAt: 1 }),
    col.events.createIndex({ sessionId: 1, seq: 1 }, { unique: true }),
    col.audit.createIndex({ appId: 1, createdAt: -1 }),
    col.apiClients.createIndex({ tokenHash: 1 }, { unique: true }),
    col.telemetry.createIndex({ ts: 1 }, { expireAfterSeconds: 30 * 86400 }),
    col.telemetry.createIndex({ appId: 1, type: 1, ts: -1 }),
  ])
}
