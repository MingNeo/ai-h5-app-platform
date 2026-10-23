import { config } from './config'
import { type ErrorCode, PlatformError, isPlatformError } from './errors'

type LoginHandler = () => Promise<unknown>
let loginHandler: LoginHandler | null = null
const listeners: Array<(info: RequestInfo) => void> = []

export interface RequestInfo {
  method: string
  url: string
  status: number
  ok: boolean
  durationMs: number
  error?: string
}

export function setLoginHandler(fn: LoginHandler) {
  loginHandler = fn
}

export function onRequest(fn: (info: RequestInfo) => void) {
  listeners.push(fn)
}

function emit(info: RequestInfo) {
  for (const fn of listeners) {
    try {
      fn(info)
    }
    catch {}
  }
}

export interface ApiInit {
  method?: string
  body?: unknown
  /** 原样作为 fetch body（FormData 等） */
  rawBody?: BodyInit
  signal?: AbortSignal
}

/** 调用平台网关（同源），不处理登录 */
export async function rawApi<T>(path: string, init: ApiInit = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined && init.rawBody === undefined ? 'GET' : 'POST')
  const url = `${config.apiBase}${path}`
  const headers: Record<string, string> = { 'X-App-SDK': '1' }
  let body: BodyInit | undefined = init.rawBody
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.body)
  }
  const start = Date.now()
  let res: Response
  try {
    res = await fetch(url, { method, headers, body, credentials: 'same-origin', signal: init.signal })
  }
  catch (e) {
    emit({ method, url, status: 0, ok: false, durationMs: Date.now() - start, error: String(e) })
    throw new PlatformError('NETWORK_ERROR', '网络异常，请稍后重试')
  }
  let payload: { error_code?: number | string, error_msg?: string, data?: T } | null = null
  try {
    payload = await res.json()
  }
  catch {}
  const durationMs = Date.now() - start
  if (res.status === 401) {
    emit({ method, url, status: 401, ok: false, durationMs })
    throw new PlatformError('LOGIN_REQUIRED', payload?.error_msg || '请先登录', 401)
  }
  if (!res.ok || !payload || (payload.error_code !== 0 && payload.error_code !== undefined)) {
    const code = (typeof payload?.error_code === 'string' ? payload.error_code : 'INTERNAL_ERROR') as ErrorCode
    const msg = payload?.error_msg || `请求失败（${res.status}）`
    emit({ method, url, status: res.status, ok: false, durationMs, error: msg })
    throw new PlatformError(code, msg, res.status)
  }
  emit({ method, url, status: res.status, ok: true, durationMs })
  return payload.data as T
}

/**
 * 带 401 拦截的调用：遇到 LOGIN_REQUIRED 时拉起全局登录（全局只拉起一次），
 * 登录成功后重放本次请求；用户取消则 reject LOGIN_CANCELLED。
 * 被 401 拒绝的请求服务端没有执行，所以重放是安全的。
 */
export async function withLogin<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  }
  catch (e) {
    if (!isPlatformError(e) || e.code !== 'LOGIN_REQUIRED' || !loginHandler)
      throw e
    await loginHandler()
    return await fn()
  }
}

export function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  return withLogin(() => rawApi<T>(path, init))
}
