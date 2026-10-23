// 应用入口。纯 HTML + 原生 ESM，服务端不做任何编译。
// 页面模块返回一个 DOM 节点，这里负责挂到 #app 上。
import { mount } from '/__platform/dom.js'
import { renderHome } from './pages/home.js'

mount('#app', renderHome())
