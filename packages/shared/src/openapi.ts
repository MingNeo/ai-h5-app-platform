/**
 * 业务接口文档：只使用 OpenAPI 3（3.0 / 3.1）里平台用得到的那一部分，
 * 不另外发明格式。平台据此渲染给 AI 的说明、渲染接口索引、静态校验调用代码。
 *
 * 文档可以是 YAML 或 JSON（YAML 是 JSON 的超集，统一用 yaml 解析）。
 * 支持：paths / 操作对象 / parameters / requestBody / responses / components.schemas / $ref。
 * 其余字段（tags、servers、security 等）原样保留但忽略。
 */
import { parse as parseYaml } from 'yaml'

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
export type HttpMethod = typeof HTTP_METHODS[number]

export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  nullable?: boolean
  default?: unknown
  additionalProperties?: boolean | JsonSchema
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  allOf?: JsonSchema[]
  $ref?: string
  [k: string]: unknown
}

export interface BizParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required: boolean
  description?: string
  schema?: JsonSchema
}

export interface BizOperation {
  method: HttpMethod
  path: string
  summary?: string
  description?: string
  parameters: BizParameter[]
  requestBody?: { description?: string, schema?: JsonSchema }
  responses: Record<string, { description?: string, schema?: JsonSchema }>
  /** 接口级上游地址（OpenAPI 扩展 x-upstream），覆盖目录默认值 */
  upstream?: string
  /** 接口级上游路径（OpenAPI 扩展 x-upstream-path）：对外路径与上游路径不一致时使用 */
  upstreamPath?: string
  /** 接口级附加请求头（x-upstream-headers），值支持 env:变量名 */
  headers?: Record<string, string>
}

export interface BizApiSpec {
  openapi?: string
  info?: { title?: string, version?: string, description?: string }
  paths: Record<string, Record<string, unknown>>
  components?: { schemas?: Record<string, JsonSchema> }
}

export interface BizApiEntry {
  prefix: string
  title: string
  description?: string
  /** 文档之外的补充说明（自由文本） */
  docs?: string
  spec?: BizApiSpec
  /** 目录级默认上游地址，如 http://coupon-service.internal:8080 */
  upstream?: string
  /** 目录级附加请求头（服务令牌等），值支持 env:变量名 */
  headers?: Record<string, string>
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 只保留字符串值、名字合法的请求头 */
function cleanHeaders(input: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && /^[A-Za-z0-9-]+$/.test(k))
      out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** 校验上游地址：只允许 http/https，不允许凭证和片段 */
export function isHttpUrl(u: string) {
  try {
    const url = new URL(u)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash
  }
  catch {
    return false
  }
}

/** 文档文本 → 对象。YAML 与 JSON 都能解析（JSON 是 YAML 的子集），格式不限 */
export function parseOpenApiText(text: string): { ok: true, doc: unknown } | { ok: false, errors: string[] } {
  try {
    return { ok: true, doc: parseYaml(text) }
  }
  catch (e) {
    return { ok: false, errors: [`文档不是合法的 YAML/JSON：${(e as Error).message.split('\n')[0]}`] }
  }
}

/** 校验并保留 OpenAPI 文档。路径必须落在已登记的前缀内，否则作者授权了前缀、
 * 却把别的接口写进文档，AI 会照着调用。
 */
export function normalizeOpenApi(input: unknown, prefix: string): { ok: true, spec: BizApiSpec } | { ok: false, errors: string[] } {
  if (!isObj(input))
    return { ok: false, errors: ['需要提供 OpenAPI 3 文档对象（含 paths）'] }
  if (isObj(input.swagger))
    return { ok: false, errors: ['暂不支持 Swagger 2.0，请提供 OpenAPI 3.x 文档'] }
  if (!isObj(input.paths))
    return { ok: false, errors: ['缺少 paths（OpenAPI 3 要求 paths 为对象）'] }
  const errors: string[] = []
  const entries = Object.entries(input.paths)
  if (!entries.length)
    errors.push('paths 为空，至少登记一个接口')
  for (const [path, item] of entries) {
    if (!path.startsWith('/')) {
      errors.push(`paths.${path}: 路径需以 / 开头`)
      continue
    }
    if (!path.startsWith(prefix))
      errors.push(`paths.${path}: 不在接口前缀 ${prefix} 内`)
    if (!isObj(item)) {
      errors.push(`paths.${path}: 应为对象`)
      continue
    }
    if (!HTTP_METHODS.some(m => isObj(item[m])))
      errors.push(`paths.${path}: 没有 get/post/put/patch/delete 中的任何一个操作`)
    for (const m of HTTP_METHODS) {
      const op = item[m]
      if (op === undefined)
        continue
      if (!isObj(op)) {
        errors.push(`paths.${path}.${m}: 应为对象`)
        continue
      }
      if (op.parameters !== undefined && !Array.isArray(op.parameters))
        errors.push(`paths.${path}.${m}.parameters: 应为数组`)
      if (op.summary !== undefined && typeof op.summary !== 'string')
        errors.push(`paths.${path}.${m}.summary: 应为字符串`)
      if (op.requestBody !== undefined && !isObj(op.requestBody))
        errors.push(`paths.${path}.${m}.requestBody: 应为对象`)
      if (op.responses !== undefined && !isObj(op.responses))
        errors.push(`paths.${path}.${m}.responses: 应为对象`)
      const upstream = op['x-upstream']
      if (upstream !== undefined && (typeof upstream !== 'string' || !isHttpUrl(upstream)))
        errors.push(`paths.${path}.${m}.x-upstream: 需为 http/https 地址，例如 http://coupon-service.internal:8080`)
      const upstreamPath = op['x-upstream-path']
      if (upstreamPath !== undefined) {
        if (typeof upstreamPath !== 'string' || !upstreamPath.startsWith('/'))
          errors.push(`paths.${path}.${m}.x-upstream-path: 需为以 / 开头的上游路径，例如 /api/example/v1/test`)
        else {
          // 上游路径里的 {id} 必须能从对外路径取到，否则转发时无法替换
          const params = new Set(pathParamNames(path))
          for (const name of pathParamNames(upstreamPath)) {
            if (!params.has(name))
              errors.push(`paths.${path}.${m}.x-upstream-path: 参数 {${name}} 不在对外路径中，无法映射`)
          }
        }
      }
      const headers = op['x-upstream-headers']
      if (headers !== undefined && (!isObj(headers) || Object.values(headers).some(v => typeof v !== 'string')))
        errors.push(`paths.${path}.${m}.x-upstream-headers: 应为字符串键值对象，例如 { X-Token: 'env:COUPON_TOKEN' }`)
    }
  }
  if (errors.length)
    return { ok: false, errors }
  return {
    ok: true,
    spec: {
      openapi: typeof input.openapi === 'string' ? input.openapi : undefined,
      info: isObj(input.info) ? input.info as BizApiSpec['info'] : undefined,
      paths: input.paths as BizApiSpec['paths'],
      components: isObj(input.components) ? input.components as BizApiSpec['components'] : undefined,
    },
  }
}

function jsonMedia(node: unknown): JsonSchema | undefined {
  if (!isObj(node) || !isObj(node.content))
    return undefined
  const media = node.content['application/json']
  return isObj(media) && isObj(media.schema) ? media.schema as JsonSchema : undefined
}

/** 展开文档里的全部操作（同路径可以有多个方法） */
export function specOperations(spec: BizApiSpec): BizOperation[] {
  const out: BizOperation[] = []
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!isObj(item))
      continue
    for (const method of HTTP_METHODS) {
      const op = item[method]
      if (!isObj(op))
        continue
      const parameters: BizParameter[] = []
      const raw = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]
      for (const p of raw) {
        if (!isObj(p) || typeof p.name !== 'string' || typeof p.in !== 'string')
          continue
        parameters.push({
          name: p.name,
          in: p.in as BizParameter['in'],
          required: p.required === true || p.in === 'path',
          description: typeof p.description === 'string' ? p.description : undefined,
          schema: isObj(p.schema) ? p.schema as JsonSchema : undefined,
        })
      }
      const responses: BizOperation['responses'] = {}
      if (isObj(op.responses)) {
        for (const [code, r] of Object.entries(op.responses)) {
          if (!isObj(r))
            continue
          responses[code] = {
            description: typeof r.description === 'string' ? r.description : undefined,
            schema: jsonMedia(r),
          }
        }
      }
      const body = isObj(op.requestBody) ? op.requestBody : null
      out.push({
        method,
        path,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        description: typeof op.description === 'string' ? op.description : undefined,
        parameters,
        requestBody: body ? { description: typeof body.description === 'string' ? body.description : undefined, schema: jsonMedia(body) } : undefined,
        responses,
        upstream: typeof op['x-upstream'] === 'string' ? op['x-upstream'] : undefined,
        upstreamPath: typeof op['x-upstream-path'] === 'string' ? op['x-upstream-path'] : undefined,
        headers: isObj(op['x-upstream-headers']) ? cleanHeaders(op['x-upstream-headers']) : undefined,
      })
    }
  }
  return out
}

/** 把文档路径模板（/x/{id}）与实际路径比对 */
export function matchBizPath(template: string, path: string) {
  return pathToRe(template).test(path)
}

function pathParamNames(template: string) {
  return [...template.matchAll(/[{:](\w+)/g)].map(m => m[1]!)
}

/** 从实际路径按模板取路径参数，例如 /api/x/{id} + /api/x/42 → { id: '42' } */
export function extractBizParams(template: string, path: string): Record<string, string> | null {
  const names = pathParamNames(template)
  const re = pathToParamRe(template)
  const m = re.exec(path)
  if (!m)
    return null
  return Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(m[i + 1] ?? '')]))
}

/**
 * 对外路径 → 上游路径。接口声明了 x-upstream-path 时替换成该路径，
 * 并把对外路径里的参数填进去；没声明时原样转发。
 */
export function rewriteBizPath(op: Pick<BizOperation, 'path' | 'upstreamPath'>, path: string) {
  if (!op.upstreamPath)
    return path
  const params = extractBizParams(op.path, path)
  if (!params)
    return op.upstreamPath
  return op.upstreamPath.replace(/\{(\w+)\}/g, (all, name: string) => params[name] !== undefined ? encodeURIComponent(params[name]!) : all)
}

/** 在接口目录里按方法 + 实际路径找操作，未登记时返回 undefined */
export function findBizOperation(entries: BizApiEntry[], method: string, path: string) {
  const m = method.toLowerCase() as HttpMethod
  for (const entry of entries) {
    if (!entry.spec)
      continue
    for (const op of specOperations(entry.spec)) {
      if (op.method === m && matchBizPath(op.path, path))
        return { entry, op }
    }
  }
  return undefined
}

function deref(schema: JsonSchema | undefined, spec: BizApiSpec) {
  let cur = schema
  for (let i = 0; cur?.$ref && i < 5; i++)
    cur = spec.components?.schemas?.[cur.$ref.split('/').pop() ?? '']
  return cur
}

/** 主站统一响应信封 { error_code, error_msg, data } */
export function isErrorEnvelope(schema: JsonSchema | undefined, spec: BizApiSpec) {
  const s = deref(schema, spec)
  return Boolean(s?.properties && 'error_code' in s.properties && 'data' in s.properties)
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/

function propKey(k: string) {
  return IDENT_RE.test(k) ? k : JSON.stringify(k)
}

function literal(v: unknown) {
  return typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'` : JSON.stringify(v)
}

/** JSON Schema → TypeScript 类型文本（给 AI 看的签名、详情里的参数说明） */
export function schemaToTs(schema: JsonSchema | undefined, spec: BizApiSpec, depth = 0, refs: string[] = []): string {
  if (!schema || depth > 6)
    return 'any'
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop() ?? ''
    const target = spec.components?.schemas?.[name]
    if (!target || refs.includes(name))
      return 'any'
    return schemaToTs(target, spec, depth + 1, [...refs, name])
  }
  const union = [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]
  if (union.length)
    return union.map(s => schemaToTs(s, spec, depth + 1, refs)).join(' | ')
  if (schema.allOf?.length)
    return schema.allOf.map(s => schemaToTs(s, spec, depth + 1, refs)).join(' & ')
  if (schema.const !== undefined)
    return literal(schema.const)
  if (schema.enum?.length)
    return schema.enum.map(literal).join(' | ')
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const nullable = types.includes('null') || schema.nullable === true
  const main = types.filter(t => t !== 'null')
  const wrap = (s: string) => nullable ? `${s} | null` : s
  if (main.includes('object') || schema.properties) {
    const props = Object.entries(schema.properties ?? {})
    if (!props.length) {
      const extra = schema.additionalProperties
      return wrap(isObj(extra) ? `Record<string, ${schemaToTs(extra, spec, depth + 1, refs)}>` : 'Record<string, any>')
    }
    const required = new Set(schema.required ?? [])
    const body = props.map(([k, v]) => `${propKey(k)}${required.has(k) ? '' : '?'}: ${schemaToTs(v, spec, depth + 1, refs)}`).join('; ')
    return wrap(`{ ${body} }`)
  }
  if (main.includes('array'))
    return wrap(`${schemaToTs(schema.items, spec, depth + 1, refs)}[]`)
  if (main.length === 1) {
    const m = main[0]!
    const base = m === 'integer' || m === 'number' ? 'number' : m === 'boolean' ? 'boolean' : m === 'null' ? 'null' : 'string'
    return wrap(base)
  }
  return 'any'
}

/** 成功响应（2xx，按文档顺序） */
export function responseType(op: BizOperation) {
  const code = Object.keys(op.responses).find(c => /^2\d\d$/.test(c))
  return code ? op.responses[code] : undefined
}

/** 给 AI 的接口索引：只列签名，详细参数由 read_biz_api 按需加载 */
export function renderBizApiIndex(entries: BizApiEntry[]) {
  const lines: string[] = []
  for (const e of entries) {
    lines.push(`- ${e.title}（${e.prefix}）${e.description ? `：${e.description}` : ''}`)
    const ops = e.spec ? specOperations(e.spec) : []
    if (!ops.length) {
      lines.push('  （未提供 OpenAPI 文档，调用 read_biz_api 查看补充说明）')
      continue
    }
    for (const op of ops)
      lines.push(`  - ${op.method.toUpperCase()} ${op.path}${op.summary ? ` — ${op.summary}` : ''}`)
  }
  return lines.join('\n')
}

/** 单个接口的详细说明（read_biz_api 工具返回） */
export function renderBizApiDetail(entries: BizApiEntry[], filter?: { prefix?: string, path?: string }) {
  const blocks: string[] = []
  for (const e of entries) {
    // 传前缀，或直接传完整路径都可以
    if (filter?.prefix && !e.prefix.startsWith(filter.prefix) && !filter.prefix.startsWith(e.prefix))
      continue
    const header = `# ${e.title}（${e.prefix}）${e.description ? `\n${e.description}` : ''}`
    const ops = (e.spec ? specOperations(e.spec) : []).filter(op => !filter?.path || op.path === filter.path)
    const parts = [header]
    if (e.docs)
      parts.push(e.docs)
    if (!ops.length) {
      if (!e.docs)
        parts.push('（没有可用的接口说明）')
      blocks.push(parts.join('\n\n'))
      continue
    }
    for (const op of ops) {
      const lines = [`## ${op.method.toUpperCase()} ${op.path}${op.summary ? ` — ${op.summary}` : ''}`]
      if (op.description)
        lines.push(op.description)
      if (op.parameters.length) {
        lines.push('参数：')
        for (const p of op.parameters)
          lines.push(`- ${p.name}${p.required ? '' : '?'}（${p.in}）: ${schemaToTs(p.schema, e.spec!)}${p.description ? ` — ${p.description}` : ''}`)
      }
      if (op.requestBody?.schema)
        lines.push(`请求体（application/json）：${schemaToTs(op.requestBody.schema, e.spec!)}`)
      const ok = responseType(op)
      if (ok) {
        lines.push(`返回：${ok.schema ? schemaToTs(ok.schema, e.spec!) : (ok.description ?? '无内容')}`)
        if (ok.schema && isErrorEnvelope(ok.schema, e.spec!))
          lines.push('（这是上游完整信封，不是展开后的业务数据；HTTP 401 或 error_code 非 0 时 SDK 会抛 PlatformError，成功时从 data 取字段）')
      }
      const callPath = op.path.replace(/\{(\w+)\}/g, '${$1}')
      lines.push(`调用：platform.biz.request(\`${callPath}\`${op.method === 'get' ? '' : `, { method: '${op.method.toUpperCase()}' }`})`)
      if (op.upstreamPath && op.upstreamPath !== op.path)
        lines.push(`（平台会把该路径改写到上游 ${op.upstreamPath}，调用时仍用上面的对外路径）`)
      parts.push(lines.join('\n'))
    }
    blocks.push(parts.join('\n\n'))
  }
  return blocks.join('\n\n')
}

/** 文档路径模板（/x/{id}）转匹配正则 */
function pathToRe(template: string) {
  return pathToParamRe(template, false)
}

/** 带捕获组的版本，用于取路径参数 */
function pathToParamRe(template: string, capture = true) {
  const parts = template.split(/(\{\w+\}|:\w+)/)
  const body = parts.map(p => /^[{:]/.test(p) ? (capture ? '([^/]+)' : '[^/]+') : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${body}$`)
}

function lineOf(text: string, index: number) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10)
      line++
  }
  return line
}

/** 从 `(` 之后读到配对的 `)`，按顶层逗号切成参数 */
function splitArgs(src: string, from: number): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = from
  for (let i = from; i < src.length; i++) {
    const c = src[i]!
    if (quote) {
      if (c === '\\')
        i++
      else if (c === quote)
        quote = null
      continue
    }
    if (c === '\'' || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0)
        return [...args, src.slice(start, i)]
      depth--
      continue
    }
    if (c === ',' && depth === 0) {
      args.push(src.slice(start, i))
      start = i + 1
    }
  }
  return [...args, src.slice(start)]
}

/** 取出对象字面量的顶层键；含展开语法时返回 null（不做检查，避免误报） */
function topLevelKeys(objText: string): string[] | null {
  const text = objText.trim()
  if (!text.startsWith('{') || !text.endsWith('}'))
    return null
  if (text.includes('...'))
    return null
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let segStart = 1
  const segments: string[] = []
  for (let i = 1; i < text.length - 1; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\')
        i++
      else if (c === quote)
        quote = null
      continue
    }
    if (c === '\'' || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--
      continue
    }
    if (c === ',' && depth === 0) {
      segments.push(text.slice(segStart, i))
      segStart = i + 1
    }
  }
  segments.push(text.slice(segStart, text.length - 1))
  for (const seg of segments) {
    const m = /^\s*(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*\??\s*:/.exec(seg)
    if (m)
      out.push(m[1] ?? m[2] ?? m[3]!)
  }
  return out
}

function objectAfter(src: string, key: string) {
  const re = new RegExp(`\\b${key}\\s*:\\s*\\{`)
  const m = re.exec(src)
  if (!m)
    return null
  const from = m.index + m[0].length - 1
  let depth = 0
  let quote: string | null = null
  for (let i = from; i < src.length; i++) {
    const c = src[i]!
    if (quote) {
      if (c === '\\')
        i++
      else if (c === quote)
        quote = null
      continue
    }
    if (c === '\'' || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '{') {
      depth++
      continue
    }
    if (c === '}') {
      depth--
      if (depth === 0)
        return src.slice(from, i + 1)
    }
  }
  return null
}

/**
 * 生成应用的 src/biz-api.d.ts：按路径声明响应类型，供平台 SDK 的
 * `platform.biz.request` 推断。由平台维护，应用不能修改。
 */
export function generateBizApiDts(entries: BizApiEntry[]) {
  const results: Record<string, string[]> = {}
  for (const e of entries) {
    if (!e.spec)
      continue
    for (const op of specOperations(e.spec)) {
      const ok = responseType(op)
      if (!ok?.schema)
        continue
      const type = schemaToTs(ok.schema, e.spec)
      const key = op.path
      results[key] ??= []
      if (!results[key]!.includes(type))
        results[key]!.push(type)
    }
  }
  const lines = Object.entries(results).map(([path, types]) => {
    // 路径参数用模板字面量索引签名，调用时传具体 id 也能匹配
    const key = path.includes('{') ? `[k: \`${path.replace(/\{(\w+)\}/g, '${string}')}\`]` : JSON.stringify(path)
    return `${key}: ${types.length === 1 ? types[0] : types.join(' | ')}`
  })
  return `// 由平台根据「业务接口目录」生成，请勿修改（下次生成会覆盖）。
declare global {
  namespace AppPlatform {
    interface BizApiResultEntries {
${lines.map(l => `      ${l}`).join('\n')}
    }
    interface BizApiResults extends BizApiResultEntries {}
  }
}
export {}
`
}

const BIZ_CALL_RE = /platform\s*\.\s*biz\s*\.\s*request\s*(?:<[^<>()]*>)?\s*\(/g
const CODE_EXT = ['.ts', '.js', '.mjs', '.vue', '.tsx', '.jsx']

export interface BizCheckOptions {
  /** 已授权的接口前缀 */
  granted: string[]
  /** manifest 声明但未必已开通的前缀 */
  declared?: string[]
  /** 已登记文档的接口 */
  entries: BizApiEntry[]
}

export interface BizCallIssue {
  source: 'biz'
  severity: 'error' | 'warning'
  file: string
  line: number
  message: string
}

/**
 * 静态校验 platform.biz.request 的字面量调用：前缀是否已授权、路径与方法是否在
 * 已登记的 OpenAPI 文档中、请求参数名是否与文档一致。路径是变量时跳过。
 */
export function checkBizCalls(files: Array<{ path: string, content: string }>, opts: BizCheckOptions): BizCallIssue[] {
  const issues: BizCallIssue[] = []
  const ops = opts.entries.filter(e => e.spec).flatMap(e => specOperations(e.spec!).map(op => ({ op, spec: e.spec! })))
  for (const f of files) {
    if (!CODE_EXT.some(ext => f.path.endsWith(ext)))
      continue
    const re = new RegExp(BIZ_CALL_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(f.content))) {
      const args = splitArgs(f.content, m.index + m[0].length)
      const line = lineOf(f.content, m.index)
      const path = /^(['"])([^'"`$\n]+)\1$/.exec(args[0]?.trim() ?? '')?.[2]
      if (!path || !path.startsWith('/'))
        continue

      const isGranted = opts.granted.some(p => path.startsWith(p))
      const declared = opts.declared?.find(p => path.startsWith(p))
      if (!isGranted && !declared) {
        issues.push({ source: 'biz', severity: 'error', file: f.path, line, message: `业务接口 ${path} 尚未授权，已授权前缀：${opts.granted.join('、') || '无'}。需要用户去后台「能力」页申请。` })
        continue
      }
      if (!isGranted) {
        issues.push({ source: 'biz', severity: 'warning', file: f.path, line, message: `业务接口 ${path} 尚未开通（前缀 ${declared} 已在 manifest 声明，等后台审批）。申请通过后才能调用，请提醒用户去「能力」页申请。` })
        // 未开通也继续核对路径、方法和参数，避免审批通过后才发现代码写错
      }

      const matched = ops.filter(x => pathToRe(x.op.path).test(path))
      if (!matched.length) {
        const known = opts.entries.filter(e => path.startsWith(e.prefix)).flatMap(e => Object.keys(e.spec?.paths ?? {}))
        if (known.length)
          issues.push({ source: 'biz', severity: 'warning', file: f.path, line, message: `业务接口 ${path} 不在已登记的文档中，已登记：${known.slice(0, 8).join('、')}` })
        else
          issues.push({ source: 'biz', severity: 'warning', file: f.path, line, message: `业务接口 ${path} 没有可核对的文档，请让平台管理员补充登记` })
        continue
      }

      const options = args[1] ?? ''
      const method = (/\bmethod\s*:\s*['"`](\w+)['"`]/.exec(options)?.[1]?.toLowerCase() ?? 'get')
      const hit = matched.find(x => x.op.method === method)
      if (!hit) {
        issues.push({ source: 'biz', severity: 'warning', file: f.path, line, message: `业务接口 ${path} 只登记了 ${[...new Set(matched.map(x => x.op.method.toUpperCase()))].join('、')}，当前使用 ${method.toUpperCase()}` })
        continue
      }
      const { op, spec } = hit
      const expected = new Set(op.parameters.filter(p => p.in === 'query').map(p => p.name))
      for (const k of Object.keys(deref(op.requestBody?.schema, spec)?.properties ?? {}))
        expected.add(k)
      // GET 的 data 会被 SDK 合并进 query，其余方法的 data 是 JSON body
      for (const [text, label] of [[objectAfter(options, 'query'), 'query'], [objectAfter(options, 'data'), method === 'get' ? 'data（GET 会作为 query）' : 'data']] as const) {
        if (!text)
          continue
        for (const k of topLevelKeys(text) ?? []) {
          if (!expected.has(k))
            issues.push({ source: 'biz', severity: 'warning', file: f.path, line, message: `${method.toUpperCase()} ${op.path} 没有参数 ${k}（${label}）；文档中的参数：${[...expected].join('、') || '无'}` })
        }
      }
    }
  }
  return issues
}