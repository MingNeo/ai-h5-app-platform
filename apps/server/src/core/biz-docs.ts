import { type BizApiEntry, findBizOperation, renderBizApiIndex, rewriteBizPath, specOperations } from '@app-platform/shared'
import { config } from '../config'
import { allowedBizPrefixes, approvedGrants, draftManifest } from './apps'
import { col } from '../lib/mongo'

export interface CatalogEntry {
  prefix: string
  title: string
  description: string
  operations: number
}

export interface BizContext {
  /** manifest 声明且已获批的前缀 */
  granted: string[]
  /** manifest 声明但还没开通的前缀 */
  pending: string[]
  /** manifest 声明了、但平台目录里根本没登记的前缀（写错了，不能调用） */
  unregistered: string[]
  /** 已授权与已声明前缀的接口（含文档）；未开通的也带上，便于先生成/校验代码 */
  entries: BizApiEntry[]
  /** 平台目录里登记的全部服务（不含文档），用于告诉 AI 有哪些能力 */
  catalog: CatalogEntry[]
}

export async function bizEntriesOf(prefixes: string[]): Promise<BizApiEntry[]> {
  if (!prefixes.length)
    return []
  const docs = await col.bizApis.find({ prefix: { $in: prefixes } }).toArray()
  return docs.map(d => ({
    prefix: d.prefix,
    title: d.title,
    description: d.description,
    docs: d.docs,
    spec: d.spec,
    upstream: d.upstream,
    headers: d.headers,
  }))
}

/** 平台目录（所有已登记服务的前缀和名称） */
async function catalogOf(): Promise<CatalogEntry[]> {
  const docs = await col.bizApis.find({}, { projection: { prefix: 1, title: 1, description: 1, spec: 1 } }).sort({ prefix: 1 }).toArray()
  return docs.map(d => ({ prefix: d.prefix, title: d.title, description: d.description, operations: d.spec ? specOperations(d.spec).length : 0 }))
}

/** 当前应用可用的业务接口：已开通前缀 + manifest 已声明前缀的文档（未开通也能读，先生成代码），加上目录清单 */
export async function bizContext(appId: string): Promise<BizContext> {
  const [manifest, grants] = await Promise.all([draftManifest(appId), approvedGrants(appId)])
  const granted = allowedBizPrefixes(manifest.manifest, grants.bizPrefixes)
  const declared = manifest.manifest?.bizApis ?? []
  const pending = declared.filter(p => !granted.some(g => p.startsWith(g)))
  const prefixes = [...new Set([...granted, ...declared])]
  const [entries, catalog] = await Promise.all([bizEntriesOf(prefixes), catalogOf()])
  const unregistered = declared.filter(p => !catalog.some(c => p.startsWith(c.prefix) || c.prefix.startsWith(p)))
  return { granted, pending, unregistered, entries, catalog }
}

/**
 * 校验用的输入：已授予的前缀（授权与 manifest 的交集由 checkWorkspace 按被校验的 manifest 计算），
 * 加上已开通与 manifest 已声明前缀对应的文档（未开通的也要核对路径/参数）。
 */
export async function bizCheckInput(appId: string) {
  const [manifest, grants] = await Promise.all([draftManifest(appId), approvedGrants(appId)])
  const prefixes = [...new Set([...grants.bizPrefixes, ...(manifest.manifest?.bizApis ?? [])])]
  const [entries, catalog] = await Promise.all([bizEntriesOf(prefixes), catalogOf()])
  return { grants: grants.bizPrefixes, entries, catalog: catalog.map(c => c.prefix) }
}

/** 系统提示里的接口索引（只有签名，细节用 read_biz_api 工具按需读取）；未开通前缀也列出来 */
export async function bizApiIndex(appId: string) {
  const { entries, granted } = await bizContext(appId)
  const opened = entries.filter(e => granted.some(g => e.prefix.startsWith(g)))
  const pending = entries.filter(e => !granted.some(g => e.prefix.startsWith(g)))
  const blocks: string[] = []
  if (opened.length)
    blocks.push(renderBizApiIndex(opened))
  if (pending.length) {
    blocks.push(`（以下前缀已在 manifest 声明但还没开通，可以先按文档把代码写好；审批通过前调用会返回 403，需要用户在后台「能力」页申请）\n${renderBizApiIndex(pending)}`)
  }
  return blocks.join('\n\n')
}

/** 系统提示里的未开通前缀与平台目录 */
export async function bizCatalogHint(appId: string) {
  const { pending, unregistered, catalog } = await bizContext(appId)
  const lines: string[] = []
  if (unregistered.length)
    lines.push(`- ⚠️ manifest.bizApis 里的 ${unregistered.join('、')} 在平台目录中不存在，不能调用；请改成目录里已登记的前缀，不要编造路径`)
  const valid = pending.filter(p => !unregistered.includes(p))
  if (valid.length)
    lines.push(`- 已在 manifest 声明但还没开通的前缀：${valid.join('、')}（调用会返回 403，需要用户去后台「能力」页申请）`)
  if (catalog.length)
    lines.push(`- 平台目录里已登记的服务：${catalog.map(c => `${c.title}（${c.prefix}，${c.operations} 个接口）`).join('；')}`)
  return lines.join('\n')
}

/** env:NAME 形式的请求头取值替换成环境变量；变量缺失时跳过，避免把 "env:XXX" 原样发出去 */
export function resolveHeaders(headers?: Record<string, string>) {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (v.startsWith('env:')) {
      const value = process.env[v.slice(4)]
      if (value)
        out[k] = value
      continue
    }
    out[k] = v
  }
  return out
}

export interface BizTarget {
  entry: BizApiEntry
  upstream: string
  headers: Record<string, string>
  /** 实际发给上游的路径（可能经过 x-upstream-path 改写） */
  upstreamPath: string
}

/**
 * 代理前解析目标：先按已授权前缀校验，再按文档找到接口级的上游和请求头覆盖。
 * 前缀已授权但没有登记文档时，只走目录默认上游。
 */
export async function resolveBizTarget(appId: string, method: string, path: string): Promise<{ ok: true, target: BizTarget } | { ok: false, reason: string }> {
  const { granted, entries } = await bizContext(appId)
  if (!granted.some(p => path.startsWith(p)))
    return { ok: false, reason: `业务接口 ${path} 尚未授权，请让用户在后台「能力」页申请` }
  // entries 也含未开通前缀的文档，这里只按已授权的目录转发
  const opened = entries.filter(e => granted.some(g => e.prefix.startsWith(g)))
  const entry = opened.find(e => path.startsWith(e.prefix))
  if (!entry)
    return { ok: false, reason: `业务接口 ${path} 没有登记上游服务` }
  const found = findBizOperation([entry], method, path)
  const upstream = found?.op.upstream ?? entry.upstream ?? config.biz.origin
  if (!upstream)
    return { ok: false, reason: `业务接口 ${path} 没有配置上游地址（请在接口目录或 BIZ_API_ORIGIN 中配置）` }
  return {
    ok: true,
    target: {
      entry,
      upstream,
      headers: { ...resolveHeaders(entry.headers), ...resolveHeaders(found?.op.headers) },
      // 对外路径与上游路径不一致时按文档改写；没配置就原样转发
      upstreamPath: found ? rewriteBizPath(found.op, path) : path,
    },
  }
}
