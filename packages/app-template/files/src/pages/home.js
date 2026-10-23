// 首页。用 el() 创建节点，状态变化后重新渲染整块内容。
// 数据通过 window.platform（平台 SDK，由 /__platform/boot.js 注入）访问。
import { el } from '/__platform/dom.js'

export function renderHome() {
  const user = platform.auth.user
  return el('main', { class: 'ui-page ui-stack' }, [
    el('h1', { class: 'text-xl font-bold' }, '新应用'),
    el('p', { class: 'ui-muted' }, '在左侧对话框里描述你想要的页面，或直接编辑文件。'),
    el('div', { class: 'bg-white rounded-xl p-4 flex items-center justify-between' }, [
      el('span', {}, '当前登录'),
      el('span', { class: 'ui-muted' }, user && user.nickname != null ? user.nickname : '未登录'),
    ]),
  ])
}
