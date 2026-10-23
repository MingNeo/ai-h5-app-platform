import type { AgentEvent, Attachment, CheckIssue, FileChange, TodoItem, TurnStatus, TurnUsage } from '@app-platform/shared'
import { TOOL_KIND } from '@app-platform/shared'

export interface ToolItem {
  id: string
  name: string
  input: any
  done: boolean
  ok?: boolean
  summary?: string
}

export type Segment =
  | { kind: 'thinking', text: string, durationMs?: number }
  | { kind: 'text', text: string }
  | { kind: 'tools', items: ToolItem[] }
  | { kind: 'todos' }
  | { kind: 'check', status: 'running' | 'passed' | 'failed', issues: CheckIssue[], autoFixRound?: number }

export interface TurnView {
  id: string
  message: string
  attachments: Attachment[]
  planMode: boolean
  model?: string
  status: TurnStatus
  segments: Segment[]
  todos: TodoItem[]
  usage?: TurnUsage
  changes: FileChange[]
  snapshotBefore?: string
  snapshotAfter?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

/** 按事件顺序还原每一轮的展示状态 */
export class TurnReducer {
  turns: TurnView[] = []
  private byId = new Map<string, TurnView>()
  private seen = new Set<number>()
  private turnMax = new Map<string, number>()
  lastSeq = 0

  /**
   * 断线续传的起点。排队/停止事件会越过正在运行轮次的 seq 段，
   * 所以不能只用全局 lastSeq，否则会漏掉运行中轮次随后到达的事件。
   */
  resumeAfter() {
    const open = this.turns.filter(t => t.status === 'running' || t.status === 'queued')
    if (!open.length)
      return this.lastSeq
    return Math.min(...open.map(t => this.turnMax.get(t.id) ?? 0))
  }

  /** 切换会话时清空，之后按事件顺序重新回放 */
  reset() {
    this.turns = []
    this.byId.clear()
    this.seen.clear()
    this.turnMax.clear()
    this.lastSeq = 0
  }

  private ensure(ev: AgentEvent): TurnView {
    const prev = this.byId.get(ev.turnId)
    // 事件都是原地修改，换成新对象视图层才会更新
    const t: TurnView = prev
      ? {
          ...prev,
          segments: prev.segments.map(s => s.kind === 'tools' ? { ...s, items: s.items.map(i => ({ ...i })) } : { ...s }),
          todos: [...prev.todos],
          changes: [...prev.changes],
          attachments: [...prev.attachments],
        }
      : { id: ev.turnId, message: '', attachments: [], planMode: false, status: 'queued', segments: [], todos: [], changes: [] }
    this.byId.set(ev.turnId, t)
    this.turns = prev ? this.turns.map(x => x === prev ? t : x) : [...this.turns, t]
    return t
  }

  apply(ev: AgentEvent): boolean {
    if (this.seen.has(ev.seq))
      return false
    this.seen.add(ev.seq)
    if (ev.seq > this.lastSeq)
      this.lastSeq = ev.seq
    this.turnMax.set(ev.turnId, Math.max(ev.seq, this.turnMax.get(ev.turnId) ?? 0))
    const t = this.ensure(ev)
    const last = t.segments[t.segments.length - 1]
    switch (ev.type) {
      case 'turn.queued':
        t.message = ev.message
        t.attachments = ev.attachments
        t.planMode = ev.planMode
        break
      case 'turn.start':
        t.message = ev.message
        t.attachments = ev.attachments
        t.planMode = ev.planMode
        t.model = ev.model
        t.status = 'running'
        t.startedAt = ev.ts
        break
      case 'thinking.delta':
        if (last?.kind === 'thinking' && last.durationMs === undefined)
          last.text += ev.text
        else t.segments.push({ kind: 'thinking', text: ev.text })
        break
      case 'thinking.end':
        for (let i = t.segments.length - 1; i >= 0; i--) {
          const s = t.segments[i]!
          if (s.kind === 'thinking') {
            s.durationMs = ev.durationMs
            break
          }
        }
        break
      case 'text.delta':
        if (last?.kind === 'text')
          last.text += ev.text
        else t.segments.push({ kind: 'text', text: ev.text })
        break
      case 'tool.start': {
        if (ev.name === 'todo_write')
          break
        const item: ToolItem = { id: ev.id, name: ev.name, input: ev.input, done: false }
        if (last?.kind === 'tools')
          last.items.push(item)
        else t.segments.push({ kind: 'tools', items: [item] })
        break
      }
      case 'tool.result': {
        for (const s of t.segments) {
          if (s.kind !== 'tools')
            continue
          const item = s.items.find(i => i.id === ev.id)
          if (item) {
            item.done = true
            item.ok = ev.ok
            item.summary = ev.summary
          }
        }
        break
      }
      case 'todo.update':
        t.todos = ev.todos
        if (!t.segments.some(s => s.kind === 'todos'))
          t.segments.push({ kind: 'todos' })
        break
      case 'check': {
        // 同一轮内的校验状态合并到最近一个校验条
        const prev = [...t.segments].reverse().find(s => s.kind === 'check') as Extract<Segment, { kind: 'check' }> | undefined
        if (prev && (prev.status === 'running' || last === prev)) {
          prev.status = ev.status
          prev.issues = ev.issues
          prev.autoFixRound = ev.autoFixRound ?? prev.autoFixRound
        }
        else {
          t.segments.push({ kind: 'check', status: ev.status, issues: ev.issues, autoFixRound: ev.autoFixRound })
        }
        break
      }
      case 'turn.done':
        t.status = ev.status
        t.usage = ev.usage
        t.changes = ev.changes
        t.snapshotBefore = ev.snapshotBefore
        t.snapshotAfter = ev.snapshotAfter
        t.error = ev.error
        t.planMode = ev.planMode
        t.finishedAt = ev.ts
        break
    }
    return true
  }
}

export const TOOL_LABEL: Record<string, string> = {
  list_files: '查看文件列表',
  read_file: '查看',
  glob: '查找文件',
  grep: '搜索',
  read_docs: '查阅文档',
  write_file: '写入',
  edit_file: '修改',
  delete_file: '删除',
  move_file: '移动',
  add_dependency: '添加依赖',
  check: '校验',
  get_runtime_errors: '查看运行时错误',
  db_query: '查询数据',
  db_seed: '写入示例数据',
}

export function toolsSummary(items: ToolItem[]) {
  const read = new Set<string>()
  const write = new Set<string>()
  let check = 0
  let data = 0
  let other = 0
  for (const i of items) {
    const kind = TOOL_KIND[i.name] ?? 'other'
    const path = i.input?.path ?? i.input?.to
    if (kind === 'read')
      read.add(path ?? `${i.name}${i.id}`)
    else if (kind === 'write')
      write.add(path ?? `${i.name}${i.id}`)
    else if (kind === 'check')
      check++
    else if (kind === 'data')
      data++
    else other++
  }
  const parts: string[] = []
  if (read.size)
    parts.push(`查看 ${read.size} 个文件`)
  if (write.size)
    parts.push(`修改 ${write.size} 个文件`)
  if (check)
    parts.push(`检查 ${check} 次`)
  if (data)
    parts.push(`操作数据 ${data} 次`)
  if (other)
    parts.push(`其他 ${other} 步`)
  const running = items.some(i => !i.done)
  return `${running ? '正在' : '已'}${parts.join('、') || '执行操作'}`
}
