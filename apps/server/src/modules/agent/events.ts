import type { AgentEvent, AgentEventBody } from '@app-platform/shared'
import { col } from '../../lib/mongo'
import { store } from '../../lib/store'

const channel = (sessionId: string) => `agent:${sessionId}`

/**
 * 一个运行中轮次的事件发射器：分配递增 seq，实时推送（store pub/sub），批量落库。
 * text/thinking 增量按 80ms 合并成一个事件，减少落库条数。
 */
export class TurnEmitter {
  private seq: number
  private pending: AgentEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private deltaBuf: { type: 'text.delta' | 'thinking.delta', text: string } | null = null
  private deltaTimer: NodeJS.Timeout | null = null

  constructor(private sessionId: string, private turnId: string, startSeq: number) {
    this.seq = startSeq
  }

  get lastSeq() {
    return this.seq
  }

  emit(body: AgentEventBody) {
    if (body.type === 'text.delta' || body.type === 'thinking.delta') {
      if (this.deltaBuf && this.deltaBuf.type !== body.type)
        this.flushDelta()
      if (!this.deltaBuf)
        this.deltaBuf = { type: body.type, text: '' }
      this.deltaBuf.text += body.text
      if (!this.deltaTimer)
        this.deltaTimer = setTimeout(() => this.flushDelta(), 80)
      return
    }
    this.flushDelta()
    this.push(body)
  }

  private flushDelta() {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer)
      this.deltaTimer = null
    }
    if (this.deltaBuf?.text)
      this.push(this.deltaBuf)
    this.deltaBuf = null
  }

  private push(body: AgentEventBody) {
    const ev = { ...body, sessionId: this.sessionId, turnId: this.turnId, seq: ++this.seq, ts: Date.now() } as AgentEvent
    this.pending.push(ev)
    void store.publish(channel(this.sessionId), JSON.stringify(ev))
    if (!this.flushTimer)
      this.flushTimer = setTimeout(() => void this.flush(), 300)
  }

  async flush() {
    this.flushDelta()
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const batch = this.pending.splice(0)
    if (!batch.length)
      return
    await col.events.insertMany(batch as any[], { ordered: false }).catch(e => console.error('[agent] 事件落库失败', e))
  }
}

/** 会话级（非轮次内）的单个事件，比如排队 */
export async function emitSessionEvent(sessionId: string, turnId: string, body: AgentEventBody) {
  const s = await col.sessions.findOneAndUpdate({ _id: sessionId }, { $inc: { eventSeq: 1 } }, { returnDocument: 'after' })
  if (!s)
    return
  const ev = { ...body, sessionId, turnId, seq: s.eventSeq, ts: Date.now() } as AgentEvent
  await col.events.insertOne(ev as any)
  await store.publish(channel(sessionId), JSON.stringify(ev))
}

const SEQ_BLOCK = 1_000_000

/** 为一个轮次原子地预留一段 seq，避免与同会话的排队事件冲突（seq 允许有间隔） */
export async function reserveSeq(sessionId: string) {
  const s = await col.sessions.findOneAndUpdate({ _id: sessionId }, { $inc: { eventSeq: SEQ_BLOCK } }, { returnDocument: 'before' })
  return s?.eventSeq ?? 0
}

export function subscribeSession(sessionId: string, fn: (ev: AgentEvent) => void) {
  return store.subscribe(channel(sessionId), (msg) => {
    try {
      fn(JSON.parse(msg))
    }
    catch {}
  })
}
