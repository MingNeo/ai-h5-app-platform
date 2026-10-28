import { describe, expect, it } from 'vitest'
import { injectPlatformHead } from './app-host'

const page = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`

describe('注入平台启动配置', () => {
  it('没有 boot.js 时注入平台标签', () => {
    const html = injectPlatformHead(page('<title>x</title>'), 'demo-app', 'prod')
    expect(html).toContain('/__platform/boot.js?app=demo-app&amp;channel=prod')
    expect(html).toContain('/__platform/ui.css')
  })

  it('应用自己写的 boot.js 补上应用与渠道', () => {
    const html = injectPlatformHead(page('<script src="/__platform/boot.js"></script>'), 'demo-app', 'beta')
    expect(html).toContain('/__platform/boot.js?app=demo-app&amp;channel=beta')
  })

  it('应用写死的查询参数被服务端渠道覆盖', () => {
    const html = injectPlatformHead(page('<script src="/__platform/boot.js?v=3&channel=dev"></script>'), 'demo-app', 'prod')
    expect(html).toContain('/__platform/boot.js?app=demo-app&amp;channel=prod')
    expect(html).not.toContain('channel=dev')
    expect(html).not.toContain('v=3')
  })

  it('单引号与绝对地址也能重写', () => {
    const html = injectPlatformHead(page(`<script src='https://example.test/__platform/boot.js?channel=dev'></script>`), 'demo-app', 'prod')
    expect(html).toContain(`src='/__platform/boot.js?app=demo-app&amp;channel=prod'`)
  })

  it('只在文本里提到 boot.js 时不误判为已引用', () => {
    const html = injectPlatformHead(page('<script>console.log("/__platform/boot.js")</script>'), 'demo-app', 'prod')
    expect(html).toContain(`<script src="/__platform/boot.js?app=demo-app&amp;channel=prod"></script>`)
  })
})
