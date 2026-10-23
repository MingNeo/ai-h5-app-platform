import { createHash } from 'node:crypto'
import { Binary } from 'mongodb'
import { col } from './mongo'

/**
 * 内容寻址的二进制存储。默认存在 Mongo（适合百级应用、小文件），
 * 线上需要时可替换为 COS 实现，接口不变。
 */
export interface BlobStore {
  put(data: Buffer): Promise<{ hash: string, size: number }>
  get(hash: string): Promise<Buffer | null>
  has(hash: string): Promise<boolean>
}

const CACHE_MAX_BYTES = 64 * 1024 * 1024
const cache = new Map<string, Buffer>()
let cacheBytes = 0

function cacheSet(hash: string, data: Buffer) {
  if (data.length > 4 * 1024 * 1024)
    return
  if (cache.has(hash))
    return
  cache.set(hash, data)
  cacheBytes += data.length
  while (cacheBytes > CACHE_MAX_BYTES) {
    const [k, v] = cache.entries().next().value as [string, Buffer]
    cache.delete(k)
    cacheBytes -= v.length
  }
}

export function sha256(data: Buffer | string) {
  return createHash('sha256').update(data).digest('hex')
}

class MongoBlobStore implements BlobStore {
  async put(data: Buffer) {
    const hash = sha256(data)
    await col.blobs.updateOne(
      { _id: hash },
      { $setOnInsert: { _id: hash, data, size: data.length, createdAt: new Date() } },
      { upsert: true },
    )
    cacheSet(hash, data)
    return { hash, size: data.length }
  }

  async get(hash: string) {
    const hit = cache.get(hash)
    if (hit) {
      cache.delete(hash)
      cache.set(hash, hit)
      return hit
    }
    const doc = await col.blobs.findOne({ _id: hash })
    if (!doc)
      return null
    const raw = doc.data as unknown
    const buf = raw instanceof Binary ? Buffer.from(raw.buffer) : Buffer.from(raw as Buffer)
    cacheSet(hash, buf)
    return buf
  }

  async has(hash: string) {
    return cache.has(hash) || (await col.blobs.countDocuments({ _id: hash }, { limit: 1 })) > 0
  }
}

export const blobs: BlobStore = new MongoBlobStore()
