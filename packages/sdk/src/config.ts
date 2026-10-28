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

const boot = window.__APP_CONFIG__

/** 复制一份：应用代码改 window.__APP_CONFIG__ 不能影响 SDK 已确定的渠道 */
function cloneBoot(b: BootConfig): BootConfig {
  try {
    return JSON.parse(JSON.stringify(b)) as BootConfig
  }
  catch {
    return { ...b }
  }
}

/**
 * boot.js 注入的启动配置。缺失或渠道非法时不做任何猜测：
 * 平台接口一律拒绝，避免回退到错误的（测试）环境。
 */
export const config: BootConfig = Object.freeze(boot ? cloneBoot(boot) : {
  appId: '',
  channel: '' as BootConfig['channel'],
  version: '0',
  sdkVersion: '1',
  requireLogin: false,
  authProvider: 'mock',
  apiBase: '/__platform/api',
  biz: { prefixes: [], unauthCodes: [401] },
  login: { loginOrigin: '', loginMobileOrigin: '', fromActivity: '' },
  native: { containers: [] },
}) as BootConfig

/** 启动配置是否有效；无效时 SDK 不发出任何平台请求（只看内部副本，不受页面后续改写影响） */
export const isBootLoaded = Boolean(
  config.appId
  && (config.channel === 'prod' || config.channel === 'beta' || config.channel === 'dev'),
)

export const BOOT_MISSING_MESSAGE = '应用启动配置未加载（/__platform/boot.js 未执行成功），已阻止平台接口请求'

export const isPreview = isBootLoaded && config.channel !== 'prod'
