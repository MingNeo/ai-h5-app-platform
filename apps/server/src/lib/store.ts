// 键值/计数/队列/发布订阅：配置了 REDIS_URL 用 Redis，否则退回进程内存（仅适合本地单进程）
import { EventEmitter } from 'node:events'
import { Redis } from 'ioredis'
import { config } from '../config'

export interface Store {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSec?: number): Promise<void>
  /** 不存在时才写入，成功返回 true（用于锁） */
  setNX(key: string, value: string, ttlSec: number): Promise<boolean>
  del(key: string): Promise<void>
  expire(key: string, ttlSec: number): Promise<void>
  /** 自增，首次创建时设置过期时间 */
  incr(key: string, ttlSec: number, by?: number): Promise<number>
  /** 追加到列表头部并截断到 max 条 */
  lpush(key: string, value: string, max: number, ttlSec?: number): Promise<void>
  lrange(key: string, count: number): Promise<string[]>
  publish(channel: string, message: string): Promise<void>
  subscribe(channel: string, fn: (message: string) => void): () => void
  close(): Promise<void>
}

class MemoryStore implements Store {
  private data = new Map<string, { value: string | string[], expires: number }>()
  private bus = new EventEmitter().setMaxListeners(0)

  private alive(key: string) {
    const e = this.data.get(key)
    if (!e)
      return null
    if (e.expires && e.expires < Date.now()) {
      this.data.delete(key)
      return null
    }
    return e
  }

  async get(key: string) {
    const e = this.alive(key)
    return typeof e?.value === 'string' ? e.value : null
  }

  async set(key: string, value: string, ttlSec?: number) {
    this.data.set(key, { value, expires: ttlSec ? Date.now() + ttlSec * 1000 : 0 })
  }

  async setNX(key: string, value: string, ttlSec: number) {
    if (this.alive(key))
      return false
    await this.set(key, value, ttlSec)
    return true
  }

  async del(key: string) {
    this.data.delete(key)
  }

  async expire(key: string, ttlSec: number) {
    const e = this.alive(key)
    if (e)
      e.expires = Date.now() + ttlSec * 1000
  }

  async incr(key: string, ttlSec: number, by = 1) {
    const e = this.alive(key)
    const next = (e ? Number(e.value) : 0) + by
    this.data.set(key, { value: String(next), expires: e?.expires || Date.now() + ttlSec * 1000 })
    return next
  }

  async lpush(key: string, value: string, max: number, ttlSec?: number) {
    const e = this.alive(key)
    const arr = Array.isArray(e?.value) ? e.value : []
    arr.unshift(value)
    arr.length = Math.min(arr.length, max)
    this.data.set(key, { value: arr, expires: ttlSec ? Date.now() + ttlSec * 1000 : e?.expires ?? 0 })
  }

  async lrange(key: string, count: number) {
    const e = this.alive(key)
    return Array.isArray(e?.value) ? e.value.slice(0, count) : []
  }

  async publish(channel: string, message: string) {
    this.bus.emit(channel, message)
  }

  subscribe(channel: string, fn: (message: string) => void) {
    this.bus.on(channel, fn)
    return () => {
      this.bus.off(channel, fn)
    }
  }

  async close() {}
}

class RedisStore implements Store {
  private pub: Redis
  private sub: Redis
  private handlers = new Map<string, Set<(m: string) => void>>()

  constructor(url: string) {
    this.pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 })
    this.sub = new Redis(url, { lazyConnect: false })
    this.sub.on('message', (channel: string, message: string) => {
      for (const fn of this.handlers.get(channel) ?? [])
        fn(message)
    })
  }

  async get(key: string) {
    return this.pub.get(key)
  }

  async set(key: string, value: string, ttlSec?: number) {
    if (ttlSec)
      await this.pub.set(key, value, 'EX', ttlSec)
    else await this.pub.set(key, value)
  }

  async setNX(key: string, value: string, ttlSec: number) {
    return (await this.pub.set(key, value, 'EX', ttlSec, 'NX')) === 'OK'
  }

  async del(key: string) {
    await this.pub.del(key)
  }

  async expire(key: string, ttlSec: number) {
    await this.pub.expire(key, ttlSec)
  }

  async incr(key: string, ttlSec: number, by = 1) {
    const res = await this.pub.multi().incrby(key, by).expire(key, ttlSec, 'NX').exec()
    return Number(res?.[0]?.[1] ?? 0)
  }

  async lpush(key: string, value: string, max: number, ttlSec?: number) {
    const m = this.pub.multi().lpush(key, value).ltrim(key, 0, max - 1)
    if (ttlSec)
      m.expire(key, ttlSec)
    await m.exec()
  }

  async lrange(key: string, count: number) {
    return this.pub.lrange(key, 0, count - 1)
  }

  async publish(channel: string, message: string) {
    await this.pub.publish(channel, message)
  }

  subscribe(channel: string, fn: (message: string) => void) {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
      void this.sub.subscribe(channel)
    }
    set.add(fn)
    return () => {
      set!.delete(fn)
      if (!set!.size) {
        this.handlers.delete(channel)
        void this.sub.unsubscribe(channel)
      }
    }
  }

  async close() {
    this.pub.disconnect()
    this.sub.disconnect()
  }
}

export let store: Store

export function initStore() {
  if (config.redisUrl) {
    store = new RedisStore(config.redisUrl)
  }
  else {
    console.warn('[store] 未配置 REDIS_URL，使用进程内存（仅适合本地单进程调试）')
    store = new MemoryStore()
  }
  return store
}

/** 固定窗口限流：超过 limit 返回 false */
export async function rateLimit(key: string, limit: number, windowSec: number) {
  const bucket = Math.floor(Date.now() / 1000 / windowSec)
  const n = await store.incr(`rl:${key}:${bucket}`, windowSec + 1)
  return n <= limit
}
