import { ElMessage } from 'element-plus'

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public data?: any) {
    super(message)
  }
}

/**
 * 后台与应用同源，不能用 cookie 保存会话（应用页面发出的同源请求会自动带上 cookie）。
 * token 只放内存：sessionStorage 会随 window.open 复制给新标签页，
 * 而后台打开预览时新标签页里跑的就是应用代码，等于把管理员 token 交给应用。
 * 刷新页面后 token 丢失，Login.vue 会跳一次 /admin-api/auth/resume 用恢复 cookie 免登；
 * 恢复失败才退回飞书登录。
 */
let token: string | null = null

export function getToken(): string | null {
  return token
}

export function setToken(next: string) {
  token = next
}

export function clearToken() {
  token = null
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

export interface RequestOptions {
  method?: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  /** 出错时不弹提示 */
  quiet?: boolean
  formData?: FormData
}

export async function api<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(`/admin-api${path}`, location.origin)
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '')
      url.searchParams.set(k, String(v))
  }
  const method = opts.method ?? (opts.body !== undefined || opts.formData ? 'POST' : 'GET')
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token)
    headers.Authorization = `Bearer ${token}`
  let body: BodyInit | undefined
  if (opts.formData) {
    body = opts.formData
  }
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(url, { method, headers, body, credentials: 'same-origin' })
  }
  catch {
    if (!opts.quiet)
      ElMessage.error('网络异常')
    throw new ApiError('NETWORK_ERROR', '网络异常', 0)
  }
  let json: any = null
  try {
    json = await res.json()
  }
  catch {}
  if (res.status === 401) {
    clearToken()
    onUnauthorized?.()
    throw new ApiError('LOGIN_REQUIRED', json?.error_msg ?? '请先登录', 401)
  }
  if (!res.ok || (json && json.error_code !== 0)) {
    const e = new ApiError(json?.error_code ?? 'INTERNAL_ERROR', json?.error_msg ?? `请求失败（${res.status}）`, res.status, json?.data)
    if (!opts.quiet)
      ElMessage.error(e.message)
    throw e
  }
  return json?.data as T
}

/** 下载后台接口返回的文件（Bearer 不能靠 window.open 带上，用 fetch 转 Blob） */
export async function download(path: string, fallbackName = 'export.csv') {
  const token = getToken()
  const res = await fetch(`/admin-api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok)
    throw new ApiError('DOWNLOAD_FAILED', `下载失败（${res.status}）`, res.status)
  const disposition = res.headers.get('content-disposition') ?? ''
  const name = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] ?? fallbackName
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = decodeURIComponent(name)
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * 订阅 SSE（fetch 实现，支持自定义头与断线重连）。
 * App 切后台时系统会把这条流挂起：不报错也不 done，`reader.read()` 永远不 resolve，
 * 原生的"抛错才重连"逻辑就会卡死。所以加两道保险：
 * 1. 空闲看门狗：超过 IDLE_TIMEOUT 没收到任何字节（含心跳 ping）就强制 abort 重连；
 * 2. 回前台探测：visibilitychange/pageshow 一触发就强制 abort 重连一次，不等它自己报错。
 */
export function subscribeSse(path: string, onEvent: (data: any) => void, getAfter: () => number) {
  let stopped = false
  let ctrl: AbortController | null = null
  const IDLE_TIMEOUT = 40_000 // 服务端心跳 15s 一次，留 2+ 个心跳的余量
  let lastActivity = Date.now()
  let wake: (() => void) | null = null

  const kick = () => {
    ctrl?.abort()
    wake?.()
  }
  const onForeground = () => {
    if (document.visibilityState === 'visible')
      kick()
  }
  document.addEventListener('visibilitychange', onForeground)
  window.addEventListener('pageshow', onForeground)
  const watchdog = setInterval(() => {
    if (!stopped && Date.now() - lastActivity > IDLE_TIMEOUT)
      kick()
  }, 5000)

  const loop = async () => {
    let delay = 1000
    while (!stopped) {
      ctrl = new AbortController()
      lastActivity = Date.now()
      try {
        const token = getToken()
        const res = await fetch(`/admin-api${path}?after=${getAfter()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: ctrl.signal,
        })
        if (!res.ok || !res.body)
          throw new Error(String(res.status))
        delay = 1000
        lastActivity = Date.now()
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done)
            break
          lastActivity = Date.now()
          buf += decoder.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
            if (data) {
              try {
                onEvent(JSON.parse(data))
              }
              catch {}
            }
          }
        }
      }
      catch {
        if (stopped)
          return
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, delay)
      })
      wake = null
      delay = Math.min(delay * 2, 10000)
    }
  }
  void loop()
  return () => {
    stopped = true
    ctrl?.abort()
    wake?.()
    clearInterval(watchdog)
    document.removeEventListener('visibilitychange', onForeground)
    window.removeEventListener('pageshow', onForeground)
  }
}
