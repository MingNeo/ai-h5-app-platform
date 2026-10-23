// 应用入口。纯 HTML + 原生 ESM，服务端不做任何编译。
// 页面模块返回 DOM 节点；应用可按需求自行组织页面与导航。
import { mount } from '/__platform/dom.js'
import { renderHome } from './pages/home.js'

mount('#app', renderHome())
