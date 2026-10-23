// 平台提供的极简 DOM 辅助。应用是纯 HTML + 原生 ESM，服务端不做任何编译。
// 用法：import { el, mount } from '/__platform/dom.js'
// 这里只做创建、挂载、事件绑定和文本转义，不提供响应式；状态变化由应用自己重新渲染。

const LISTENER_RE = /^on([a-z]+)$/i

function append(parent, child) {
  if (child == null || child === false || child === true)
    return
  if (Array.isArray(child)) {
    for (const c of child)
      append(parent, c)
    return
  }
  parent.append(child instanceof Node ? child : document.createTextNode(String(child)))
}

/** el('div', { class: 'p-4', onClick: fn }, ['文本', otherNode]) */
export function el(tag, attrs, children) {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false)
        continue
      const listener = LISTENER_RE.exec(key)
      if (listener) {
        node.addEventListener(listener[1].toLowerCase(), value)
        continue
      }
      if (key === 'style' && typeof value === 'object') {
        Object.assign(node.style, value)
      }
      else if (key === 'class' || key === 'className') {
        node.className = String(value)
      }
      else if (key === 'dataset' && typeof value === 'object') {
        for (const [k, v] of Object.entries(value))
          node.dataset[k] = String(v)
      }
      else if (key in node && key !== 'list' && typeof value !== 'string') {
        node[key] = value
      }
      else {
        node.setAttribute(key, value === true ? '' : String(value))
      }
    }
  }
  append(node, children)
  return node
}

/** 多个节点打包成一个片段，便于 find/addEventListener 之类的一次性操作 */
export function frag(children) {
  const f = document.createDocumentFragment()
  append(f, children)
  return f
}

export function $(selector, root = document) {
  return root.querySelector(selector)
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector))
}

export function clear(node) {
  node.replaceChildren()
  return node
}

/** 用新内容替换容器里的全部节点 */
export function mount(target, children) {
  const node = typeof target === 'string' ? $(target) : target
  if (!node)
    throw new Error(`找不到挂载点：${target}`)
  node.replaceChildren()
  append(node, children)
  return node
}

/** 事件委托：容器上监听一次，命中 selector 的最近祖先再回调 */
export function delegate(root, type, selector, handler) {
  const node = typeof root === 'string' ? $(root) : root
  const listener = (event) => {
    const hit = event.target instanceof Element ? event.target.closest(selector) : null
    if (hit && node.contains(hit))
      handler(event, hit)
  }
  node.addEventListener(type, listener)
  return () => node.removeEventListener(type, listener)
}

/** 文本转义，拼 HTML 字符串时用；优先用 el()/文本节点，天然安全 */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c])
}
