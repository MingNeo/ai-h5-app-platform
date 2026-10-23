import { spawn } from 'node:child_process'
import { scanApp } from '@app-platform/app-guard'
import { BASE_DEPENDENCIES, FORBIDDEN_FILE_RE, OPTIONAL_DEPENDENCIES } from '@app-platform/app-template'
import { type AppManifest, type BizApiEntry, type CheckIssue, checkBizCalls, MANIFEST_FILE, parseManifestText } from '@app-platform/shared'
import { config } from '../config'
import { blobs } from '../lib/blob'
import { TEXT_EXT } from '../lib/mime'
import type { SnapshotFile } from '../lib/mongo'
import { allowedBizPrefixes } from './apps'

export interface BizCheckInput {
  /** 已审批通过的业务接口前缀（与 manifest 中声明的取交集后生效） */
  grants: string[]
  entries: BizApiEntry[]
  /** 平台目录里已登记的全部前缀 */
  catalog: string[]
}

export interface SourceFile {
  path: string
  content: string
}

const MAX_SOURCE_BYTES = 512 * 1024
const SYNTAX_EXT = /\.(?:js|mjs)$/i
const SYNTAX_CONCURRENCY = 6

/** 从快照/草稿的文件清单读出文本源码；二进制和超大文件跳过 */
export async function textSources(files: SnapshotFile[]): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  for (const f of files) {
    if (!TEXT_EXT.test(f.path) || f.size > MAX_SOURCE_BYTES)
      continue
    const buf = await blobs.get(f.hash)
    if (buf)
      out.push({ path: f.path, content: buf.toString('utf8') })
  }
  return out
}

function syntaxIssue(path: string, stderr: string): CheckIssue {
  const line = /\[stdin\]:(\d+)/.exec(stderr)?.[1]
  const message = /(?:SyntaxError|Error):\s*([^\n]+)/.exec(stderr)?.[1] ?? '语法错误'
  return { source: 'syntax', severity: 'error', file: path, line: line ? Number(line) : undefined, message: message.slice(0, 500) }
}

/** 用 node --check 只做语法解析，不执行任何应用代码 */
function checkSyntax(file: SourceFile): Promise<CheckIssue[]> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--check', '-'], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    let done = false
    const finish = (issues: CheckIssue[]) => {
      if (done)
        return
      done = true
      clearTimeout(timer)
      resolve(issues)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish([{ source: 'syntax', severity: 'warning', file: file.path, message: '语法检查超时，已跳过' }])
    }, 5000)
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (e) => finish([{ source: 'syntax', severity: 'warning', file: file.path, message: `语法检查不可用：${e.message}` }]))
    child.on('close', code => finish(code === 0 ? [] : [syntaxIssue(file.path, stderr)]))
    child.stdin?.end(file.content)
  })
}

async function checkSyntaxAll(files: SourceFile[]) {
  const targets = files.filter(f => SYNTAX_EXT.test(f.path))
  const issues: CheckIssue[] = []
  for (let i = 0; i < targets.length; i += SYNTAX_CONCURRENCY) {
    const batch = targets.slice(i, i + SYNTAX_CONCURRENCY)
    issues.push(...(await Promise.all(batch.map(checkSyntax))).flat())
  }
  return issues
}

const PAGE_FILE_RE = /^src\/pages\/.+\.(?:js|mjs)$/

/**
 * 应用显式采用 src/router.js 路由约定时，src/pages/*.js 应被 src/app.js import 并在 routes
 * 里用到；没有采用该约定的应用不做路由检查。这里只做文本层面的静态检查，不执行应用代码。
 */
function checkRoutes(files: SourceFile[]): CheckIssue[] {
  const appFile = files.find(f => f.path === 'src/app.js')
  if (!appFile || !files.some(f => f.path === 'src/router.js'))
    return []
  const issues: CheckIssue[] = []
  for (const page of files.filter(f => PAGE_FILE_RE.test(f.path))) {
    const rel = page.path.slice('src/'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const importRe = new RegExp(`import\\s*(?:\\{([^}]+)\\}|(\\w+))\\s*from\\s*['"]\\.\\.?\\/${rel}['"]`)
    const m = importRe.exec(appFile.content)
    if (!m) {
      issues.push({
        source: 'route',
        severity: 'error',
        file: page.path,
        message: '这个页面没有被 src/app.js import。若应用使用 src/router.js 路由，请在 routes 的 children 里加一条 { path, component }，并在 src/app.js 头部 import 对应的渲染函数。',
      })
      continue
    }
    const names = (m[1] ?? m[2] ?? '').split(',').map(s => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean)
    if (names.length && !names.some(n => new RegExp(`\\b${n}\\b`).test(appFile.content.slice(m.index + m[0].length)))) {
      issues.push({
        source: 'route',
        severity: 'error',
        file: page.path,
        message: 'src/app.js 已经 import 了这个页面，但没在 routes 里用到（没作为 component/layout）。若应用使用 src/router.js 路由，请检查 routes 的 children 配置。',
      })
    }
  }
  return issues
}

export interface CheckResult {
  ok: boolean
  issues: CheckIssue[]
  manifest: AppManifest | null
}

/**
 * 校验应用源码：manifest → 安全扫描 → 业务接口调用 → JS 语法。
 * 不编译、不打包、不执行应用代码；errors 为 0 时 ok=true。
 */
export async function checkSources(files: SourceFile[], opts: { biz?: BizCheckInput } = {}): Promise<CheckResult> {
  const issues: CheckIssue[] = []
  const manifestFile = files.find(f => f.path === MANIFEST_FILE)
  let manifest: AppManifest | null = null
  if (!manifestFile) {
    issues.push({ source: 'manifest', severity: 'error', file: MANIFEST_FILE, message: '缺少 manifest.json' })
  }
  else {
    const parsed = parseManifestText(manifestFile.content)
    if (parsed.ok)
      manifest = parsed.manifest
    else issues.push(...parsed.errors.map(message => ({ source: 'manifest' as const, severity: 'error' as const, file: MANIFEST_FILE, message })))
  }
  if (!files.some(f => f.path === 'index.html'))
    issues.push({ source: 'manifest', severity: 'error', file: 'index.html', message: '缺少 index.html（应用入口页）' })

  issues.push(...checkRoutes(files))

  issues.push(...scanApp(files, {
    baseDependencies: BASE_DEPENDENCIES,
    optionalDependencies: OPTIONAL_DEPENDENCIES,
    declaredDependencies: manifest?.dependencies ?? [],
    forbiddenFileRe: FORBIDDEN_FILE_RE,
    forbiddenPackages: config.guard.forbiddenPackages,
    allowedRedirectHosts: config.guard.allowedRedirectHosts,
  }))

  if (opts.biz) {
    // manifest 声明的业务接口前缀必须在平台目录里登记过，否则是写错了，调用一定失败
    for (const prefix of manifest?.bizApis ?? []) {
      if (!opts.biz.catalog.some(c => prefix.startsWith(c) || c.startsWith(prefix)))
        issues.push({ source: 'biz', severity: 'error', file: MANIFEST_FILE, message: `业务接口前缀 ${prefix} 未在平台目录登记；已登记：${opts.biz.catalog.join('、') || '无'}。请让平台管理员先登记，或改用已登记的前缀。` })
    }
    issues.push(...checkBizCalls(files, {
      granted: allowedBizPrefixes(manifest, opts.biz.grants),
      declared: manifest?.bizApis ?? [],
      entries: opts.biz.entries,
    }))
  }

  issues.push(...await checkSyntaxAll(files))
  return { ok: !issues.some(i => i.severity === 'error'), issues, manifest }
}

export function formatIssues(issues: CheckIssue[], max = 30) {
  return issues.slice(0, max).map((i) => {
    const loc = i.file ? `${i.file}${i.line ? `:${i.line}` : ''} ` : ''
    return `[${i.severity === 'error' ? '错误' : '警告'}][${i.source}] ${loc}${i.message}`
  }).join('\n') + (issues.length > max ? `\n……另有 ${issues.length - max} 条` : '')
}
