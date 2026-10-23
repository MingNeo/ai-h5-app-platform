import { createRouter, createWebHistory } from 'vue-router'
import Home from './pages/Home.vue'

// 应用挂在 /a/{appId}[--channel]/ 下，路由 base 由平台在 boot.js 里注入
const base = (window as unknown as { __APP_CONFIG__?: { base?: string } }).__APP_CONFIG__?.base ?? '/'

export const router = createRouter({
  history: createWebHistory(base),
  routes: [
    { path: '/', component: Home },
  ],
})
