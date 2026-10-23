import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FRONTEND_DIR, TAILWIND_FILE } from '@app-platform/app-template'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/** 平台自己的运行时文件：应用直接引用，不经过任何构建 */
const FILES: Record<string, { path: () => string, type: string }> = {
  '/__platform/dom.js': { path: () => join(FRONTEND_DIR, 'dom.js'), type: 'text/javascript; charset=utf-8' },
  '/__platform/ui.js': { path: () => join(FRONTEND_DIR, 'ui.js'), type: 'text/javascript; charset=utf-8' },
  '/__platform/ui.css': { path: () => join(FRONTEND_DIR, 'ui.css'), type: 'text/css; charset=utf-8' },
  '/__platform/tailwind.js': { path: () => TAILWIND_FILE, type: 'text/javascript; charset=utf-8' },
}

interface Cached {
  mtime: number
  data: Buffer
}

const cache = new Map<string, Cached>()

function load(path: string) {
  const mtime = statSync(path).mtimeMs
  const hit = cache.get(path)
  if (hit && hit.mtime === mtime)
    return hit
  const entry = { mtime, data: readFileSync(path) }
  if (cache.size > 20)
    cache.delete(cache.keys().next().value!)
  cache.set(path, entry)
  return entry
}

function send(reply: FastifyReply, req: FastifyRequest, entry: Cached, type: string, cacheControl: string) {
  const etag = `"${entry.mtime.toString(36)}-${entry.data.length.toString(36)}"`
  if (req.headers['if-none-match'] === etag)
    return reply.status(304).send()
  return reply
    .headers({
      'content-type': type,
      'cache-control': cacheControl,
      'etag': etag,
      'x-content-type-options': 'nosniff',
    })
    .send(entry.data)
}

/** 注册在 gateway 的 onRequest 之后；这些文件与应用无关，跨应用共享缓存 */
export function registerPlatformAssets(app: FastifyInstance) {
  for (const [path, meta] of Object.entries(FILES)) {
    app.get(path, async (req, reply) => {
      try {
        return send(reply, req, load(meta.path()), meta.type, 'public, max-age=86400')
      }
      catch {
        return reply.status(404).send('Not Found')
      }
    })
  }
}
