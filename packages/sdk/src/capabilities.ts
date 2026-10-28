import { BOOT_MISSING_MESSAGE, config, isBootLoaded } from './config'
import { PlatformError } from './errors'
import { withLogin } from './http'

interface BizOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  data?: Record<string, any>
  query?: Record<string, string | number | boolean | undefined>
  headers?: Record<string, string>
}

/**
 * 业务接口一律经平台同源代理（/__platform/api/biz/*），由平台服务器请求上游服务。
 * 这样内网服务不需要对应用域名开 CORS，也不会暴露上游地址。
 */
export const biz = {
  request<T = any>(path: string, options: BizOptions = {}): Promise<T> {
    if (!isBootLoaded) {
      console.error(`[platform] ${BOOT_MISSING_MESSAGE}`)
      return Promise.reject(new PlatformError('INTERNAL_ERROR', BOOT_MISSING_MESSAGE))
    }
    if (!path.startsWith('/'))
      return Promise.reject(new PlatformError('VALIDATION_FAILED', '业务接口路径需以 / 开头', 422))
    if (config.biz.prefixes.length && !config.biz.prefixes.some(p => path.startsWith(p)))
      return Promise.reject(new PlatformError('CAPABILITY_NOT_GRANTED', `业务接口 ${path} 未授权，请在后台为应用申请`, 403))
    const method = options.method ?? 'GET'
    const url = new URL(`${config.apiBase}/biz${path}`, location.origin)
    const query = { ...(options.query ?? {}), ...(method === 'GET' ? options.data ?? {} : {}) }
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined)
        url.searchParams.set(k, String(v))
    }
    return withLogin(async () => {
      let res: Response
      try {
        res = await fetch(url.toString(), {
          method,
          credentials: 'same-origin',
          headers: {
            'X-App-SDK': '1',
            'X-App-Id': config.appId,
            'X-App-Channel': config.channel,
            ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
            ...options.headers,
          },
          body: method === 'GET' ? undefined : JSON.stringify(options.data ?? {}),
        })
      }
      catch {
        throw new PlatformError('NETWORK_ERROR', '网络异常，请稍后重试')
      }
      let body: any = null
      try {
        body = await res.json()
      }
      catch {}
      // 代理会用平台错误信封返回转发失败（capability/upstream），与上游原始响应区分开
      if (body?.error_code && typeof body.error_code === 'string') {
        if (body.error_code === 'LOGIN_REQUIRED')
          throw new PlatformError('LOGIN_REQUIRED', body.error_msg || '请先登录', 401)
        if (body.error_code === 'CAPABILITY_NOT_GRANTED')
          throw new PlatformError('CAPABILITY_NOT_GRANTED', body.error_msg || '业务接口未授权', 403)
        if (body.error_code === 'UPSTREAM_ERROR')
          throw new PlatformError('UPSTREAM_ERROR', body.error_msg || '业务接口不可用', 502)
      }
      const code = body?.error_code
      if (res.status === 401 || (code !== undefined && config.biz.unauthCodes.map(String).includes(String(code))))
        throw new PlatformError('LOGIN_REQUIRED', body?.error_msg || '请先登录', 401, code)
      if (!res.ok)
        throw new PlatformError('UPSTREAM_ERROR', body?.error_msg || `请求失败（${res.status}）`, res.status, code)
      if (code !== undefined && code !== 0 && code !== '0')
        throw new PlatformError('UPSTREAM_ERROR', body?.error_msg || '业务接口返回错误', res.status, code)
      // 返回上游的完整响应体，与 OpenAPI 文档里的返回结构、src/biz-api.d.ts 的类型保持一致。
      // 主站统一信封是 { error_code, error_msg, data }；error_code 非 0 或 401 已经在上面抛错，
      // 这里拿到的都是成功响应，业务代码按文档取 res.data 等字段。
      return body as T
    })
  },
}
