// 平台轻提示与确认框。样式在 /__platform/ui.css。
// 其他交互（抽屉、标签页、下拉）用原生 <dialog> / <details> / <popover> 配合 Tailwind 自己写。
import { el } from './dom.js'

let wrap = null

/** 轻提示，默认 2 秒后自动消失 */
export function toast(message, opts = {}) {
  if (!wrap || !wrap.isConnected) {
    wrap = el('div', { class: 'ui-toast-wrap' })
    document.body.append(wrap)
  }
  const node = el('div', { class: 'ui-toast' }, String(message))
  wrap.append(node)
  requestAnimationFrame(() => node.classList.add('ui-open'))
  const duration = opts.duration ?? 2000
  const close = () => {
    node.classList.remove('ui-open')
    setTimeout(() => node.remove(), 220)
  }
  const timer = setTimeout(close, duration)
  return {
    close() {
      clearTimeout(timer)
      close()
    },
  }
}

/** 确认框，返回 Promise<boolean>；只传字符串时当作正文 */
export function dialog(opts) {
  const o = typeof opts === 'string' ? { content: opts } : (opts ?? {})
  return new Promise((resolve) => {
    let settled = false
    const node = el('dialog', { class: 'ui-dialog' }, [
      o.title ? el('div', { class: 'ui-dialog-title' }, o.title) : null,
      o.content ? el('div', { class: 'ui-dialog-body' }, o.content) : null,
      el('div', { class: 'ui-dialog-actions' }, [
        o.cancelText === null
          ? null
          : el('button', { class: 'ui-dialog-btn', onClick: () => finish(false) }, o.cancelText ?? '取消'),
        el('button', {
          class: `ui-dialog-btn ui-dialog-btn-${o.danger ? 'danger' : 'primary'}`,
          onClick: () => finish(true),
        }, o.confirmText ?? '确定'),
      ]),
    ])
    const finish = (ok) => {
      if (settled)
        return
      settled = true
      node.close()
      resolve(ok)
    }
    // ESC 或浏览器关闭时按取消处理
    node.addEventListener('close', () => finish(false))
    document.body.append(node)
    document.body.classList.add('ui-no-scroll')
    node.showModal()
    node.addEventListener('close', () => {
      node.remove()
      document.body.classList.remove('ui-no-scroll')
    })
  })
}
