/** Agent 会话事件协议（SSE 推送，同时落库，按 seq 续传） */

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
}

export interface CheckIssue {
  source: 'guard' | 'build' | 'typecheck' | 'manifest' | 'runtime' | 'biz'
  severity: 'error' | 'warning'
  message: string
  file?: string
  line?: number
}

export interface Attachment {
  type: 'file' | 'collection' | 'error' | 'image'
  /** file: 路径；collection: 集合名；error: 报错文本；image: 图片 URL（data URL 或平台文件 URL） */
  value: string
  label?: string
}

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
}

export type TurnStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed'

export type AgentEventBody =
  | { type: 'turn.queued', message: string, attachments: Attachment[], planMode: boolean }
  | { type: 'turn.start', message: string, attachments: Attachment[], planMode: boolean, model: string }
  | { type: 'text.delta', text: string }
  | { type: 'thinking.delta', text: string }
  | { type: 'thinking.end', durationMs: number }
  | { type: 'tool.start', id: string, name: string, input: unknown }
  | { type: 'tool.result', id: string, name: string, ok: boolean, summary: string }
  | { type: 'todo.update', todos: TodoItem[] }
  | { type: 'check', status: 'running' | 'passed' | 'failed', issues: CheckIssue[], autoFixRound?: number }
  | { type: 'turn.done', status: TurnStatus, usage: TurnUsage, changes: FileChange[], snapshotBefore?: string, snapshotAfter?: string, planMode: boolean, error?: string }

export type AgentEvent = AgentEventBody & {
  sessionId: string
  turnId: string
  seq: number
  ts: number
}

/** 工具分类，用于前端把连续工具调用折叠成「已查看 N 个文件、修改 M 个文件」 */
export const TOOL_KIND: Record<string, 'read' | 'write' | 'check' | 'data' | 'plan' | 'other'> = {
  list_files: 'read',
  read_file: 'read',
  glob: 'read',
  grep: 'read',
  read_docs: 'read',
  write_file: 'write',
  edit_file: 'write',
  delete_file: 'write',
  move_file: 'write',
  add_dependency: 'write',
  check: 'check',
  get_runtime_errors: 'check',
  db_query: 'data',
  db_seed: 'data',
  todo_write: 'plan',
}
