import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { clearToken, setToken } from './api'
import 'element-plus/dist/index.css'
import 'virtual:uno.css'
import './styles/main.css'
import './styles/element-theme.css'

const ADMIN_BASE = '/admin'

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
  // 先清掉 fragment，再创建 router，避免初始路由读到旧 URL
  const { router } = await import('./router')
  createApp(App)
    .use(createPinia())
    .use(router)
    .use(ElementPlus, { locale: zhCn })
    .mount('#app')
}

void start()
