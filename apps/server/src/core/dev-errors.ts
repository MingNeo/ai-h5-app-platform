import { store } from '../lib/store'

export interface DevErrorEntry {
  ts: number
  kind: string
  message: string
  stack?: string
  file?: string
  line?: number
}

const KEY = (appId: string) => `deverr:${appId}`

export async function pushDevError(appId: string, entry: Omit<DevErrorEntry, 'ts'> & { ts?: number }) {
  const e: DevErrorEntry = { ts: entry.ts ?? Date.now(), ...entry, message: String(entry.message).slice(0, 4000) }
  await store.lpush(KEY(appId), JSON.stringify(e), 200, 86400)
  void store.publish(`deverr:${appId}`, JSON.stringify(e))
}

export async function getDevErrors(appId: string, since = 0, limit = 50): Promise<DevErrorEntry[]> {
  const raw = await store.lrange(KEY(appId), 200)
  const out: DevErrorEntry[] = []
  for (const r of raw) {
    try {
      const e = JSON.parse(r) as DevErrorEntry
      if (e.ts > since)
        out.push(e)
    }
    catch {}
  }
  return out.slice(0, limit).reverse()
}

export async function clearDevErrors(appId: string) {
  await store.del(KEY(appId))
}
