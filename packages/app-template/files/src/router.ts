import { createRouter, createWebHistory } from 'vue-router'
import DefaultLayout from './layouts/DefaultLayout.vue'
import Home from './pages/Home.vue'
import About from './pages/About.vue'

// 应用挂在 /a/{appId}[--channel]/ 下，路由 base 由平台在 boot.js 里注入
const base = (window as unknown as { __APP_CONFIG__?: { base?: string } }).__APP_CONFIG__?.base ?? '/'

export const router = createRouter({
  history: createWebHistory(base),
  routes: [
    {
      // 布局路由：所有页面共用导航和容器
      path: '/',
      component: DefaultLayout,
      children: [
        { path: '', name: 'home', component: Home },
        { path: 'about', name: 'about', component: About },
      ],
    },
  ],
})
