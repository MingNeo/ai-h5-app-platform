// 平台轻提示与确认框。样式在 /__platform/ui.css。
// 其他交互（抽屉、标签页、下拉）配合 Tailwind 自己用 div 写；不用原生 <dialog>——旧内核（如 Safari 12）不支持 showModal()。
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
  const duration = opts.duration == null ? 2000 : opts.duration
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

/** 确认框，返回 Promise<boolean>；只传字符串时当作正文。纯 div + CSS 弹层，不依赖原生 <dialog> */
export function dialog(opts) {
  const o = typeof opts === 'string' ? { content: opts } : (opts == null ? {} : opts)
  return new Promise((resolve) => {
    let settled = false
    const mask = el('div', { class: 'ui-dialog-mask' }, [
      el('div', { class: 'ui-dialog' }, [
        o.title ? el('div', { class: 'ui-dialog-title' }, o.title) : null,
        o.content ? el('div', { class: 'ui-dialog-body' }, o.content) : null,
        el('div', { class: 'ui-dialog-actions' }, [
          o.cancelText === null
            ? null
            : el('button', { class: 'ui-dialog-btn', onClick: () => finish(false) }, o.cancelText == null ? '取消' : o.cancelText),
          el('button', {
            class: `ui-dialog-btn ui-dialog-btn-${o.danger ? 'danger' : 'primary'}`,
            onClick: () => finish(true),
          }, o.confirmText == null ? '确定' : o.confirmText),
        ]),
      ]),
    ])
    // ESC 或浏览器返回时按取消处理（原生 dialog 自带这个行为，div 实现需要自己接）
    const onKeydown = (e) => {
      if (e.key === 'Escape')
        finish(false)
    }
    const finish = (ok) => {
      if (settled)
        return
      settled = true
      document.removeEventListener('keydown', onKeydown)
      mask.remove()
      document.body.classList.remove('ui-no-scroll')
      resolve(ok)
    }
    document.addEventListener('keydown', onKeydown)
    document.body.append(mask)
    document.body.classList.add('ui-no-scroll')
  })
}
