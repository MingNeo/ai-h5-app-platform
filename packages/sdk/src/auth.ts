import { callNativeLogin } from './bridge'
import { config } from './config'
import { container } from './env'
import { PlatformError } from './errors'
import { rawApi, setLoginHandler } from './http'
import { showBlocker, showLoginModal } from './login-ui'

export interface User {
  uid: string
  nickname: string
  avatar: string
}

interface MeResponse {
  user: User | null
  identityLocked?: boolean
}

let user: User | null = null
let identityLocked = Boolean(config.identityLocked)
const changeListeners = new Set<(u: User | null) => void>()
let loginPromise: Promise<User> | null = null
let lastCheck = 0

function setUser(next: User | null) {
  const prev = user
  user = next
  if (prev?.uid !== next?.uid) {
    for (const cb of changeListeners) {
      try {
        cb(next)
      }
      catch (e) {
        console.error(e)
      }
    }
  }
}

async function fetchMe(): Promise<User | null> {
  const res = await rawApi<MeResponse>('/auth/me')
  identityLocked = Boolean(res.identityLocked)
  lastCheck = Date.now()
  return res.user
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

/** App 内原生登录：回调 + 回到前台 + 轮询三路检测，最多等 2 分钟 */
function nativeLogin(): Promise<User> {
  return new Promise<User>((resolve, reject) => {
    let done = false
    let hiddenSeen = false
    const deadline = Date.now() + 120_000
    const finish = (u: User | null, err?: PlatformError) => {
      if (done)
        return
      done = true
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onVisible)
      if (u)
        resolve(u)
      else reject(err ?? new PlatformError('LOGIN_CANCELLED', '已取消登录', 499))
    }
    const check = async () => {
      try {
        const u = await fetchMe()
        if (u) {
          finish(u)
          return true
        }
      }
      catch {}
      return false
    }
    const onVisible = async () => {
      if (document.visibilityState === 'hidden') {
        hiddenSeen = true
        return
      }
      const ok = await check()
      // 原生登录页是独立页面：回到前台仍未登录，视为用户取消
      if (!ok && hiddenSeen)
        setTimeout(async () => { if (!(await check())) finish(null) }, 1500)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onVisible)
    try {
      callNativeLogin(() => { void check() })
    }
    catch (e) {
      finish(null, new PlatformError('LOGIN_CANCELLED', (e as Error).message, 499))
      return
    }
    ;(async () => {
      while (!done && Date.now() < deadline) {
        await sleep(2000)
        if (!done)
          await check()
      }
      finish(null)
    })()
  })
}

async function browserLogin(): Promise<User> {
  await showLoginModal()
  const u = await fetchMe()
  if (!u)
    throw new PlatformError('LOGIN_CANCELLED', '登录状态未生效，请重试', 499)
  return u
}

export function login(): Promise<User> {
  if (user)
    return Promise.resolve(user)
  if (identityLocked)
    return Promise.reject(new PlatformError('LOGIN_CANCELLED', '当前预览身份已在后台锁定，请在预览面板切换身份', 499))
  if (!loginPromise) {
    loginPromise = (container === 'browser' ? browserLogin() : nativeLogin())
      .then((u) => {
        setUser(u)
        return u
      })
      .finally(() => {
        loginPromise = null
      })
  }
  return loginPromise
}

export async function logout() {
  if (config.authProvider === 'mock') {
    await rawApi('/dev/mock-logout', { method: 'POST', body: {} })
    setUser(null)
    return
  }
  if (container === 'browser') {
    if (config.login.loginOrigin)
      location.href = `${config.login.loginOrigin}/user/logout?redirect_to=${encodeURIComponent(location.href)}`
    else
      setUser(null)
    return
  }
  console.warn('[platform] App 内请在 App 设置中退出登录')
}

async function recheck() {
  if (Date.now() - lastCheck < 60_000)
    return
  try {
    const u = await fetchMe()
    if (user && u && u.uid !== user.uid) {
      // 账号切换：强制刷新，避免旧身份的数据与缓存残留
      location.reload()
      return
    }
    setUser(u)
  }
  catch {}
}

let readyPromise: Promise<void> | null = null

export function initAuth(): Promise<void> {
  if (readyPromise)
    return readyPromise
  setLoginHandler(login)
  readyPromise = (async () => {
    try {
      setUser(await fetchMe())
    }
    catch (e) {
      console.warn('[platform] 获取登录状态失败', e)
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible')
        void recheck()
    })
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        lastCheck = 0
        void recheck()
      }
    }, 5 * 60_000)
    if (config.requireLogin && !user)
      await requireLoginGate()
  })()
  return readyPromise
}

async function requireLoginGate() {
  for (;;) {
    try {
      await login()
      return
    }
    catch {
      await showBlocker('登录后才能使用此应用')
    }
  }
}

export const auth = {
  get user() {
    return user
  },
  get isLogin() {
    return Boolean(user)
  },
  login,
  logout,
  onChange(cb: (u: User | null) => void) {
    changeListeners.add(cb)
    return () => changeListeners.delete(cb)
  },
}
