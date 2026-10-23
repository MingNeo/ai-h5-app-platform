import { join } from 'node:path'
import { DOC_TOPICS, type DocTopic, loadDoc } from '@app-platform/agent-docs'
import { LOCKED_FILES, OPTIONAL_DEPENDENCIES } from '@app-platform/app-template'
import { ADMIN_VIEW_FILE, type CheckIssue, fieldsToJsonSchema, MANIFEST_FILE, normalizeQuery, parseAdminViewText, parseManifestText, renderBizApiDetail, renderBizApiIndex, type TodoItem, validateAdminView } from '@app-platform/shared'
import Ajv from 'ajv'
import type { Document } from 'mongodb'
import { config } from '../../config'
import { draftManifest } from '../../core/apps'
import { bizCheckInput, bizContext, bizEntriesOf, generatedFiles } from '../../core/biz-docs'
import { checkWorkspace, formatIssues } from '../../core/checks'
import { getDevErrors } from '../../core/dev-errors'
import { deleteDraft, listDraft, moveDraft, readDraftText, writeDraft } from '../../core/drafts'
import { lockedFiles } from '../../core/workspace'
import { AppError } from '../../lib/errors'
import type { ToolDef } from '../../lib/llm'
import { TEXT_EXT } from '../../lib/mime'
import { appCollection } from '../../lib/mongo'
import { newId } from '../../lib/tokens'
import { ensureWorkspace, flushWorkspace, workspaceDir } from '../preview/manager'
import { ensureIndexes } from '../gateway/data'

export interface ToolContext {
  appId: string
  userId: string
  planMode: boolean
  /** 本轮是否有文件改动尚未校验 */
  dirty: boolean
  lastCheck?: { ok: boolean, issues: CheckIssue[] }
  onTodos: (todos: TodoItem[]) => void
  onCheck: (status: 'running' | 'passed' | 'failed', issues: CheckIssue[]) => void
}

export interface ToolOutput {
  ok: boolean
  /** 给模型看的结果 */
  output: string
  /** 给界面看的一句话 */
  summary: string
}

const READ_ONLY = new Set(['list_files', 'read_file', 'glob', 'grep', 'read_docs', 'read_biz_api', 'get_runtime_errors', 'db_query', 'todo_write'])
const MAX_OUTPUT = 20_000

function def(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }
}

export const TOOL_DEFS: ToolDef[] = [
  def('list_files', '列出应用的全部文件（路径和大小）。', {}),
  def('read_file', '读取文件内容。大文件可以用 offset/limit 按行读取（行号从 1 开始）。', {
    path: { type: 'string', description: '相对路径，例如 src/pages/Home.vue' },
    offset: { type: 'integer', description: '起始行号' },
    limit: { type: 'integer', description: '读取行数' },
  }, ['path']),
  def('write_file', '创建或整体覆盖一个文件。只能写 src/、public/ 下的文件以及根目录的 index.html、manifest.json。', {
    path: { type: 'string' },
    content: { type: 'string', description: '完整文件内容' },
  }, ['path', 'content']),
  def('edit_file', '精确替换文件中的一段文本。old_string 必须与文件内容逐字一致（包括缩进），且在文件中唯一；需要全部替换时设置 replace_all。', {
    path: { type: 'string' },
    old_string: { type: 'string' },
    new_string: { type: 'string' },
    replace_all: { type: 'boolean' },
  }, ['path', 'old_string', 'new_string']),
  def('delete_file', '删除文件。', { path: { type: 'string' } }, ['path']),
  def('move_file', '移动或重命名文件。', { from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']),
  def('glob', '按通配符查找文件，例如 src/**/*.vue。', { pattern: { type: 'string' } }, ['pattern']),
  def('grep', '在文本文件中按正则搜索，返回匹配的行。', {
    pattern: { type: 'string', description: 'JavaScript 正则' },
    glob: { type: 'string', description: '限定文件范围，例如 src/**/*.vue' },
    ignore_case: { type: 'boolean' },
  }, ['pattern']),
  def('todo_write', '更新本次任务的步骤清单（会展示给用户）。每次传完整列表；同一时间只能有一个 in_progress。', {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
        required: ['content', 'status'],
        additionalProperties: false,
      },
    },
  }, ['todos']),
  def('add_dependency', `声明使用白名单依赖（可选：${OPTIONAL_DEPENDENCIES.join('、')}），声明后才能 import。`, {
    name: { type: 'string', enum: OPTIONAL_DEPENDENCIES },
  }, ['name']),
  def('check', '校验应用：manifest 校验、安全扫描、类型检查、构建。改完代码后必须调用，有错误要修复。', {}),
  def('get_runtime_errors', '获取预览页面里最近的运行时错误、控制台报错、接口失败和编译错误。', {
    since_minutes: { type: 'integer', description: '只看最近多少分钟，默认 30' },
  }),
  def('db_query', '查询预览（dev）环境的数据，用于确认数据是否写入正确。', {
    collection: { type: 'string' },
    where: { type: 'object', description: '查询条件（同 SDK 的 where）' },
    limit: { type: 'integer' },
  }, ['collection']),
  def('db_seed', '向预览（dev）环境写入示例数据（例如 readonly 集合的活动配置），会按 manifest 的 fields 校验。', {
    collection: { type: 'string' },
    docs: { type: 'array', items: { type: 'object' } },
  }, ['collection', 'docs']),
  def('read_docs', `读取平台文档。可选主题：${Object.entries(DOC_TOPICS).map(([k, v]) => `${k}（${v}）`).join('；')}`, {
    topic: { type: 'string', enum: Object.keys(DOC_TOPICS) },
  }, ['topic']),
  def('read_biz_api', '查看平台已登记的业务接口文档（参数、请求体、返回结构、示例）。manifest 声明但还没开通的前缀也能读，可先按文档写代码；调用业务接口前必读，不要凭猜测传参或取字段。', {
    prefix: { type: 'string', description: '接口前缀，例如 /api/coupon/；省略时返回全部已授权的接口' },
    path: { type: 'string', description: '只看某一个接口路径，例如 /api/coupon/list' },
  }),
]

export function toolDefsFor(planMode: boolean) {
  return planMode ? TOOL_DEFS.filter(t => READ_ONLY.has(t.function.name)) : TOOL_DEFS
}

function globToRegex(glob: string) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    }
    else if (c === '*') {
      re += '[^/]*'
    }
    else if (c === '?') {
      re += '[^/]'
    }
    else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

function truncate(s: string) {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n……（内容过长已截断，请用 offset/limit 分段读取）` : s
}

async function validateManifestWrite(content: string) {
  const res = parseManifestText(content)
  if (!res.ok)
    throw new AppError('VALIDATION_FAILED', `manifest.json 校验失败，未写入：\n${res.errors.join('\n')}`)
}

/** admin.json：结构校验 + 引用的集合/字段必须在 manifest 中 */
async function validateAdminViewWrite(appId: string, content: string) {
  const res = parseAdminViewText(content)
  if (!res.ok)
    throw new AppError('VALIDATION_FAILED', `admin.json 校验失败，未写入：\n${res.errors.join('\n')}`)
  const errors = validateAdminView(res.view, (await draftManifest(appId)).manifest)
  if (errors.length)
    throw new AppError('VALIDATION_FAILED', `admin.json 引用的集合/字段有误，未写入：\n${errors.join('\n')}`)
}

type Args = Record<string, any>

async function run(ctx: ToolContext, name: string, args: Args): Promise<ToolOutput> {
  const { appId, userId } = ctx
  switch (name) {
    case 'list_files': {
      const files = await listDraft(appId)
      const lines = files.map(f => `${f.path}  (${f.size}B)`)
      lines.push(...LOCKED_FILES.map(p => `${p}  (平台锁定，只读)`))
      return { ok: true, output: lines.join('\n'), summary: `${files.length} 个文件` }
    }
    case 'read_file': {
      const path = String(args.path ?? '')
      let text = LOCKED_FILES.includes(path) ? lockedFiles(await generatedFiles(appId))[path] ?? null : await readDraftText(appId, path)
      if (text === null)
        return { ok: false, output: `文件不存在：${path}`, summary: path }
      if (!TEXT_EXT.test(path))
        return { ok: true, output: `${path} 是二进制文件（${Buffer.byteLength(text)}B），无法以文本读取`, summary: path }
      const lines = text.split('\n')
      if (args.offset || args.limit) {
        const start = Math.max(1, Number(args.offset) || 1)
        const end = Math.min(lines.length, start - 1 + (Number(args.limit) || 400))
        text = lines.slice(start - 1, end).join('\n')
        return { ok: true, output: truncate(`（第 ${start}-${end} 行，共 ${lines.length} 行）\n${text}`), summary: path }
      }
      return { ok: true, output: truncate(text), summary: path }
    }
    case 'write_file': {
      const path = String(args.path ?? '')
      const content = String(args.content ?? '')
      if (path === MANIFEST_FILE)
        await validateManifestWrite(content)
      if (path === ADMIN_VIEW_FILE)
        await validateAdminViewWrite(appId, content)
      const existed = (await readDraftText(appId, path)) !== null
      await writeDraft(appId, path, content, { userId })
      ctx.dirty = true
      return { ok: true, output: `${existed ? '已覆盖' : '已创建'} ${path}（${content.split('\n').length} 行）`, summary: path }
    }
    case 'edit_file': {
      const path = String(args.path ?? '')
      const oldStr = String(args.old_string ?? '')
      const newStr = String(args.new_string ?? '')
      const text = await readDraftText(appId, path)
      if (text === null)
        return { ok: false, output: `文件不存在：${path}`, summary: path }
      if (!oldStr)
        return { ok: false, output: 'old_string 不能为空', summary: path }
      const count = text.split(oldStr).length - 1
      if (count === 0)
        return { ok: false, output: `在 ${path} 中没有找到 old_string，请先 read_file 确认最新内容（注意缩进和空格）`, summary: path }
      if (count > 1 && !args.replace_all)
        return { ok: false, output: `old_string 在 ${path} 中出现了 ${count} 次，请提供更多上下文使其唯一，或设置 replace_all`, summary: path }
      const next = args.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr)
      if (path === MANIFEST_FILE)
        await validateManifestWrite(next)
      if (path === ADMIN_VIEW_FILE)
        await validateAdminViewWrite(appId, next)
      await writeDraft(appId, path, next, { userId })
      ctx.dirty = true
      return { ok: true, output: `已修改 ${path}${args.replace_all ? `（替换 ${count} 处）` : ''}`, summary: path }
    }
    case 'delete_file': {
      const path = String(args.path ?? '')
      if (path === MANIFEST_FILE || path === ADMIN_VIEW_FILE || path === 'index.html' || path === 'src/main.ts')
        return { ok: false, output: `${path} 是必需文件，不能删除`, summary: path }
      await deleteDraft(appId, path, { userId })
      ctx.dirty = true
      return { ok: true, output: `已删除 ${path}`, summary: path }
    }
    case 'move_file': {
      await moveDraft(appId, String(args.from), String(args.to), { userId })
      ctx.dirty = true
      return { ok: true, output: `已移动 ${args.from} → ${args.to}`, summary: `${args.from} → ${args.to}` }
    }
    case 'glob': {
      const re = globToRegex(String(args.pattern ?? '**'))
      const files = (await listDraft(appId)).map(f => f.path).filter(p => re.test(p))
      return { ok: true, output: files.join('\n') || '（没有匹配的文件）', summary: `${args.pattern}：${files.length} 个` }
    }
    case 'grep': {
      let re: RegExp
      try {
        re = new RegExp(String(args.pattern ?? ''), args.ignore_case ? 'i' : '')
      }
      catch (e) {
        return { ok: false, output: `正则无效：${(e as Error).message}`, summary: String(args.pattern) }
      }
      const fileRe = args.glob ? globToRegex(String(args.glob)) : null
      const out: string[] = []
      for (const f of await listDraft(appId)) {
        if (!TEXT_EXT.test(f.path) || (fileRe && !fileRe.test(f.path)))
          continue
        const text = await readDraftText(appId, f.path) ?? ''
        text.split('\n').forEach((line, i) => {
          if (out.length < 100 && re.test(line))
            out.push(`${f.path}:${i + 1}: ${line.trim().slice(0, 200)}`)
        })
      }
      return { ok: true, output: out.join('\n') || '（没有匹配）', summary: `${args.pattern}：${out.length} 处` }
    }
    case 'todo_write': {
      const todos = (Array.isArray(args.todos) ? args.todos : []).slice(0, 20).map((t: any) => ({
        content: String(t.content ?? '').slice(0, 200),
        status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
      })) as TodoItem[]
      ctx.onTodos(todos)
      return { ok: true, output: '已更新步骤清单', summary: `${todos.filter(t => t.status === 'completed').length}/${todos.length} 完成` }
    }
    case 'add_dependency': {
      const dep = String(args.name ?? '')
      if (!OPTIONAL_DEPENDENCIES.includes(dep))
        return { ok: false, output: `${dep} 不在白名单内，可选：${OPTIONAL_DEPENDENCIES.join('、')}`, summary: dep }
      const text = await readDraftText(appId, MANIFEST_FILE) ?? '{}'
      const m = JSON.parse(text)
      m.dependencies = [...new Set([...(m.dependencies ?? []), dep])]
      const next = `${JSON.stringify(m, null, 2)}\n`
      await validateManifestWrite(next)
      await writeDraft(appId, MANIFEST_FILE, next, { userId })
      ctx.dirty = true
      return { ok: true, output: `已声明依赖 ${dep}，现在可以 import 它了`, summary: dep }
    }
    case 'check': {
      ctx.onCheck('running', [])
      await ensureWorkspace(appId)
      await flushWorkspace(appId)
      const res = await checkWorkspace(workspaceDir(appId), {
        outDir: join(config.dataDir, 'check-out', appId),
        cacheDir: join(config.dataDir, 'vite-cache', `${appId}-check`),
        biz: await bizCheckInput(appId),
      })
      ctx.dirty = false
      ctx.lastCheck = { ok: res.ok, issues: res.issues }
      ctx.onCheck(res.ok ? 'passed' : 'failed', res.issues)
      const errors = res.issues.filter(i => i.severity === 'error').length
      const warnings = res.issues.length - errors
      return {
        ok: res.ok,
        output: res.issues.length ? `${res.ok ? '校验通过' : '校验未通过'}（${errors} 个错误，${warnings} 个警告）：\n${formatIssues(res.issues)}` : '校验通过，没有问题',
        summary: res.ok ? (warnings ? `通过，${warnings} 个警告` : '通过') : `${errors} 个错误`,
      }
    }
    case 'get_runtime_errors': {
      const since = Date.now() - (Number(args.since_minutes) || 30) * 60_000
      const errors = await getDevErrors(appId, since, 30)
      if (!errors.length)
        return { ok: true, output: '最近没有运行时错误。（如果用户反馈有问题，可能是还没在预览里复现，可以请用户在预览里操作一次）', summary: '无错误' }
      const lines = errors.map(e => `[${new Date(e.ts).toLocaleTimeString('zh-CN')}][${e.kind}] ${e.message}${e.stack ? `\n${e.stack.split('\n').slice(0, 4).join('\n')}` : ''}`)
      return { ok: true, output: truncate(lines.join('\n\n')), summary: `${errors.length} 条` }
    }
    case 'db_query': {
      const name = String(args.collection ?? '')
      const manifest = (await draftManifest(appId)).manifest
      if (!manifest?.collections[name] && !['_kv_app', '_kv_user'].includes(name))
        return { ok: false, output: `集合 ${name} 未在 manifest.json 中声明`, summary: name }
      const q = normalizeQuery({ where: args.where, limit: Math.min(Number(args.limit) || 20, 50) })
      const docs = await appCollection(appId, 'dev', name).find(q.where as Document).sort({ _createdAt: -1 }).limit(q.limit).toArray()
      return { ok: true, output: truncate(JSON.stringify(docs, null, 2)), summary: `${name}：${docs.length} 条` }
    }
    case 'db_seed': {
      const name = String(args.collection ?? '')
      const manifest = (await draftManifest(appId)).manifest
      const colDef = manifest?.collections[name]
      if (!colDef)
        return { ok: false, output: `集合 ${name} 未在 manifest.json 中声明`, summary: name }
      const docs = Array.isArray(args.docs) ? args.docs.slice(0, 100) : []
      const validate = new Ajv({ allErrors: true, strict: false }).compile(fieldsToJsonSchema(colDef.fields))
      const now = Date.now()
      const rows: Document[] = []
      for (const [i, d] of docs.entries()) {
        if (!validate(d))
          return { ok: false, output: `第 ${i + 1} 条数据不符合 fields 定义：${JSON.stringify(validate.errors?.slice(0, 3))}`, summary: name }
        rows.push({ ...d, _id: newId(), _owner: 'admin', _ownerProfile: { nickname: '运营', avatar: '' }, _createdAt: now + i, _updatedAt: now + i })
      }
      await ensureIndexes(appId, 'dev', name, colDef)
      if (rows.length)
        await appCollection(appId, 'dev', name).insertMany(rows as any[])
      return { ok: true, output: `已向 dev 环境的 ${name} 写入 ${rows.length} 条数据`, summary: `${name}：${rows.length} 条` }
    }
    case 'read_docs': {
      const topic = String(args.topic ?? '') as DocTopic
      if (!(topic in DOC_TOPICS))
        return { ok: false, output: `未知主题，可选：${Object.keys(DOC_TOPICS).join('、')}`, summary: topic }
      return { ok: true, output: loadDoc(topic), summary: DOC_TOPICS[topic] }
    }
    case 'read_biz_api': {
      const { entries, catalog, granted } = await bizContext(appId)
      const prefix = args.prefix ? String(args.prefix) : undefined
      const path = args.path ? String(args.path) : undefined
      // 目录里匹配的服务：可以按前缀查，也可以直接按完整接口路径查；未开通的也能读到文档
      const matched = catalog.filter(c => (!prefix && !path) || (prefix && (c.prefix.startsWith(prefix) || prefix.startsWith(c.prefix))) || (path && path.startsWith(c.prefix)))
      if (!matched.length) {
        const list = catalog.map(c => `${c.title}（${c.prefix}，${c.operations} 个接口）`).join('；')
        return {
          ok: false,
          output: `平台目录里没有匹配「${prefix ?? path ?? '全部'}」的业务接口。已登记的服务：${list || '无'}。\n如果用户需要这个接口，请让平台管理员先在后台「业务接口目录」登记；不要按惯例猜路径。`,
          summary: '目录未登记',
        }
      }
      const docs = await bizEntriesOf(matched.map(c => c.prefix))
      const detail = renderBizApiDetail(docs, { path })
      if (!detail)
        return { ok: false, output: `已登记的接口里没有 ${path ?? prefix}。请核对路径和方法。`, summary: '未找到' }
      const status = docs.map(d => `${d.prefix} ${granted.some(g => d.prefix.startsWith(g)) ? '已开通' : '未开通（调用会 403，需要用户去后台「能力」页申请）'}`).join('\n')
      return { ok: true, output: truncate(`${status}\n\n${detail}`), summary: prefix ?? '全部接口' }
    }
    default:
      return { ok: false, output: `未知工具 ${name}`, summary: name }
  }
}

export async function executeTool(ctx: ToolContext, name: string, rawArgs: string): Promise<ToolOutput> {
  if (ctx.planMode && !READ_ONLY.has(name))
    return { ok: false, output: '当前是方案模式，只能阅读代码和数据，不能修改文件', summary: '方案模式下不可用' }
  let args: Args
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {}
  }
  catch {
    return { ok: false, output: `参数不是合法 JSON：${rawArgs.slice(0, 200)}`, summary: '参数错误' }
  }
  try {
    return await run(ctx, name, args)
  }
  catch (e) {
    const msg = e instanceof AppError ? e.message : `执行失败：${(e as Error).message}`
    return { ok: false, output: msg, summary: msg.split('\n')[0]!.slice(0, 80) }
  }
}
