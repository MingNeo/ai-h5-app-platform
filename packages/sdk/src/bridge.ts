// 最小化的原生桥：只用于拉起原生登录。
// 两套协议由服务端 APP_CONTAINERS 配置决定：android-bridge（AndroidBridge / iOSBridge）
// 与 call-native（全局 callNative，消息做 URI 编码并把数字转成字符串）。
import { nativeContainer } from './env'

interface NativeHost {
  callNative?: (msg: string) => void
  postMessage?: (msg: string) => void
}

interface W {
  AndroidBridge?: NativeHost
  webkit?: { messageHandlers?: Record<string, NativeHost | undefined> }
  callNative?: (msg: string) => void
  _handleCallNativeCallback?: (id: string, data: string) => void
  _handleNativeMessage?: (module: string, action: string, data: string) => void
  [key: string]: unknown
}
const w = window as unknown as W

const callbacks = new Map<string, (data: unknown) => void>()
let seq = 0

function installCallbackHandler() {
  const prevCallback = w._handleCallNativeCallback
  w._handleCallNativeCallback = (id, data) => {
    const cb = callbacks.get(id)
    if (cb) {
      callbacks.delete(id)
      let parsed: unknown = data
      try {
        parsed = JSON.parse(data)
      }
      catch {}
      cb(parsed)
      return
    }
    prevCallback?.(id, data)
  }
}

function sendAndroidBridge(message: Record<string, unknown>) {
  const msg = JSON.stringify(message)
  const android = w.AndroidBridge
  if (android?.callNative) {
    android.callNative(msg)
    return
  }
  const ios = w.webkit?.messageHandlers?.iOSBridge
  if (ios?.postMessage) {
    ios.postMessage(msg)
    return
  }
  throw new Error('当前 App 未提供原生桥')
}

function stringifyNumbers(obj: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (typeof v === 'number')
      obj[k] = String(v)
    else if (v && typeof v === 'object' && !Array.isArray(v))
      stringifyNumbers(v as Record<string, unknown>)
  }
  return obj
}

function sendCallNative(message: Record<string, unknown>) {
  const msg = encodeURIComponent(JSON.stringify(stringifyNumbers(message)))
  const globalName = nativeContainer?.global
  const host = globalName ? (w[globalName] as NativeHost | undefined) : undefined
  if (host?.callNative) {
    host.callNative(msg)
    return
  }
  const callNativeHandler = w.webkit?.messageHandlers?.callNative
  if (callNativeHandler?.postMessage) {
    callNativeHandler.postMessage(msg)
    return
  }
  if (typeof w.callNative === 'function') {
    w.callNative(msg)
    return
  }
  throw new Error('当前 App 未提供原生桥')
}

/** 拉起原生登录；onResult 在 App 支持回调时触发 */
export function callNativeLogin(onResult?: (data: unknown) => void) {
  const container = nativeContainer
  if (!container)
    throw new Error('不在 App 内')

  if (container.bridge === 'android-bridge') {
    installCallbackHandler()
    const callbackId = onResult ? `app_${Date.now()}_${seq++}` : ''
    if (onResult)
      callbacks.set(callbackId, onResult)
    sendAndroidBridge({ module: 'module_user', action: 'user_login', map: {}, callbackId })
    return
  }

  sendCallNative({
    module: 'module_detail_common',
    action: 'call_client_login',
    map: { redirect_data: { link_type: 'other', sub_type: '', link: location.href } },
  })
}
