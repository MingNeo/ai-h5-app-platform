import { describe, expect, it } from 'vitest'
import type { GuardOptions } from '../index'
import { scanApp } from '../index'

const opts: GuardOptions = {
  baseDependencies: ['vue', 'vant'],
  optionalDependencies: ['phaser'],
  declaredDependencies: [] as string[],
  forbiddenFileRe: /^(?:vite\.config\.|package\.json$)/,
}

function errors(files: Array<{ path: string, content: string }>, o = opts) {
  return scanApp(files, o).filter(i => i.severity === 'error').map(i => i.message)
}

describe('app-guard', () => {
  it.each([
    ['eval', 'eval("1")'],
    ['new Function', 'new Function("return 1")'],
    ['cookie', 'const c = document.cookie'],
    ['原生桥', 'window.webkit.messageHandlers.iOSBridge.postMessage("x")'],
    ['AndroidBridge', 'AndroidBridge.callNative("x")'],
    ['serviceWorker', 'navigator.serviceWorker.register("/sw.js")'],
    ['postMessage *', 'parent.postMessage(data, "*")'],
    ['外部 import', 'import("https://cdn.example.com/x.js")'],
    ['未声明依赖', 'import Phaser from "phaser"'],
    ['非白名单依赖', 'import axios from "axios"'],
    ['node 模块', 'import fs from "node:fs"'],
  ])('拦截 %s', (_name, code) => {
    expect(errors([{ path: 'src/a.ts', content: code }]).length).toBeGreaterThan(0)
  })

  it('拦截配置里的禁用依赖', () => {
    const code = 'import { loginApp } from "native-login"'
    const allowedOpts = { ...opts, baseDependencies: [...opts.baseDependencies, 'native-login'] }
    expect(errors([{ path: 'src/a.ts', content: code }], { ...allowedOpts, forbiddenPackages: ['native-login'] }).length).toBe(1)
    expect(errors([{ path: 'src/a.ts', content: code }], allowedOpts)).toEqual([])
  })

  it('允许正常代码，忽略注释', () => {
    const code = `
      import { ref } from 'vue'
      import { showToast } from 'vant'
      import Card from './Card.vue'
      import util from '@/utils'
      // document.cookie 在注释里不算
      /* eval("x") */
      const s = 'eval is just a word'
      await platform.db.collection('votes').add({ a: 1 })
    `
    expect(errors([{ path: 'src/a.ts', content: code }])).toEqual([])
  })

  it('声明后允许白名单依赖', () => {
    expect(errors([{ path: 'src/g.ts', content: 'import Phaser from "phaser"' }], { ...opts, declaredDependencies: ['phaser'] })).toEqual([])
  })

  it('拦截平台管理的文件和内联脚本', () => {
    expect(errors([{ path: 'vite.config.ts', content: '' }]).length).toBe(1)
    expect(errors([{ path: 'index.html', content: '<script>alert(1)</script>' }]).length).toBe(1)
    expect(errors([{ path: 'index.html', content: '<script src="https://evil.com/x.js"></script>' }]).length).toBeGreaterThan(0)
  })

  it('外部 fetch 给出警告', () => {
    const issues = scanApp([{ path: 'src/a.ts', content: 'fetch("https://api.example.com")' }], opts)
    expect(issues.some(i => i.severity === 'warning')).toBe(true)
  })
})
