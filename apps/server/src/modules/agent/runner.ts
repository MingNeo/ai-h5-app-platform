import type { Attachment, CheckIssue, FileChange, TurnUsage } from '@app-platform/shared'
import { config } from '../../config'
import { createSnapshot, currentFiles, diffFiles } from '../../core/drafts'
import { formatIssues } from '../../core/checks'
import { chat, estimateTokens, LlmError } from '../../lib/llm'
import { type ChatMessage, col, type TurnDoc } from '../../lib/mongo'
import { store } from '../../lib/store'
import { newId } from '../../lib/tokens'
import { emitSessionEvent, reserveSeq, TurnEmitter } from './events'
import { buildSystemPrompt, buildUserContent, supportsVision } from './prompt'
import { executeTool, type ToolContext, toolDefsFor } from './tools'

const aborts = new Map<string, AbortController>()
const STORED_TOOL_OUTPUT = 4000
const OLD_TOOL_OUTPUT = 600

function today() {
  return new Date().toISOString().slice(0, 10)
}

export async function enqueueTurn(opts: { sessionId: string, appId: string, userId: string, message: string, attachments: Attachment[], planMode: boolean, model: string }) {
  const used = Number(await store.get(`agent:tok:${opts.userId}:${today()}`) ?? 0)
  if (used > config.llm.dailyTokensPerUser)
    throw new Error('今日 AI 用量已达上限，明天再来吧')
  const last = await col.turns.find({ sessionId: opts.sessionId }).sort({ index: -1 }).limit(1).next()
  const turn: TurnDoc = {
    _id: newId(),
    sessionId: opts.sessionId,
    appId: opts.appId,
    index: (last?.index ?? -1) + 1,
    status: 'queued',
    message: opts.message,
    attachments: opts.attachments,
    planMode: opts.planMode,
    model: opts.model,
    createdBy: opts.userId,
    createdAt: new Date(),
    usage: { inputTokens: 0, outputTokens: 0 },
    changes: [],
    messages: [],
  }
  await col.turns.insertOne(turn)
  await col.sessions.updateOne({ _id: opts.sessionId }, { $set: { updatedAt: new Date() } })
  await emitSessionEvent(opts.sessionId, turn._id, { type: 'turn.queued', message: opts.message, attachments: opts.attachments, planMode: opts.planMode })
  void kick(opts.appId)
  return turn
}

export async function stopTurn(turnId: string) {
  const t = await col.turns.findOne({ _id: turnId })
  if (!t)
    return
  if (t.status === 'queued') {
    await col.turns.updateOne({ _id: turnId, status: 'queued' }, { $set: { status: 'stopped', finishedAt: new Date() } })
    await emitSessionEvent(t.sessionId, t._id, { type: 'turn.done', status: 'stopped', usage: t.usage, changes: [], planMode: t.planMode })
    return
  }
  aborts.get(turnId)?.abort()
  void store.publish('agent:stop', turnId)
}

let stopSubscribed = false
function ensureStopSubscription() {
  if (stopSubscribed)
    return
  stopSubscribed = true
  store.subscribe('agent:stop', id => aborts.get(id)?.abort())
}

/** 同一应用的轮次串行执行：抢到锁的实例依次处理队列 */
export async function kick(appId: string) {
  ensureStopSubscription()
  const lockKey = `agent:lock:${appId}`
  if (!await store.setNX(lockKey, '1', 600))
    return
  const keepAlive = setInterval(() => void store.expire(lockKey, 600), 60_000)
  try {
    for (;;) {
      const turn = await col.turns.findOneAndUpdate(
        { appId, status: 'queued' },
        { $set: { status: 'running', startedAt: new Date() } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      )
      if (!turn)
        break
      await runTurn(turn).catch(e => console.error('[agent] 轮次异常', e))
    }
  }
  finally {
    clearInterval(keepAlive)
    await store.del(lockKey)
  }
}

/** 进程启动时：把上次异常退出时卡在 running 的轮次标记为失败，并继续处理排队中的轮次 */
export async function recoverTurns() {
  const stuck = await col.turns.find({ status: 'running' }).toArray()
  for (const t of stuck) {
    await col.turns.updateOne({ _id: t._id }, { $set: { status: 'failed', error: '服务重启，任务中断', finishedAt: new Date() } })
    await emitSessionEvent(t.sessionId, t._id, { type: 'turn.done', status: 'failed', usage: t.usage, changes: [], planMode: t.planMode, error: '服务重启，任务中断' })
  }
  const apps = await col.turns.distinct('appId', { status: 'queued' })
  for (const a of apps)
    void kick(a)
  setInterval(async () => {
    for (const a of await col.turns.distinct('appId', { status: 'queued' }))
      void kick(a)
  }, 5000).unref()
}

function shrinkForHistory(messages: ChatMessage[], limit: number): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > limit)
      return { ...m, content: `${m.content.slice(0, limit)}\n……（已省略）` }
    if (m.role === 'user' && Array.isArray(m.content))
      return { ...m, content: m.content.map(p => p.type === 'text' ? p.text : '[图片]').join('\n') }
    return m
  })
}

function messagesTokens(msgs: ChatMessage[]) {
  return msgs.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')) + estimateTokens(JSON.stringify(m.tool_calls ?? '')), 0)
}

/** 构造历史上下文；超过上下文窗口一半时把较早的轮次压缩成摘要 */
async function historyFor(turn: TurnDoc): Promise<ChatMessage[]> {
  const session = await col.sessions.findOne({ _id: turn.sessionId })
  const prev = await col.turns.find({ sessionId: turn.sessionId, index: { $lt: turn.index }, status: { $in: ['completed', 'stopped', 'failed'] } }).sort({ index: 1 }).toArray()
  const upTo = session?.summaryUpToTurn ?? -1
  let recent = prev.filter(t => t.index > upTo)
  const build = (turns: TurnDoc[]) => turns.flatMap((t, i) => shrinkForHistory(t.messages, i >= turns.length - 2 ? STORED_TOOL_OUTPUT : OLD_TOOL_OUTPUT))
  let msgs = build(recent)
  let summary = session?.summary
  if (messagesTokens(msgs) > config.llm.contextTokens * 0.5 && recent.length > 2) {
    const toSummarize = recent.slice(0, -2)
    const transcript = toSummarize.flatMap(t => t.messages).map((m) => {
      const c = typeof m.content === 'string' ? m.content : ''
      if (m.role === 'tool')
        return `[工具结果] ${c.slice(0, 300)}`
      if (m.role === 'assistant')
        return `[助手] ${c}${m.tool_calls?.length ? ` (调用 ${m.tool_calls.map(x => x.function.name).join(',')})` : ''}`
      return `[用户] ${c.slice(0, 2000)}`
    }).join('\n').slice(-60_000)
    try {
      const res = await chat({
        model: config.llm.smallModel,
        messages: [
          { role: 'system', content: '把下面的开发对话压缩成一份简洁的中文摘要，保留：用户的需求与偏好、已经完成的功能、关键的文件和数据集合设计、尚未解决的问题。不超过 800 字。' },
          { role: 'user', content: `${summary ? `之前的摘要：\n${summary}\n\n` : ''}${transcript}` },
        ],
      })
      summary = res.content.trim()
      const last = toSummarize[toSummarize.length - 1]!
      await col.sessions.updateOne({ _id: turn.sessionId }, { $set: { summary, summaryUpToTurn: last.index } })
      recent = recent.slice(-2)
      msgs = build(recent)
    }
    catch (e) {
      console.warn('[agent] 压缩上下文失败', (e as Error).message)
    }
  }
  return summary ? [{ role: 'user', content: `（之前对话的摘要）\n${summary}` }, { role: 'assistant', content: '好的，我已了解之前的进展。' }, ...msgs] : msgs
}

async function runTurn(turn: TurnDoc) {
  const ac = new AbortController()
  aborts.set(turn._id, ac)
  const em = new TurnEmitter(turn.sessionId, turn._id, await reserveSeq(turn.sessionId))
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0 }
  const app = await col.apps.findOne({ _id: turn.appId })
  const before = await createSnapshot(turn.appId, { kind: 'pre', message: '本轮开始前', userId: turn.createdBy, turnId: turn._id })
  const newMessages: ChatMessage[] = []
  let status: TurnDoc['status'] = 'completed'
  let error: string | undefined


  em.emit({ type: 'turn.start', message: turn.message, attachments: turn.attachments, planMode: turn.planMode, model: turn.model })

  const ctx: ToolContext = {
    appId: turn.appId,
    userId: turn.createdBy,
    planMode: turn.planMode,
    dirty: false,
    onTodos: (t) => {

      em.emit({ type: 'todo.update', todos: t })
    },
    onCheck: (s, issues) => em.emit({ type: 'check', status: s, issues: issues.slice(0, 50) }),
  }

  try {
    if (!app)
      throw new Error('应用不存在')
    const system = await buildSystemPrompt(app, turn.planMode)
    const history = await historyFor(turn)
    const userContent = await buildUserContent(turn.appId, turn.message, turn.attachments, supportsVision(turn.model))
    newMessages.push({ role: 'user', content: userContent })
    const tools = toolDefsFor(turn.planMode)
    let autoFix = 0

    for (let step = 0; step < config.llm.maxSteps; step++) {
      if (ac.signal.aborted)
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      let thinkStart = 0
      let thinkEnded = false
      const endThinking = () => {
        if (thinkStart && !thinkEnded) {
          thinkEnded = true
          em.emit({ type: 'thinking.end', durationMs: Date.now() - thinkStart })
        }
      }
      const res = await chat({
        model: turn.model,
        messages: [{ role: 'system', content: system }, ...history, ...newMessages],
        tools,
        signal: ac.signal,
        onReasoning: (d) => {
          if (!thinkStart)
            thinkStart = Date.now()
          em.emit({ type: 'thinking.delta', text: d })
        },
        onText: (d) => {
          endThinking()
          em.emit({ type: 'text.delta', text: d })
        },
      })
      endThinking()
      usage.inputTokens += res.usage.inputTokens
      usage.outputTokens += res.usage.outputTokens || estimateTokens(res.content + res.reasoning)

      newMessages.push({
        role: 'assistant',
        content: res.content || null,
        ...(res.reasoning ? { reasoning_content: res.reasoning } : {}),
        ...(res.toolCalls.length ? { tool_calls: res.toolCalls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) } : {}),
      })

      if (!res.toolCalls.length) {
        // 结束前强制校验：本轮改过文件但没校验，或最后一次校验没通过
        if (!turn.planMode && (ctx.dirty || ctx.lastCheck?.ok === false) && autoFix <= config.llm.maxAutoFix) {
          let issues: CheckIssue[] = ctx.lastCheck?.issues ?? []
          let passed = ctx.lastCheck?.ok ?? false
          if (ctx.dirty) {
            const r = await executeTool(ctx, 'check', '{}')
            passed = r.ok
            issues = ctx.lastCheck?.issues ?? []
          }
          if (!passed && autoFix < config.llm.maxAutoFix) {
            autoFix++
            em.emit({ type: 'check', status: 'failed', issues: issues.slice(0, 50), autoFixRound: autoFix })
            newMessages.push({ role: 'user', content: `自动校验未通过（第 ${autoFix} 次自动修复），请修复以下问题后再结束：\n${formatIssues(issues)}` })
            continue
          }
        }
        break
      }

      for (const call of res.toolCalls) {
        if (ac.signal.aborted)
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        let input: unknown = {}
        try {
          input = JSON.parse(call.arguments || '{}')
        }
        catch {
          input = call.arguments
        }
        em.emit({ type: 'tool.start', id: call.id, name: call.name, input: redactInput(call.name, input) })
        const out = await executeTool(ctx, call.name, call.arguments)
        em.emit({ type: 'tool.result', id: call.id, name: call.name, ok: out.ok, summary: out.summary })
        newMessages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: out.output })
      }
      if (step === config.llm.maxSteps - 1)
        em.emit({ type: 'text.delta', text: '\n\n（本轮步骤数已达上限，先停在这里。可以继续发消息让我接着做。）' })
    }
  }
  catch (e) {
    if ((e as Error).name === 'AbortError' || ac.signal.aborted) {
      status = 'stopped'
    }
    else {
      status = 'failed'
      error = e instanceof LlmError ? `模型服务异常：${e.message}` : (e as Error).message
      console.error('[agent] 轮次失败', e)
    }
  }
  finally {
    aborts.delete(turn._id)
  }

  // 收尾：快照、改动统计、落库
  let changes: FileChange[] = []
  let snapshotAfter: string | undefined
  try {
    const after = await currentFiles(turn.appId)
    changes = await diffFiles(before.files, after)
    if (changes.length) {
      const snap = await createSnapshot(turn.appId, {
        kind: status === 'completed' ? 'ai' : 'interrupted',
        message: `${status === 'completed' ? 'AI' : 'AI（已中断）'}：${turn.message.slice(0, 40)}`,
        userId: turn.createdBy,
        turnId: turn._id,
        files: after,
      })
      snapshotAfter = snap._id
    }
  }
  catch (e) {
    console.error('[agent] 生成快照失败', e)
  }
  em.emit({ type: 'turn.done', status, usage, changes, snapshotBefore: before._id, snapshotAfter, planMode: turn.planMode, error })
  await em.flush()

  const stored = newMessages.map(m => m.role === 'tool' && typeof m.content === 'string' && m.content.length > STORED_TOOL_OUTPUT ? { ...m, content: `${m.content.slice(0, STORED_TOOL_OUTPUT)}\n……` } : m)
  await col.turns.updateOne({ _id: turn._id }, {
    $set: { status, error, usage, changes, snapshotBefore: before._id, snapshotAfter, messages: stored, finishedAt: new Date() },
  })
  await col.sessions.updateOne({ _id: turn.sessionId }, {
    $inc: { 'usage.inputTokens': usage.inputTokens, 'usage.outputTokens': usage.outputTokens },
    $set: { updatedAt: new Date() },
  })
  await store.incr(`agent:tok:${turn.createdBy}:${today()}`, 86400 + 60, usage.inputTokens + usage.outputTokens)
  await store.incr(`agent:apptok:${turn.appId}:${today()}`, 86400 * 31, usage.inputTokens + usage.outputTokens)
}

/** 界面上不需要展示整份文件内容，截断以减少事件体积 */
function redactInput(name: string, input: unknown) {
  if (!input || typeof input !== 'object')
    return input
  const i = { ...(input as Record<string, unknown>) }
  if (name === 'write_file' && typeof i.content === 'string')
    i.content = `${i.content.split('\n').length} 行`
  if (name === 'edit_file') {
    for (const k of ['old_string', 'new_string']) {
      if (typeof i[k] === 'string' && (i[k] as string).length > 300)
        i[k] = `${(i[k] as string).slice(0, 300)}…`
    }
  }
  if (name === 'db_seed' && Array.isArray(i.docs))
    i.docs = `${i.docs.length} 条`
  return i
}
