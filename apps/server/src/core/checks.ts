import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { scanApp } from '@app-platform/app-guard'
import { BASE_DEPENDENCIES, FORBIDDEN_FILE_RE, OPTIONAL_DEPENDENCIES, TEMPLATE_ROOT } from '@app-platform/app-template'
import { type AppManifest, type BizApiEntry, type CheckIssue, checkBizCalls, MANIFEST_FILE, parseManifestText } from '@app-platform/shared'
import { config } from '../config'
import { TEXT_EXT } from '../lib/mime'
import { allowedBizPrefixes } from './apps'

export interface BizCheckInput {
  /** 已审批通过的业务接口前缀（与 manifest 中声明的取交集后生效） */
  grants: string[]
  entries: BizApiEntry[]
  /** 平台目录里已登记的全部前缀 */
  catalog: string[]
}

const require = createRequire(import.meta.url)
const BUILD_RUNNER = join(TEMPLATE_ROOT, 'platform/build-runner.mjs')
const VUE_TSC = join(require.resolve('vue-tsc/package.json', { paths: [TEMPLATE_ROOT] }), '../bin/vue-tsc.js')

function run(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, NODE_ENV: 'production', FORCE_COLOR: '0' } })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

function readSourceFiles(dir: string) {
  const out: Array<{ path: string, content: string }> = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (d === dir && (name === 'node_modules' || name === '.vite'))
        continue
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory())
        walk(p)
      else {
        const rel = relative(dir, p).split('\\').join('/')
        if (TEXT_EXT.test(rel) && st.size < 1024 * 1024)
          out.push({ path: rel, content: readFileSync(p, 'utf8') })
      }
    }
  }
  walk(dir)
  return out
}

export async function runBuild(root: string, outDir: string, cacheDir: string) {
  const res = await run([BUILD_RUNNER, JSON.stringify({ root, outDir, cacheDir })], root, 180_000)
  const last = res.stdout.trim().split('\n').pop() ?? ''
  try {
    const parsed = JSON.parse(last) as { ok: boolean, errors: Array<{ severity: 'error' | 'warning', message: string, file?: string, line?: number }>, files: Array<{ path: string, size: number }> }
    return {
      ok: parsed.ok,
      files: parsed.files,
      issues: parsed.errors.map(e => ({ source: 'build' as const, ...e })),
    }
  }
  catch {
    return {
      ok: false,
      files: [],
      issues: [{ source: 'build' as const, severity: 'error' as const, message: res.timedOut ? '构建超时' : (res.stderr || res.stdout).slice(-3000) || '构建失败' }],
    }
  }
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/

export async function runTypecheck(root: string): Promise<CheckIssue[]> {
  const res = await run([VUE_TSC, '--noEmit', '-p', 'tsconfig.json'], root, 90_000)
  if (res.timedOut)
    return [{ source: 'typecheck', severity: 'warning', message: '类型检查超时，已跳过' }]
  const issues: CheckIssue[] = []
  const lines = `${res.stdout}\n${res.stderr}`.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = TSC_LINE.exec(lines[i]!.trim())
    if (!m)
      continue
    let message = `${m[5]}: ${m[6]}`
    // 多行错误信息的后续缩进行
    while (lines[i + 1] && /^\s{2,}/.test(lines[i + 1]!) && !TSC_LINE.test(lines[i + 1]!.trim())) {
      message += `\n${lines[++i]!.trim()}`
    }
    issues.push({ source: 'typecheck', severity: 'error', file: m[1]!.replace(/^\.\//, ''), line: Number(m[2]), message: message.slice(0, 1500) })
    if (issues.length >= 30)
      break
  }
  if (!issues.length && res.code !== 0)
    issues.push({ source: 'typecheck', severity: 'error', message: (res.stdout || res.stderr).slice(-2000) || '类型检查失败' })
  return issues
}

export interface CheckResult {
  ok: boolean
  issues: CheckIssue[]
  manifest: AppManifest | null
  buildFiles: Array<{ path: string, size: number }>
}

/**
 * 校验工作区：manifest → 安全扫描 → 业务接口调用 → 类型检查 → 构建。
 * errors 为 0 时 ok=true（警告不阻断）。
 */
export async function checkWorkspace(root: string, opts: { outDir: string, cacheDir: string, typecheck?: boolean, biz?: BizCheckInput }): Promise<CheckResult> {
  const issues: CheckIssue[] = []
  const sources = readSourceFiles(root)
  const manifestFile = sources.find(f => f.path === MANIFEST_FILE)
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
  const generated = ['src/platform.d.ts', 'src/env.d.ts', 'src/biz-api.d.ts', 'tsconfig.json']
  issues.push(...scanApp(sources.filter(f => !generated.includes(f.path)), {
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
    issues.push(...checkBizCalls(sources, {
      granted: allowedBizPrefixes(manifest, opts.biz.grants),
      declared: manifest?.bizApis ?? [],
      entries: opts.biz.entries,
    }))
  }
  const [typeIssues, build] = await Promise.all([
    opts.typecheck === false ? Promise.resolve([]) : runTypecheck(root),
    runBuild(root, opts.outDir, opts.cacheDir),
  ])
  issues.push(...typeIssues, ...build.issues)
  return {
    ok: !issues.some(i => i.severity === 'error'),
    issues,
    manifest,
    buildFiles: build.ok ? build.files : [],
  }
}

export function formatIssues(issues: CheckIssue[], max = 30) {
  return issues.slice(0, max).map((i) => {
    const loc = i.file ? `${i.file}${i.line ? `:${i.line}` : ''} ` : ''
    return `[${i.severity === 'error' ? '错误' : '警告'}][${i.source}] ${loc}${i.message}`
  }).join('\n') + (issues.length > max ? `\n……另有 ${issues.length - max} 条` : '')
}
