import { join } from 'node:path'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { createPlatformViteConfig, createServer } from '@app-platform/app-template'
import { appHost } from '@app-platform/shared'
import { config } from '../../config'
import { generatedFiles } from '../../core/biz-docs'
import { pushDevError } from '../../core/dev-errors'
import { currentFiles, type DraftChange, draftEvents } from '../../core/drafts'
import { materialize, removeWorkspaceFile, writeGeneratedFiles, writeWorkspaceFile } from '../../core/workspace'
import { col } from '../../lib/mongo'
import { freePort, proxyHttp, proxyUpgrade } from '../../lib/proxy'

type ViteDevServer = Awaited<ReturnType<typeof createServer>>

interface Running {
  server: ViteDevServer
  port: number
  lastAccess: number
}

const running = new Map<string, Running>()
const starting = new Map<string, Promise<Running>>()
const materialized = new Set<string>()
const syncQueues = new Map<string, Promise<void>>()

export function workspaceDir(appId: string) {
  return join(config.dataDir, 'workspaces', appId)
}

/** 把草稿同步到工作区（检查、预览共用）；平台生成的文件（业务接口类型）随授权变化刷新 */
export async function ensureWorkspace(appId: string) {
  const dir = workspaceDir(appId)
  const generated = await generatedFiles(appId)
  if (materialized.has(appId)) {
    writeGeneratedFiles(dir, generated)
    return dir
  }
  await materialize(dir, await currentFiles(appId), generated)
  materialized.add(appId)
  return dir
}

/** 等待工作区写入完成（检查前调用，保证磁盘与草稿一致） */
export async function flushWorkspace(appId: string) {
  await syncQueues.get(appId)
}

draftEvents.on('change', ({ appId, changes }: { appId: string, changes: DraftChange[] }) => {
  if (!materialized.has(appId))
    return
  const dir = workspaceDir(appId)
  const prev = syncQueues.get(appId) ?? Promise.resolve()
  const next = prev.then(async () => {
    for (const c of changes) {
      if (c.deleted) {
        removeWorkspaceFile(dir, c.path)
        continue
      }
      const f = await col.draftFiles.findOne({ appId, path: c.path })
      if (f)
        await writeWorkspaceFile(dir, c.path, f.hash)
    }
  }).catch(e => console.error('[preview] 同步工作区失败', e))
  syncQueues.set(appId, next)
})

async function start(appId: string): Promise<Running> {
  const root = await ensureWorkspace(appId)
  const port = await freePort()
  const devHost = appHost(appId, 'dev', config.baseDomain)
  const logger = {
    hasWarned: false,
    info: (msg: string) => {
      if (/error|failed/i.test(msg))
        void pushDevError(appId, { kind: 'compile', message: stripAnsi(msg) })
    },
    warn: (msg: string) => {
      if (/\[vite\]|failed|error/i.test(msg))
        void pushDevError(appId, { kind: 'compile-warning', message: stripAnsi(msg) })
    },
    warnOnce(msg: string) { this.warn(msg) },
    error: (msg: string) => {
      void pushDevError(appId, { kind: 'compile', message: stripAnsi(msg) })
    },
    clearScreen() {},
    hasErrorLogged: () => false,
  }
  const server = await createServer(createPlatformViteConfig({
    command: 'serve',
    root,
    cacheDir: join(config.dataDir, 'vite-cache', appId),
    port,
    hmr: { protocol: 'wss', clientPort: 443, path: '/__vite_hmr' },
    allowedHosts: [devHost, '127.0.0.1', 'localhost'],
    customLogger: logger as any,
    logLevel: 'info',
  }))
  await server.listen()
  const r = { server, port, lastAccess: Date.now() }
  running.set(appId, r)
  console.info(`[preview] ${appId} dev server 已启动 :${port}`)
  return r
}

export async function getPreview(appId: string): Promise<Running> {
  const r = running.get(appId)
  if (r) {
    r.lastAccess = Date.now()
    return r
  }
  let p = starting.get(appId)
  if (!p) {
    p = start(appId).finally(() => starting.delete(appId))
    starting.set(appId, p)
  }
  return p
}

export async function stopPreview(appId: string) {
  const r = running.get(appId)
  running.delete(appId)
  await r?.server.close().catch(() => {})
}

export function previewStatus(appId: string) {
  const r = running.get(appId)
  return r ? { running: true, port: r.port, lastAccess: r.lastAccess } : { running: false }
}

export async function proxyPreviewRequest(appId: string, req: http.IncomingMessage, res: http.ServerResponse, headers: (status: number, ct?: string) => Record<string, string>) {
  try {
    const r = await getPreview(appId)
    proxyHttp(req, res, r.port, {
      setHeaders: (h, status) => headers(status, String(h['content-type'] ?? '')),
    })
  }
  catch (e) {
    console.error('[preview] 启动失败', e)
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`预览启动失败：${(e as Error).message}`)
  }
}

export async function proxyPreviewUpgrade(appId: string, req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  const r = running.get(appId) ?? await getPreview(appId).catch(() => null)
  if (!r) {
    socket.destroy()
    return
  }
  r.lastAccess = Date.now()
  proxyUpgrade(req, socket, head, r.port)
}

function stripAnsi(s: string) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

export function startPreviewReaper() {
  setInterval(() => {
    const idleMs = config.limits.previewIdleMinutes * 60_000
    for (const [appId, r] of running) {
      if (Date.now() - r.lastAccess > idleMs) {
        console.info(`[preview] ${appId} 空闲回收`)
        void stopPreview(appId)
      }
    }
  }, 60_000).unref()
}

export async function stopAllPreviews() {
  await Promise.all([...running.keys()].map(stopPreview))
}
