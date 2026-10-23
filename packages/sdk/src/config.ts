export type NativeBridge = 'android-bridge' | 'call-native'

export interface NativeContainer {
  /** 容器标识，platform.env.container 返回该值 */
  id: string
  /** 匹配 UA 的正则（不区分大小写） */
  ua: string
  /** 原生桥协议 */
  bridge: NativeBridge
  /** call-native 协议下承载 callNative 的全局变量名 */
  global?: string
}

export interface BootConfig {
  appId: string
  channel: 'prod' | 'beta' | 'dev'
  version: string
  sdkVersion: string
  requireLogin: boolean
  authProvider: 'main-site' | 'mock'
  apiBase: string
  biz: {
    /** 已授权的业务接口前缀（仅用于提前报错，真正的校验在平台网关） */
    prefixes: string[]
    unauthCodes: Array<number | string>
  }
  login: {
    loginOrigin: string
    loginMobileOrigin: string
    fromActivity: string
    agreementUrl?: string
    privacyUrl?: string
  }
  /** 宿主 App 容器，由服务端按环境变量注入 */
  native: {
    containers: NativeContainer[]
  }
  /** 预览/测试版可被后台嵌入，日志通过 postMessage 发给后台 */
  adminOrigin?: string
  /** 预览身份被后台锁定（游客 / 测试身份）时为 true */
  identityLocked?: boolean
}

declare global {
  interface Window {
    __APP_CONFIG__?: BootConfig
  }
}

export const config: BootConfig = window.__APP_CONFIG__ ?? {
  appId: 'unknown',
  channel: 'dev',
  version: '0',
  sdkVersion: '1',
  requireLogin: false,
  authProvider: 'mock',
  apiBase: '/__platform/api',
  biz: { prefixes: [], unauthCodes: [401] },
  login: { loginOrigin: '', loginMobileOrigin: '', fromActivity: '' },
  native: { containers: [] },
}

export const isPreview = config.channel !== 'prod'
