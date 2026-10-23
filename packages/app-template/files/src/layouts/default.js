// 布局：上方渲染子路由，下方是公共导航。
import { el } from '/__platform/dom.js'
import { href } from '../router.js'

function link(path, text) {
  return el('a', { class: 'flex-1 py-3 text-center text-sm text-gray-600', href: href(path) }, text)
}

export function renderLayout(child) {
  return el('div', { class: 'min-h-screen flex flex-col bg-gray-50' }, [
    el('main', { class: 'flex-1' }, child()),
    el('nav', { class: 'sticky bottom-0 flex border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]' }, [
      link('/', '首页'),
      link('/about', '关于'),
    ]),
  ])
}
