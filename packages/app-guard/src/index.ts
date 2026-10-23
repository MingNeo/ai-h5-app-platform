import type { CheckIssue } from '@app-platform/shared'

export interface GuardFile {
  path: string
  content: string
}

export interface GuardOptions {
  /** 始终允许的依赖 */
  baseDependencies: string[]
  /** 白名单内、需在 manifest.dependencies 声明的依赖 */
  optionalDependencies: string[]
  /** manifest.dependencies */
  declaredDependencies: string[]
  /** 禁止出现的文件 */
  forbiddenFileRe: RegExp
  /** 禁止使用的依赖（精确包名） */
  forbiddenPackages?: string[]
  /** 允许整页跳转的主机（含子域），不配置时任何外部跳转都告警 */
  allowedRedirectHosts?: string[]
}

interface Rule {
  re: RegExp
  severity: 'error' | 'warning'
  message: string
  /** 只对这些扩展名生效 */
  ext?: string[]
}

const CODE_EXT = ['.ts', '.js', '.mjs', '.vue', '.tsx', '.jsx']

/** 常见前端框架/UI 库：平台不支持，给出明确提示而不是“不在白名单” */
const FRAMEWORK_PACKAGES = new Set(['vue', 'vue-router', 'pinia', 'vant', '@vueuse/core', 'react', 'react-dom', 'preact', 'lit', 'svelte', 'element-plus', 'ant-design-vue'])

const RULES: Rule[] = [
  { re: /\beval\s*\(/, severity: 'error', message: '禁止使用 eval' },
  { re: /\bnew\s+Function\s*\(/, severity: 'error', message: '禁止使用 new Function' },
  { re: /\bset(?:Timeout|Interval)\s*\(\s*['"`]/, severity: 'error', message: 'setTimeout/setInterval 不能传字符串代码' },
  { re: /\bdocument\s*\.\s*cookie\b/, severity: 'error', message: '禁止读写 document.cookie（应用与主站共享基础域名下的 cookie）' },
  { re: /\b(?:AndroidBridge|_handleNativeMessage|_handleCallNativeCallback|callNative|sendNative)\b|\bmessageHandlers\b/, severity: 'error', message: '禁止直接调用 App 原生桥，请使用 platform SDK' },
  { re: /\bserviceWorker\s*\.\s*register\b/, severity: 'error', message: '禁止注册 Service Worker（会导致版本回滚失效）' },
  { re: /\bpostMessage\s*\([^)]*,\s*['"]\*['"]\s*\)/, severity: 'error', message: 'postMessage 不能使用 "*" 作为 targetOrigin' },
  { re: /\bimport\s*\(\s*['"`]https?:/, severity: 'error', message: '禁止动态加载外部脚本' },
  { re: /<script[^>]+src\s*=\s*["']?(?:https?:)?\/\//i, severity: 'error', message: '禁止引用外部脚本', ext: ['.html', '.vue'] },
  { re: /\bsk-[A-Za-z0-9]{20,}\b|\bAKID[A-Za-z0-9]{13,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/, severity: 'error', message: '代码中疑似包含密钥' },
  { re: /\b(?:fetch|axios(?:\s*\.\s*\w+)?|new\s+WebSocket|new\s+EventSource)\s*\(\s*['"`]https?:/, severity: 'warning', message: '外部请求会被 CSP 拦截；业务接口请使用 platform.biz.request' },
  { re: /\bXMLHttpRequest\b/, severity: 'warning', message: '请使用 platform SDK 访问数据，不要直接使用 XMLHttpRequest' },
  { re: /\bv-html\s*=/, severity: 'warning', message: 'v-html 有 XSS 风险，展示用户内容时请使用文本插值', ext: ['.vue'] },
]

function extOf(path: string) {
  const i = path.lastIndexOf('.')
  return i >= 0 ? path.slice(i).toLowerCase() : ''
}

/** 去掉注释但保留换行，便于定位行号 */
function stripComments(code: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < code.length) {
    const c = code[i]!
    const n = code[i + 1]
    if (quote) {
      out += c
      if (c === '\\') {
        out += n ?? ''
        i += 2
        continue
      }
      if (c === quote)
        quote = null
      i++
      continue
    }
    if (c === '"' || c === '\'' || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n')
          out += '\n'
        i++
      }
      i += 2
      continue
    }
    if (c === '<' && code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4)
      const chunk = code.slice(i, end < 0 ? code.length : end + 3)
      out += chunk.replace(/[^\n]/g, '')
      i += chunk.length
      continue
    }
    out += c
    i++
  }
  return out
}

function lineOf(text: string, index: number) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10)
      line++
  }
  return line
}

const IMPORT_RES = [
  /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function packageName(spec: string) {
  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/')
    return name ? `${scope}/${name}` : spec
  }
  return spec.split('/')[0]!
}

export function scanApp(files: GuardFile[], opts: GuardOptions): CheckIssue[] {
  const issues: CheckIssue[] = []
  const allowed = new Set([...opts.baseDependencies, ...opts.declaredDependencies.filter(d => opts.optionalDependencies.includes(d))])
  const forbiddenPackages = new Set(opts.forbiddenPackages ?? [])
  const allowedRedirectHosts = opts.allowedRedirectHosts ?? []
  for (const d of opts.declaredDependencies) {
    if (!opts.optionalDependencies.includes(d) && !opts.baseDependencies.includes(d))
      issues.push({ source: 'guard', severity: 'error', file: 'manifest.json', message: `依赖 ${d} 不在平台白名单内（可选：${opts.optionalDependencies.join('、')}）` })
  }

  for (const f of files) {
    if (opts.forbiddenFileRe.test(f.path)) {
      issues.push({ source: 'guard', severity: 'error', file: f.path, message: '该文件由平台统一管理，应用内不允许存在' })
      continue
    }
    const ext = extOf(f.path)
    if (ext === '.vue') {
      issues.push({ source: 'guard', severity: 'error', file: f.path, message: '平台不支持 .vue 文件：应用是纯 HTML + 原生 JS 模块，没有编译步骤' })
      continue
    }
    if (!CODE_EXT.includes(ext) && ext !== '.html')
      continue
    const code = stripComments(f.content)
    for (const rule of RULES) {
      if (rule.ext ? !rule.ext.includes(ext) : !CODE_EXT.includes(ext) && ext !== '.html')
        continue
      const re = new RegExp(rule.re.source, `${rule.re.flags.replace('g', '')}g`)
      let m: RegExpExecArray | null
      let hits = 0
      while ((m = re.exec(code)) && hits < 3) {
        hits++
        issues.push({ source: 'guard', severity: rule.severity, file: f.path, line: lineOf(code, m.index), message: rule.message })
      }
    }
    if (ext === '.html' && /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(code))
      issues.push({ source: 'guard', severity: 'error', file: f.path, message: '禁止内联 <script>（会被 CSP 拦截），请把代码放到 src/ 下' })

    if (CODE_EXT.includes(ext)) {
      for (const importRe of IMPORT_RES) {
        const re = new RegExp(importRe.source, 'g')
        let m: RegExpExecArray | null
        while ((m = re.exec(code))) {
          const spec = m[1]!
          if (spec.startsWith('.')) {
            // 浏览器原生 ESM 不做扩展名补全，相对导入必须写全路径
            if (!/\.[a-z0-9]+$/i.test(spec))
              issues.push({ source: 'guard', severity: 'error', file: f.path, line: lineOf(code, m.index), message: `相对导入必须带扩展名：${spec} → ${spec}.js` })
            continue
          }
          if (spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('virtual:'))
            continue
          if (/^(?:https?:)?\/\//.test(spec)) {
            issues.push({ source: 'guard', severity: 'error', file: f.path, line: lineOf(code, m.index), message: `禁止从外部地址导入：${spec}` })
            continue
          }
          if (spec.startsWith('node:')) {
            issues.push({ source: 'guard', severity: 'error', file: f.path, line: lineOf(code, m.index), message: `浏览器端不能使用 Node 内置模块：${spec}` })
            continue
          }
          const pkg = packageName(spec)
          if (forbiddenPackages.has(pkg)) {
            issues.push({ source: 'guard', severity: 'error', file: f.path, line: lineOf(code, m.index), message: `禁止使用 ${pkg}，登录等能力请使用 platform SDK` })
            continue
          }
          if (!allowed.has(pkg)) {
            const hint = FRAMEWORK_PACKAGES.has(pkg)
              ? `平台不支持 ${pkg}：应用是纯 HTML + 原生 JS，没有编译和打包；组件用 sl-* 或自己写，工具函数用 /__platform/dom.js`
              : `依赖 ${pkg} 不在平台白名单内`
            issues.push({ source: 'guard', severity: 'error', file: f.path, line: lineOf(code, m.index), message: hint })
          }
        }
      }
    }

    // 整页跳转到外部站点
    if (CODE_EXT.includes(ext) || ext === '.html') {
      const redirectRe = /\blocation(?:\s*\.\s*href)?\s*=\s*['"`](https?:\/\/[^'"`\s]+)/g
      let m: RegExpExecArray | null
      let hits = 0
      while ((m = redirectRe.exec(code)) && hits < 3) {
        let host = ''
        try {
          host = new URL(m[1]!).hostname.toLowerCase()
        }
        catch {
          continue
        }
        const allowedHost = allowedRedirectHosts.some(h => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))
        if (!allowedHost) {
          hits++
          issues.push({ source: 'guard', severity: 'warning', file: f.path, line: lineOf(code, m.index), message: `跳转到外部站点 ${host}，请确认是否必要` })
        }
      }
    }
  }

  // 自建登录表单（钓鱼风险）
  const all = files.filter(f => CODE_EXT.includes(extOf(f.path))).map(f => f.content).join('\n')
  if (/验证码/.test(all) && /手机号/.test(all) && /type=["']password["']|短信/.test(all) && !/platform\.auth\.login/.test(all)) {
    issues.push({ source: 'guard', severity: 'warning', message: '疑似自建登录表单；登录请统一使用 platform.auth.login()' })
  }
  return issues
}
