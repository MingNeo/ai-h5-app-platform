// 应用内客户端路由：纯原生 ESM，支持嵌套（子）路由。
// 应用挂在 /a/{appId}[--channel]/ 下，路径前缀由平台在 boot.js 里提供。
import { el } from '/__platform/dom.js'

let appBase = ''

/** 应用内路径 → 浏览器路径，用于 <a href> */
export function href(path) {
  const p = path.startsWith('/') ? path : `/${path}`
  if (p === '/')
    return `${appBase}/` || '/'
  return `${appBase}${p}`
}

function joinPath(parent, path) {
  if (path.startsWith('/'))
    return path
  const joined = `${parent}/${path}`.replace(/\/{2,}/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/'
}

/**
 * 路由项：
 *   { path?, layout?, component?, children? }
 * - layout 可以再渲染一层子页面：layout(child)
 * - component 是页面；叶子页面忽略 child 参数
 * - 子路由的 path 不要以 / 开头，'' 表示父级自身
 */
export function createRouter({ routes }) {
  const rawBase = window.__APP_CONFIG__?.base ?? '/'
  appBase = rawBase === '/' ? '' : rawBase.replace(/\/$/, '')

  // 拍平成 { path, chain }，chain 从最外层布局到最内层页面
  const table = []
  function walk(list, parent, chain) {
    for (const route of list) {
      const path = joinPath(parent, route.path ?? '')
      const next = route.layout ? [...chain, route.layout] : chain
      if (route.component)
        table.push({ path, chain: [...next, route.component] })
      if (route.children)
        walk(route.children, path, next)
    }
  }
  walk(routes, '/', [])

  const outlet = el('div', { class: 'app-root' })
  const notFound = () => el('div', { class: 'ui-page ui-empty' }, '页面不存在')

  function currentPath() {
    if (!appBase)
      return location.pathname
    return location.pathname.startsWith(appBase)
      ? (location.pathname.slice(appBase.length) || '/')
      : '/'
  }

  function render() {
    const route = table.find(r => r.path === currentPath())
    let child = notFound
    if (route) {
      child = notFound
      for (let i = route.chain.length - 1; i >= 0; i--) {
        const component = route.chain[i]
        const next = child
        child = () => component(next)
      }
    }
    outlet.replaceChildren(child())
  }

  function navigate(path, { replace = false } = {}) {
    const target = href(path)
    if (target === `${location.pathname}${location.search}`)
      return
    if (replace)
      history.replaceState({}, '', target)
    else
      history.pushState({}, '', target)
    render()
    window.scrollTo(0, 0)
  }

  function onClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return
    const a = e.target.closest?.('a[href]')
    if (!a || a.target || a.hasAttribute('download') || a.dataset.external !== undefined)
      return
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin || url.search || url.hash)
      return
    if (appBase && !url.pathname.startsWith(appBase))
      return
    e.preventDefault()
    navigate(url.pathname.slice(appBase.length) || '/')
  }

  function mount(selector = '#app') {
    const root = document.querySelector(selector)
    if (!root)
      throw new Error(`找不到挂载节点 ${selector}`)
    root.replaceChildren(outlet)
    document.addEventListener('click', onClick)
    window.addEventListener('popstate', render)
    render()
  }

  return { mount, navigate, render, currentPath }
}
