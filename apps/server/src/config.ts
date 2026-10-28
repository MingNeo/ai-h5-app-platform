import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..')

/** 读取仓库根目录的 .env.local（不覆盖已有环境变量） */
function loadEnvFile(file: string) {
  if (!existsSync(file))
    return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#'))
      continue
    let value = m[2]!
    if (/^(['"]).*\1$/.test(value))
      value = value.slice(1, -1)
    if (process.env[m[1]!] === undefined)
      process.env[m[1]!] = value
  }
}
loadEnvFile(join(REPO_ROOT, '.env.local'))

const env = process.env

function bool(v: string | undefined, def = false) {
  if (v === undefined || v === '')
    return def
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

function list(v: string | undefined) {
  return (v ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

function num(v: string | undefined, def: number) {
  const n = Number(v)
  return Number.isFinite(n) && v !== '' && v !== undefined ? n : def
}

const baseDomain = (env.APP_BASE_DOMAIN || '').trim().toLowerCase().replace(/\.$/, '')
if (!baseDomain)
  throw new Error('缺少环境变量 APP_BASE_DOMAIN（平台唯一入口域名，例如 apps.example.com）')
if (baseDomain.split('.').length < 2)
  throw new Error('APP_BASE_DOMAIN 需要是完整域名，例如 apps.example.com')

export type NativeBridge = 'android-bridge' | 'call-native'

export interface NativeContainer {
  /** 应用端可读到的容器标识，任意小写标识，如 panel-a */
  id: string
  /** 匹配 UA 的正则（不区分大小写） */
  ua: string
  /** 原生桥协议 */
  bridge: NativeBridge
  /** call-native 协议下承载 callNative 的全局变量名；android-bridge 忽略 */
  global?: string
}

/**
 * APP_CONTAINERS：宿主 App 容器列表
 * 格式：id:ua正则:协议[:全局变量名]，逗号分隔
 * 例：panel-a:appone:android-bridge,panel-b:apptwo:call-native:apptwoBridge
 */
function parseContainers(raw: string | undefined): NativeContainer[] {
  const out: NativeContainer[] = []
  for (const item of list(raw)) {
    const [id, ua, bridge, global] = item.split(':')
    if (!id || !ua || (bridge !== 'android-bridge' && bridge !== 'call-native')) {
      console.warn(`[config] 忽略无法解析的 APP_CONTAINERS 项：${item}`)
      continue
    }
    try {
      // 提前校验正则，避免在浏览器端抛错
      void new RegExp(ua, 'i')
    }
    catch {
      console.warn(`[config] 忽略非法 UA 正则：${item}`)
      continue
    }
    out.push({ id, ua, bridge, global: global || undefined })
  }
  return out
}

const nativeContainers = parseContainers(env.APP_CONTAINERS)

// 只复用主站真实登录：平台不签发自己的会话，也不提供模拟登录。
// 主站地址内置，环境变量仅用于覆盖（例如测试环境指向别的登录服务）。
const MAIN_SITE_LOGIN_ORIGIN = 'https://zhiyou.smzdm.com'
const MAIN_SITE_USERINFO_URL = `${MAIN_SITE_LOGIN_ORIGIN}/user/info/jsonp_get_current`
const authUserInfoUrl = env.AUTH_USERINFO_URL || MAIN_SITE_USERINFO_URL
const loginOrigin = env.LOGIN_ORIGIN || MAIN_SITE_LOGIN_ORIGIN

export const config = {
  repoRoot: REPO_ROOT,
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  baseDomain,
  /** 本地免登时额外接受的 Host（直接访问 localhost:3000 调试用） */
  devHosts: list(env.DEV_HOSTS || (bool(env.DEV_ADMIN_BYPASS) ? 'localhost,127.0.0.1' : '')).map(h => h.toLowerCase()),
  /** 后台与应用同源：/admin、/admin-api */
  adminOrigin: `https://${baseDomain}`,
  roles: new Set(list(env.ROLES || 'api,build')),

  mongoUrl: env.MONGO_URL || 'mongodb://127.0.0.1:27017/app_platform',
  redisUrl: env.REDIS_URL || '',
  dataDir: resolve(REPO_ROOT, env.DATA_DIR || '.data'),
  secret: env.SECRET || (() => {
    const s = randomBytes(32).toString('hex')
    console.warn('[config] 未配置 SECRET，使用随机值（重启后后台登录和预览票据会失效）')
    return s
  })(),

  auth: {
    userInfoUrl: authUserInfoUrl,
    /** 显式开启才允许模拟登录（dev/beta 渠道）；线上正式环境不要设置 ALLOW_MOCK_LOGIN */
    allowMockLogin: bool(env.ALLOW_MOCK_LOGIN),
    cacheSeconds: num(env.AUTH_CACHE_SECONDS, 60),
    /** 用户信息接口里表示用户 ID 的字段，按顺序取第一个非空值 */
    uidFields: list(env.AUTH_UID_FIELDS || 'smzdm_id,uid,user_id'),
    loginOrigin,
    loginMobileOrigin: env.LOGIN_MOBILE_ORIGIN || loginOrigin,
    fromActivity: env.LOGIN_FROM_ACTIVITY || '',
    agreementUrl: env.LOGIN_AGREEMENT_URL || '',
    privacyUrl: env.LOGIN_PRIVACY_URL || '',
  },

  native: {
    containers: nativeContainers,
  },

  biz: {
    /** 未配置上游时使用的默认地址；目录/接口可以用 upstream / x-upstream 覆盖 */
    origin: env.BIZ_API_ORIGIN || '',
    unauthCodes: list(env.BIZ_UNAUTH_CODES || '401'),
    timeoutMs: Number(env.BIZ_TIMEOUT_MS || 15000),
    /** 后台「连通性测试」读取响应体的上限，超出会截断展示 */
    testMaxBodyBytes: Number(env.BIZ_TEST_MAX_BODY_BYTES || 65536),
  },

  csp: {
    imgExtra: list(env.CSP_IMG_EXTRA || ''),
    geetest: ['https://static.geetest.com', 'https://static.geevisit.com', 'https://api.geetest.com', 'https://api.geevisit.com', 'https://monitor.geetest.com'],
  },

  guard: {
    /** 应用代码里禁止使用的依赖（精确包名） */
    forbiddenPackages: list(env.GUARD_FORBIDDEN_PACKAGES),
    /** 允许整页跳转的主机（含子域），留空则任何外部跳转只告警 */
    allowedRedirectHosts: list(env.GUARD_ALLOWED_REDIRECT_HOSTS),
  },

  admin: {
    devBypass: bool(env.DEV_ADMIN_BYPASS),
    feishuAppId: env.FEISHU_APP_ID || '',
    feishuAppSecret: env.FEISHU_APP_SECRET || '',
    feishuTenantKey: env.FEISHU_TENANT_KEY || '',
    platformAdmins: list(env.PLATFORM_ADMINS),
    feishuBotWebhook: env.FEISHU_BOT_WEBHOOK || '',
  },

  llm: {
    provider: (env.LLM_PROVIDER || (env.LLM_BASE_URL ? 'openai' : 'mock')) as 'openai' | 'mock',
    baseUrl: (env.LLM_BASE_URL || '').replace(/\/$/, ''),
    apiKey: env.LLM_API_KEY || '',
    models: list(env.LLM_MODELS),
    defaultModel: env.LLM_DEFAULT_MODEL || list(env.LLM_MODELS)[0] || 'mock-coder',
    smallModel: env.LLM_SMALL_MODEL || env.LLM_DEFAULT_MODEL || list(env.LLM_MODELS)[0] || 'mock-coder',
    visionModels: list(env.LLM_VISION_MODELS),
    contextTokens: num(env.LLM_CONTEXT_TOKENS, 128_000),
    maxSteps: num(env.AGENT_MAX_STEPS, 40),
    maxAutoFix: num(env.AGENT_MAX_AUTOFIX, 3),
    dailyTokensPerUser: num(env.AGENT_DAILY_TOKENS_PER_USER, 5_000_000),
  },

  moderation: {
    blockedWords: list(env.MODERATION_BLOCKED_WORDS),
  },

  limits: {
    uploadBytes: num(env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
    kvValueBytes: 64 * 1024,
    docBytes: 16 * 1024,
    writesPerMinutePerUser: num(env.WRITES_PER_MINUTE_PER_USER, 120),
    apiPerMinutePerIp: num(env.API_PER_MINUTE_PER_IP, 1200),
  },
}

export type Config = typeof config
