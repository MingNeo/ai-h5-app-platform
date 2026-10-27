import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { clearToken, getToken, setToken } from './api'
import 'element-plus/dist/index.css'
import 'virtual:uno.css'
import './styles/main.css'
import './styles/element-theme.css'

const ADMIN_BASE = '/admin'
const RESUME_TRIED = 'adm_login_tried'

/**
 * 飞书回调、恢复 cookie 跳转（/admin-api/auth/resume）都把一次性票据放在 fragment 里
 * （不会发给服务端，也不会进 Referer）。这里立刻换成 Bearer token 并清掉 URL，票据交换一次即作废。
 */
async function consumeLoginTicket() {
  const hash = location.hash.replace(/^#/, '')
  if (!hash)
    return
  const params = new URLSearchParams(hash)
  const ticket = params.get('t')
  if (!ticket)
    return
  const next = params.get('next')
  const target = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  history.replaceState(null, '', `${ADMIN_BASE}${target}`)
  try {
    const res = await fetch('/admin-api/auth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    })
    const json = await res.json().catch(() => null)
    if (res.ok && json?.data?.token) {
      setToken(json.data.token)
      sessionStorage.removeItem('adm_login_tried')
    }
    else
      clearToken()
  }
  catch {
    clearToken()
  }
}

async function start() {
  await consumeLoginTicket()
  // 挂载前先试一次恢复 cookie：成功会直接整页跳走，避免闪一下未登录的登录页
  if (await tryResumeBeforeMount())
    return
  // 先清掉 fragment，再创建 router，避免初始路由读到旧 URL
  const { router } = await import('./router')
  createApp(App)
    .use(createPinia())
    .use(router)
    .use(ElementPlus, { locale: zhCn })
    .mount('#app')
}

/** 去掉 /admin 前缀后的当前路径，登录成功后用它跳回原页面（与 vue-router 的 fullPath 等价） */
function appRelativePath() {
  const { pathname, search } = location
  const path = pathname.startsWith(ADMIN_BASE) ? (pathname.slice(ADMIN_BASE.length) || '/') : pathname
  return `${path.startsWith('/') ? path : `/${path}`}${search}`
}

/**
 * 挂载 Vue 应用前先试一次恢复 cookie：没有内存 token、这个标签页还没试过时，
 * 直接问服务端是否配了飞书且不是本地免登，是就整页跳 /admin-api/auth/resume（成功/失败都由服务端决定下一跳）。
 * 这样失败时才会看到登录页，不会先渲染出登录页再跳走。
 * 返回 true 代表已经触发跳转（页面即将离开，不需要再挂载 Vue）。
 */
async function tryResumeBeforeMount(): Promise<boolean> {
  if (getToken() || sessionStorage.getItem(RESUME_TRIED))
    return false
  let opts: { feishu?: boolean, devBypass?: boolean } | null = null
  try {
    const res = await fetch('/admin-api/auth/options')
    opts = (await res.json().catch(() => null))?.data ?? null
  }
  catch {
    return false
  }
  if (!opts?.feishu || opts.devBypass)
    return false
  sessionStorage.setItem(RESUME_TRIED, '1')
  location.href = `/admin-api/auth/resume?next=${encodeURIComponent(appRelativePath())}`
  return true
}

void start()
