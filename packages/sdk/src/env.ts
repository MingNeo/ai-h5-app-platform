import { config, type NativeContainer } from './config'

const ua = navigator.userAgent

function matchContainer(c: NativeContainer): boolean {
  try {
    return new RegExp(c.ua, 'i').test(ua)
  }
  catch {
    return false
  }
}

/** 当前宿主 App 容器（由服务端 APP_CONTAINERS 注入），普通浏览器为 null */
export const nativeContainer: NativeContainer | null = config.native?.containers?.find(matchContainer) ?? null

/** 容器标识；不在任何宿主 App 内时为 browser */
export const container: string = nativeContainer?.id ?? 'browser'

export const os: 'ios' | 'android' | 'harmony' | 'other'
  = /harmonyos|openharmony/i.test(ua) ? 'harmony' : /android/i.test(ua) ? 'android' : /iphone|ipad|ipod|ios/i.test(ua) ? 'ios' : 'other'

export const env = {
  inApp: nativeContainer !== null,
  container,
  os,
}
