// 应用入口。纯 HTML + 原生 ESM，服务端不做任何编译。
// 页面模块返回一个 DOM 节点，路由负责按路径把布局和页面挂到 #app 上。
import { createRouter } from './router.js'
import { renderLayout } from './layouts/default.js'
import { renderAbout } from './pages/about.js'
import { renderHome } from './pages/home.js'

createRouter({
  routes: [
    {
      // 布局路由：所有页面共用导航和容器
      path: '/',
      layout: renderLayout,
      children: [
        { path: '', component: renderHome },
        { path: 'about', component: renderAbout },
      ],
    },
  ],
}).mount('#app')
