// 子路由页面：路径 /about，由布局路由下的 children 渲染。
import { el } from '/__platform/dom.js'
import { href } from '../router.js'

export function renderAbout() {
  return el('section', { class: 'ui-page ui-stack' }, [
    el('h1', { class: 'text-xl font-bold' }, '关于'),
    el('p', { class: 'ui-muted' }, '这是子路由页面：路径 /about，和首页共用同一个布局。'),
    el('a', { class: 'text-blue-600 text-sm', href: href('/') }, '返回首页'),
  ])
}
