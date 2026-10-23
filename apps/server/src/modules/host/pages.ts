const TEXT: Record<string, { title: string, desc: string }> = {
  not_found: { title: '应用不存在', desc: '请检查链接是否正确' },
  not_published: { title: '应用尚未发布', desc: '敬请期待' },
  offline: { title: '应用已下线', desc: '感谢你的关注' },
  not_started: { title: '活动未开始', desc: '请在活动开始后再来' },
  ended: { title: '活动已结束', desc: '感谢你的参与' },
  preview_forbidden: { title: '需要预览权限', desc: '请从后台打开预览，或重新扫描后台的预览二维码' },
}

export function placeholderPage(kind: keyof typeof TEXT, extra = '') {
  const t = TEXT[kind]!
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title><style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,'PingFang SC',sans-serif;color:#1f2329;background:#f7f8fa}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#8f959e;font-size:14px}</style></head>
<body><h1>${t.title}</h1><p>${t.desc}</p>${extra}</body></html>`
}
