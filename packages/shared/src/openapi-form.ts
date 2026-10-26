/**
 * 「逐条添加接口」表单 ⇄ OpenAPI 文档互转。只覆盖基础类型字段（string / integer /
 * number / boolean 的参数、请求体顶层字段、2xx 响应顶层字段）；复杂结构
 * （$ref、嵌套对象、数组、oneOf 等）保持只读，必须去 YAML 里编辑。
 *
 * 写回时尽量少动文档：YAML 用 Document API 按路径增删，只有被编辑的那条
 * operation 会重新格式化，其余内容（注释、components、别的接口）原样保留；
 * JSON 文档按普通对象合并。
 */
import { Document, parseDocument } from 'yaml'
import { HTTP_METHODS, type HttpMethod, isObj, type JsonSchema, jsonMedia } from './openapi'

export interface OpFormField {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean'
  required: boolean
  description?: string
}

export interface OpFormParam extends OpFormField {
  in: 'query' | 'path' | 'header'
}

export interface OpFormHeader {
  name: string
  /** 固定值 / env:变量名 / secret:密钥名 */
  value: string
}

export interface BizOpForm {
  method: HttpMethod
  path: string
  summary: string
  description: string
  params: OpFormParam[]
  body: OpFormField[]
  response: OpFormField[]
  upstream: string
  upstreamPath: string
  headers: OpFormHeader[]
}

export interface OpFormFlags {
  paramsEditable: boolean
  bodyEditable: boolean
  responseEditable: boolean
}

export function emptyOpForm(path = ''): BizOpForm {
  return { method: 'get', path, summary: '', description: '', params: [], body: [], response: [], upstream: '', upstreamPath: '', headers: [] }
}

const BASIC_TYPES = new Set(['string', 'integer', 'number', 'boolean'])

function schemaType(schema?: JsonSchema): OpFormField['type'] {
  const t = Array.isArray(schema?.type) ? schema!.type[0] : schema?.type
  return t && BASIC_TYPES.has(t) ? t as OpFormField['type'] : 'string'
}

/** 基础标量：没有 $ref / enum / oneOf 等，类型是四种基础类型之一（或留空） */
function isBasicType(schema?: JsonSchema): boolean {
  if (!schema)
    return true
  if (schema.$ref || schema.enum || schema.oneOf || schema.anyOf || schema.allOf || schema.const !== undefined || schema.items || schema.properties)
    return false
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type
  return t === undefined || BASIC_TYPES.has(t)
}

/** 顶层字段全是基础标量的 object schema（或留空），才能用字段表格编辑 */
function isBasicObjectSchema(schema?: JsonSchema): boolean {
  if (!schema)
    return true
  if (schema.$ref || schema.oneOf || schema.anyOf || schema.allOf || schema.additionalProperties)
    return false
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type
  if (t && t !== 'object')
    return false
  return Object.values(schema.properties ?? {}).every(isBasicType)
}

function fieldsFromObjectSchema(schema?: JsonSchema): OpFormField[] {
  if (!schema?.properties)
    return []
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties).map(([name, s]) => ({ name, type: schemaType(s), required: required.has(name), description: s.description }))
}

function objectSchemaFromFields(fields: OpFormField[]): JsonSchema | undefined {
  const valid = fields.filter(f => f.name.trim())
  if (!valid.length)
    return undefined
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const f of valid) {
    const name = f.name.trim()
    properties[name] = { type: f.type, ...(f.description ? { description: f.description } : {}) }
    if (f.required)
      required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/**
 * 原始 operation 对象 → 表单。pathItemHasParams 为 true（路径级共享了
 * parameters）时参数整体标记为不可编辑，避免表单只写 operation 级参数导致和
 * 路径级参数重复。
 */
export function opToForm(method: HttpMethod, path: string, rawOp: Record<string, unknown> | undefined, pathItemHasParams: boolean): { form: BizOpForm, flags: OpFormFlags } {
  const op = rawOp ?? {}
  const rawParams = Array.isArray(op.parameters) ? op.parameters as Record<string, unknown>[] : []
  const paramsEditable = !pathItemHasParams && rawParams.every(p => isObj(p) && isBasicType(p.schema as JsonSchema | undefined))
  const params: OpFormParam[] = paramsEditable
    ? rawParams.map(p => ({
        name: String(p.name ?? ''),
        in: (p.in === 'path' || p.in === 'header') ? p.in : 'query',
        type: schemaType(p.schema as JsonSchema | undefined),
        required: p.in === 'path' ? true : Boolean(p.required),
        description: typeof p.description === 'string' ? p.description : undefined,
      }))
    : []

  const bodySchema = isObj(op.requestBody) ? jsonMedia(op.requestBody) : undefined
  const bodyEditable = isBasicObjectSchema(bodySchema)
  const body = bodyEditable ? fieldsFromObjectSchema(bodySchema) : []

  const responses = isObj(op.responses) ? op.responses as Record<string, unknown> : {}
  const ok200 = isObj(responses['200']) ? responses['200'] as Record<string, unknown> : undefined
  const responseSchema = ok200 ? jsonMedia(ok200) : undefined
  const responseEditable = isBasicObjectSchema(responseSchema)
  const response = responseEditable ? fieldsFromObjectSchema(responseSchema) : []

  const rawHeaders = isObj(op['x-upstream-headers']) ? op['x-upstream-headers'] as Record<string, string> : {}

  return {
    form: {
      method,
      path,
      summary: typeof op.summary === 'string' ? op.summary : '',
      description: typeof op.description === 'string' ? op.description : '',
      params,
      body,
      response,
      upstream: typeof op['x-upstream'] === 'string' ? op['x-upstream'] : '',
      upstreamPath: typeof op['x-upstream-path'] === 'string' ? op['x-upstream-path'] : '',
      headers: Object.entries(rawHeaders).map(([name, value]) => ({ name, value })),
    },
    flags: { paramsEditable, bodyEditable, responseEditable },
  }
}

function setOrDelete(obj: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined || value === null || (Array.isArray(value) && !value.length))
    delete obj[key]
  else obj[key] = value
}

function buildParameters(params: OpFormParam[]) {
  return params.filter(p => p.name.trim()).map(p => ({
    name: p.name.trim(),
    in: p.in,
    required: p.in === 'path' ? true : p.required,
    ...(p.description ? { description: p.description } : {}),
    schema: { type: p.type },
  }))
}

function applyFormToOp(existing: Record<string, unknown> | undefined, form: BizOpForm, flags: OpFormFlags): Record<string, unknown> {
  const op: Record<string, unknown> = { ...(existing ?? {}) }
  setOrDelete(op, 'summary', form.summary.trim() || undefined)
  setOrDelete(op, 'description', form.description.trim() || undefined)

  if (flags.paramsEditable)
    setOrDelete(op, 'parameters', buildParameters(form.params))

  if (flags.bodyEditable) {
    const schema = objectSchemaFromFields(form.body)
    setOrDelete(op, 'requestBody', schema ? { content: { 'application/json': { schema } } } : undefined)
  }

  if (flags.responseEditable) {
    const responses = isObj(op.responses) ? { ...(op.responses as Record<string, unknown>) } : {}
    const schema = objectSchemaFromFields(form.response)
    if (schema) {
      const prev = isObj(responses['200']) ? responses['200'] as Record<string, unknown> : undefined
      responses['200'] = { description: typeof prev?.description === 'string' ? prev.description : '成功', content: { 'application/json': { schema } } }
    }
    else {
      delete responses['200']
    }
    setOrDelete(op, 'responses', Object.keys(responses).length ? responses : undefined)
  }

  setOrDelete(op, 'x-upstream', form.upstream.trim() || undefined)
  setOrDelete(op, 'x-upstream-path', form.upstreamPath.trim() || undefined)
  const headers = Object.fromEntries(form.headers.filter(h => h.name.trim()).map(h => [h.name.trim(), h.value]))
  setOrDelete(op, 'x-upstream-headers', Object.keys(headers).length ? headers : undefined)
  return op
}

interface PathsAdapter {
  getOp: (path: string, method: string) => Record<string, unknown> | undefined
  setOp: (path: string, method: string, op: Record<string, unknown>) => void
  deleteOp: (path: string, method: string) => void
  pathHasOtherMethods: (path: string, exceptMethod?: string) => boolean
  deletePath: (path: string) => void
  serialize: () => string
}

function yamlAdapter(doc: Document): PathsAdapter {
  const paths = () => {
    const js = doc.toJS()
    return isObj(js) && isObj(js.paths) ? js.paths as Record<string, Record<string, unknown>> : {}
  }
  return {
    getOp(path, method) {
      const item = paths()[path]
      return isObj(item) && isObj(item[method]) ? item[method] as Record<string, unknown> : undefined
    },
    setOp(path, method, op) {
      doc.setIn(['paths', path, method], op)
    },
    deleteOp(path, method) {
      doc.deleteIn(['paths', path, method])
    },
    pathHasOtherMethods(path, exceptMethod) {
      const item = paths()[path]
      return isObj(item) && Object.keys(item).some(k => (HTTP_METHODS as readonly string[]).includes(k) && k !== exceptMethod)
    },
    deletePath(path) {
      doc.deleteIn(['paths', path])
    },
    serialize() {
      return doc.toString()
    },
  }
}

function jsonAdapter(root: Record<string, unknown>): PathsAdapter {
  if (!isObj(root.paths))
    root.paths = {}
  const paths = root.paths as Record<string, Record<string, unknown>>
  return {
    getOp(path, method) {
      const item = paths[path]
      return isObj(item) && isObj(item[method]) ? item[method] as Record<string, unknown> : undefined
    },
    setOp(path, method, op) {
      paths[path] ??= {}
      paths[path]![method] = op
    },
    deleteOp(path, method) {
      if (isObj(paths[path]))
        delete paths[path]![method]
    },
    pathHasOtherMethods(path, exceptMethod) {
      const item = paths[path]
      return isObj(item) && Object.keys(item).some(k => (HTTP_METHODS as readonly string[]).includes(k) && k !== exceptMethod)
    },
    deletePath(path) {
      delete paths[path]
    },
    serialize() {
      return JSON.stringify(root, null, 2)
    },
  }
}

function loadAdapter(specText: string): { ok: true, adapter: PathsAdapter } | { ok: false, errors: string[] } {
  const trimmed = specText.trim()
  try {
    if (!trimmed)
      return { ok: true, adapter: yamlAdapter(new Document({ openapi: '3.0.3', paths: {} })) }
    if (trimmed.startsWith('{'))
      return { ok: true, adapter: jsonAdapter(JSON.parse(trimmed)) }
    const doc = parseDocument(trimmed)
    if (doc.errors.length)
      return { ok: false, errors: [`文档不是合法的 YAML：${doc.errors[0]!.message}`] }
    if (!doc.has('paths'))
      doc.set('paths', {})
    return { ok: true, adapter: yamlAdapter(doc) }
  }
  catch (e) {
    return { ok: false, errors: [`文档解析失败：${(e as Error).message}`] }
  }
}

/**
 * 新增或编辑一条接口：original 为 null 表示新增，否则按原 method+path 定位。
 * 改了 method/path 时按"新建 + 删旧"处理，旧路径下没有别的方法了就删掉整个路径。
 */
export function upsertOperation(specText: string, original: { method: HttpMethod, path: string } | null, form: BizOpForm, flags: OpFormFlags): { ok: true, specText: string } | { ok: false, errors: string[] } {
  const path = form.path.trim()
  const method = form.method
  if (!path.startsWith('/'))
    return { ok: false, errors: ['路径需以 / 开头'] }

  const loaded = loadAdapter(specText)
  if (!loaded.ok)
    return loaded
  const { adapter } = loaded

  const moved = !original || original.path !== path || original.method !== method
  if (moved && adapter.getOp(path, method))
    return { ok: false, errors: [`${method.toUpperCase()} ${path} 已存在，请换一个方法或路径`] }

  const existing = original ? adapter.getOp(original.path, original.method) : undefined
  const merged = applyFormToOp(existing, form, flags)

  if (original && moved) {
    adapter.deleteOp(original.path, original.method)
    if (!adapter.pathHasOtherMethods(original.path))
      adapter.deletePath(original.path)
  }
  adapter.setOp(path, method, merged)

  return { ok: true, specText: adapter.serialize() }
}

export function removeOperation(specText: string, method: HttpMethod, path: string): { ok: true, specText: string } | { ok: false, errors: string[] } {
  if (!specText.trim())
    return { ok: true, specText }
  const loaded = loadAdapter(specText)
  if (!loaded.ok)
    return loaded
  const { adapter } = loaded
  adapter.deleteOp(path, method)
  if (!adapter.pathHasOtherMethods(path))
    adapter.deletePath(path)
  return { ok: true, specText: adapter.serialize() }
}
