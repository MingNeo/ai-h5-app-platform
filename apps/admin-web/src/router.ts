import { createRouter, createWebHistory } from 'vue-router'
import { setUnauthorizedHandler } from './api'
import { useUserStore } from './stores/user'

export const router = createRouter({
  // 后台挂在同一个域名下的 /admin，构建时 base 为 /admin/
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/login', component: () => import('./pages/Login.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('./layouts/MainLayout.vue'),
      children: [
        { path: '', component: () => import('./pages/Apps.vue') },
        { path: 'admin/users', component: () => import('./pages/admin/Users.vue'), meta: { platformAdmin: true } },
        { path: 'admin/grants', component: () => import('./pages/admin/Grants.vue'), meta: { platformAdmin: true } },
        { path: 'admin/biz-apis', component: () => import('./pages/admin/BizApis.vue'), meta: { platformAdmin: true } },
        { path: 'admin/audit', component: () => import('./pages/admin/Audit.vue'), meta: { platformAdmin: true } },
        { path: 'admin/api-clients', component: () => import('./pages/admin/ApiClients.vue'), meta: { platformAdmin: true } },
      ],
    },
    {
      path: '/apps/:appId',
      component: () => import('./layouts/AppLayout.vue'),
      props: true,
      children: [
        { path: '', redirect: to => `/apps/${to.params.appId}/develop` },
        { path: 'develop', component: () => import('./pages/app/Develop.vue') },
        { path: 'release', component: () => import('./pages/app/Release.vue') },
        { path: 'data', component: () => import('./pages/app/Data.vue') },
        { path: 'console', component: () => import('./pages/app/Console.vue') },
        { path: 'grants', component: () => import('./pages/app/Grants.vue') },
        { path: 'monitor', component: () => import('./pages/app/Monitor.vue') },
        { path: 'members', component: () => import('./pages/app/Members.vue') },
        { path: 'settings', component: () => import('./pages/app/Settings.vue') },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  const user = useUserStore()
  if (!user.loaded)
    await user.load()
  if (to.meta.public)
    return true
  if (!user.me)
    return { path: '/login', query: { redirect: to.fullPath } }
  if (to.meta.platformAdmin && !user.me.isPlatformAdmin)
    return '/'
  return true
})

setUnauthorizedHandler(() => {
  const user = useUserStore()
  user.me = null
  if (router.currentRoute.value.path !== '/login')
    void router.push({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
})
