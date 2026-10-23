import { config, isPreview } from './config'
import { onRequest } from './http'

interface TelemetryEvent {
  type: 'pv' | 'error' | 'api' | 'perf' | 'custom'
  ts: number
  path: string
  [k: string]: unknown
}

const queue: TelemetryEvent[] = []
let timer = 0

function flush() {
  timer = 0
  if (!queue.length)
    return
  const body = JSON.stringify({ events: queue.splice(0, 50) })
  // sendBeacon 不能带自定义头，appId / 渠道放进查询参数
  const url = `${config.apiBase}/telemetry?app=${encodeURIComponent(config.appId)}&channel=${encodeURIComponent(config.channel)}`
  // sendBeacon 不能带自定义头，网关对 telemetry 单独放行
  if (!navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }))) {
    fetch(url, { method: 'POST', body, keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'text/plain' } }).catch(() => {})
  }
  if (queue.length)
    schedule()
}

function schedule() {
  if (!timer)
    timer = window.setTimeout(flush, 5000)
}

export function report(type: TelemetryEvent['type'], data: Record<string, unknown> = {}) {
  queue.push({ type, ts: Date.now(), path: location.pathname, ...data })
  if (queue.length >= 20)
    flush()
  else schedule()
}

// ---- 预览环境：日志转发给后台（postMessage）+ 上报到服务端供 AI 读取 ----
const devQueue: Array<Record<string, unknown>> = []
let devTimer = 0

function stringify(v: unknown): string {
  if (v instanceof Error)
    return `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split('\n').slice(1, 6).join('\n')}` : ''}`
  if (typeof v === 'string')
    return v
  try {
    return JSON.stringify(v)
  }
  catch {
    return String(v)
  }
}

function toAdmin(entry: Record<string, unknown>) {
  if (!config.adminOrigin || window.parent === window)
    return
  try {
    window.parent.postMessage({ source: 'app-preview', appId: config.appId, ...entry }, config.adminOrigin)
  }
  catch {}
}

function devReport(entry: Record<string, unknown>) {
  devQueue.push(entry)
  if (!devTimer) {
    devTimer = window.setTimeout(() => {
      devTimer = 0
      const entries = devQueue.splice(0, 50)
      fetch(`${config.apiBase}/dev/errors`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-App-SDK': '1', 'X-App-Id': config.appId, 'X-App-Channel': config.channel },
        body: JSON.stringify({ entries }),
      }).catch(() => {})
    }, 1000)
  }
}

export function initTelemetry() {
  const pv = () => report('pv', { referrer: document.referrer })
  pv()
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m]
    history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
      const r = orig.apply(this, args)
      pv()
      toAdmin({ kind: 'route', path: location.pathname + location.search })
      return r
    }
  }
  window.addEventListener('popstate', pv)
  window.addEventListener('pagehide', flush)

  window.addEventListener('error', (e) => {
    const target = e.target as HTMLElement | null
    if (target && target !== (window as unknown) && (target as any).tagName) {
      const src = (target as any).src || (target as any).href
      const message = `资源加载失败：<${target.tagName.toLowerCase()}> ${src}`
      report('error', { kind: 'resource', message })
      if (isPreview) {
        toAdmin({ kind: 'error', level: 'error', message })
        devReport({ kind: 'resource', message })
      }
      return
    }
    const message = e.message || String(e.error)
    const stack = e.error?.stack
    report('error', { kind: 'js', message, stack, file: e.filename, line: e.lineno })
    if (isPreview) {
      toAdmin({ kind: 'error', level: 'error', message: stringify(e.error ?? message) })
      devReport({ kind: 'js', message, stack, file: e.filename, line: e.lineno })
    }
  }, true)

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    if (reason?.name === 'PlatformError' && reason.code === 'LOGIN_CANCELLED')
      return
    const message = `未处理的 Promise 异常：${stringify(reason)}`
    report('error', { kind: 'promise', message })
    if (isPreview) {
      toAdmin({ kind: 'error', level: 'error', message })
      devReport({ kind: 'promise', message })
    }
  })

  onRequest((info) => {
    if (!info.ok)
      report('api', { url: info.url, status: info.status, durationMs: info.durationMs, error: info.error })
    if (isPreview) {
      toAdmin({ kind: 'request', ...info })
      if (!info.ok && info.status !== 401)
        devReport({ kind: 'api', message: `${info.method} ${info.url} → ${info.status} ${info.error ?? ''}` })
    }
  })

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries()
      const last = entries[entries.length - 1]
      if (last)
        report('perf', { metric: 'LCP', value: Math.round(last.startTime) })
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  }
  catch {}

  if (isPreview) {
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      const orig = console[level].bind(console)
      console[level] = (...args: unknown[]) => {
        orig(...args)
        const message = args.map(stringify).join(' ').slice(0, 4000)
        toAdmin({ kind: 'console', level, message })
        if (level === 'error' || (level === 'warn' && message.includes('[Vue warn]')))
          devReport({ kind: level === 'error' ? 'console' : 'vue-warn', message })
      }
    }
    toAdmin({ kind: 'ready', path: location.pathname + location.search })
  }
}
