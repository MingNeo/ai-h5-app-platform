import { describe, expect, it } from 'vitest'
import { appPath, appUrl, parseAppPath, parseSite, validateAppId } from '../app-id'
import { assertSafeDocument, DslError, normalizeQuery } from '../dsl'
import { aclRules, fieldsToJsonSchema, parseManifest } from '../manifest'
import { type BizApiSpec, checkBizCalls, extractBizParams, findBizOperation, generateBizApiDts, isHttpUrl, matchBizPath, normalizeOpenApi, parseOpenApiText, renderBizApiDetail, renderBizApiIndex, responseType, rewriteBizPath, schemaToTs, specOperations } from '../openapi'

const BASE = 'example.test'

describe('appId 与域名解析', () => {
  it.each(['ab', 'a--b', '-ab', 'ab-', 'Ab1', 'a_b', 'a'.repeat(31)])('拒绝非法 appId：%s', (id) => {
    expect(validateAppId(id)).not.toBeNull()
  })
  it.each(['abc', 'spring-vote', 'a1-b2-c3', 'a'.repeat(30)])('接受合法 appId：%s', (id) => {
    expect(validateAppId(id)).toBeNull()
  })
  it('拒绝保留字', () => {
    expect(validateAppId('admin')).toMatch('保留')
  })
  it('解析渠道', () => {
    expect(parseAppPath('/a/vote/')).toEqual({ appId: 'vote', channel: 'prod', path: '/' })
    expect(parseAppPath('/a/vote--dev/src/app.js?x=1')).toEqual({ appId: 'vote', channel: 'dev', path: '/src/app.js?x=1' })
    expect(parseAppPath('/a/vote--beta/about.html')).toEqual({ appId: 'vote', channel: 'beta', path: '/about.html' })
  })
  it('解析站点', () => {
    expect(parseSite(BASE, '/a/vote/', BASE)).toEqual({ kind: 'app', appId: 'vote', channel: 'prod', path: '/' })
    expect(parseSite(`${BASE}:443`, '/admin/apps/vote', BASE)).toEqual({ kind: 'admin' })
    expect(parseSite(BASE, '/admin-api/apps', BASE)).toEqual({ kind: 'admin' })
    expect(parseSite(BASE, '/__platform/dom.js', BASE)).toBeNull()
    expect(parseSite(BASE, '/a/', BASE)).toBeNull()
  })
  it('拒绝其他域名与非应用路径', () => {
    expect(parseSite('vote.evil.com', '/a/vote/', BASE)).toBeNull()
    expect(parseSite('admin.example.test', '/a/vote/', BASE)).toBeNull()
    expect(parseSite(BASE, '/a/vote--prod/', BASE)).toBeNull()
    expect(parseSite(BASE, '/a/api/', BASE)).toBeNull()
    expect(parseSite(BASE, '/vote/', BASE)).toBeNull()
  })
  it('生成应用地址', () => {
    expect(appPath('vote', 'prod')).toBe('/a/vote')
    expect(appPath('vote', 'dev')).toBe('/a/vote--dev')
    expect(appUrl('vote', 'beta', BASE)).toBe(`https://${BASE}/a/vote--beta/`)
  })
})

describe('查询 DSL', () => {
  it('接受白名单操作符', () => {
    const q = normalizeQuery({ where: { score: { $gte: 60, $lt: 100 }, tag: { $in: ['a', 'b'] }, $or: [{ a: 1 }, { b: true }] }, orderBy: [['score', 'desc']], limit: 50 })
    expect(q.limit).toBe(50)
    expect([...q.usedFields].sort()).toEqual(['a', 'b', 'score', 'tag'])
  })
  it.each([
    [{ where: { $where: 'sleep(1000)' } }],
    [{ where: { a: { $regex: '.*' } } }],
    [{ where: { a: { $expr: {} } } }],
    [{ where: { a: { $function: {} } } }],
    [{ where: { 'a.$b': 1 } }],
    [{ where: { a: { $gt: { $ne: 1 } } } }],
    [{ where: { a: { b: 1 } } }],
    [{ where: { $and: [{ $and: [{ $and: [{ a: 1 }] }] }] } }],
    [{ limit: 1000 }],
    [{ skip: -1 }],
    [{ orderBy: [['a', 'random']] }],
    [{ where: { a: { $in: 'x' } } }],
  ])('拒绝危险或非法查询 %#', (input) => {
    expect(() => normalizeQuery(input)).toThrow(DslError)
  })
  it('文档里禁止 $ 开头和带点的 key', () => {
    expect(() => assertSafeDocument({ a: { $set: 1 } })).toThrow(DslError)
    expect(() => assertSafeDocument({ 'a.b': 1 })).toThrow(DslError)
    expect(() => assertSafeDocument({ a: [{ b: 1 }] })).not.toThrow()
  })
})

describe('manifest', () => {
  it('校验集合定义', () => {
    const res = parseManifest({
      name: '测试',
      collections: {
        votes: { acl: 'public_read', fields: { option: { type: 'string', enum: ['a'] } }, indexes: [{ fields: { _owner: 1 }, unique: true }] },
      },
    })
    expect(res.ok).toBe(true)
  })
  it('拒绝未声明字段的索引、未知 ACL、非法集合名', () => {
    expect(parseManifest({ name: 'x', collections: { votes: { acl: 'public_read', indexes: [{ fields: { nope: 1 } }] } } }).ok).toBe(false)
    expect(parseManifest({ name: 'x', collections: { votes: { acl: 'everyone' } } }).ok).toBe(false)
    expect(parseManifest({ name: 'x', collections: { _sys: { acl: 'private' } } }).ok).toBe(false)
    expect(parseManifest({ name: 'x', extra: true }).ok).toBe(false)
  })
  it('字段转换为严格 JSON Schema', () => {
    const s = fieldsToJsonSchema({ a: 'string', b: { type: 'number', required: true, max: 10 } }) as any
    expect(s.additionalProperties).toBe(false)
    expect(s.required).toEqual(['b'])
    expect(s.properties.a.maxLength).toBe(2000)
  })
  it('ACL 规则', () => {
    expect(aclRules('submit_only')).toMatchObject({ read: 'own', create: true, update: false })
    expect(aclRules('readonly')).toMatchObject({ guestRead: true, create: false })
    expect(aclRules('admin_only').read).toBe('none')
  })
})

describe('业务接口文档（OpenAPI 3 子集）', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: '优惠券', version: '1' },
    paths: {
      '/api/coupon/list': {
        get: {
          summary: '优惠券列表',
          parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }],
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/List' } } } } },
        },
      },
      '/api/coupon/{id}/claim': {
        post: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } } } },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    components: {
      schemas: {
        List: { type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }, has_more: { type: 'boolean' } } },
      },
    },
  }

  it('拒绝 Swagger 2.0 和前缀之外的路径', () => {
    expect(normalizeOpenApi({ swagger: '2.0', paths: {} }, '/api/').ok).toBe(false)
    expect(normalizeOpenApi({ paths: { '/api/other/x': { get: { responses: {} } } } }, '/api/coupon/').ok).toBe(false)
    expect(normalizeOpenApi({ paths: { '/api/coupon/x': {} } }, '/api/coupon/').ok).toBe(false)
  })

  it('YAML 与 JSON 都能解析，格式错误给出提示', () => {
    const yaml = `openapi: 3.0.3
info:
  title: 优惠券
paths:
  /api/coupon/list:
    get:
      summary: 列表
      parameters:
        - name: page
          in: query
          schema: { type: integer }
      responses:
        '200':
          description: ok
`
    const parsed = parseOpenApiText(yaml)
    expect(parsed.ok).toBe(true)
    const res = normalizeOpenApi((parsed as { ok: true, doc: unknown }).doc, '/api/coupon/')
    expect(res.ok).toBe(true)
    const ops = specOperations((res as { spec: BizApiSpec }).spec)
    expect(ops).toHaveLength(1)
    expect(ops[0]!.path).toBe('/api/coupon/list')
    expect(parseOpenApiText(JSON.stringify(spec)).ok).toBe(true)
    const bad = parseOpenApiText('a: [1, 2')
    expect(bad.ok).toBe(false)
    expect((bad as { ok: false, errors: string[] }).errors[0]).toContain('YAML')
  })

  it('接口级上游与请求头用 OpenAPI 扩展声明', () => {
    const doc = {
      ...spec,
      paths: {
        ...spec.paths,
        '/api/coupon/{id}/claim': {
          post: {
            'x-upstream': 'http://coupon-service.internal:8080',
            'x-upstream-headers': { 'X-Token': 'env:COUPON_TOKEN' },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }
    const res = normalizeOpenApi(doc, '/api/coupon/')
    expect(res.ok).toBe(true)
    const op = specOperations((res as { spec: BizApiSpec }).spec).find(o => o.method === 'post')!
    expect(op.upstream).toBe('http://coupon-service.internal:8080')
    expect(op.headers).toEqual({ 'X-Token': 'env:COUPON_TOKEN' })
    expect(normalizeOpenApi({ ...doc, paths: { '/api/coupon/x': { get: { 'x-upstream': 'file:///etc/passwd' } } } }, '/api/coupon/').ok).toBe(false)
  })

  it('按方法 + 实际路径查找接口，路径参数可匹配', () => {
    const parsed = (normalizeOpenApi(spec, '/api/coupon/') as { spec: BizApiSpec }).spec
    const entries = [{ prefix: '/api/coupon/', title: '优惠券', spec: parsed }]
    expect(matchBizPath('/api/coupon/{id}/claim', '/api/coupon/42/claim')).toBe(true)
    expect(matchBizPath('/api/coupon/list', '/api/coupon/list')).toBe(true)
    expect(matchBizPath('/api/coupon/list', '/api/coupon/listX')).toBe(false)
    expect(findBizOperation(entries, 'POST', '/api/coupon/42/claim')?.op.path).toBe('/api/coupon/{id}/claim')
    expect(findBizOperation(entries, 'GET', '/api/coupon/42/claim')).toBeUndefined()
    expect(isHttpUrl('http://coupon-service.internal:8080')).toBe(true)
    expect(isHttpUrl('https://a.b/c?d=1')).toBe(true)
    expect(isHttpUrl('ftp://a.b')).toBe(false)
    expect(isHttpUrl('http://user:pass@a.b')).toBe(false)
  })

  it('校验通过并展开操作', () => {
    const res = normalizeOpenApi(spec, '/api/coupon/')
    expect(res.ok).toBe(true)
    const ops = specOperations((res as { spec: BizApiSpec }).spec)
    expect(ops.map(o => `${o.method} ${o.path}`)).toEqual(['get /api/coupon/list', 'post /api/coupon/{id}/claim'])
    expect(ops[0]!.parameters[0]!.name).toBe('page')
  })

  it('JSON Schema 转 TypeScript 类型（含 $ref）', () => {
    const parsed = (normalizeOpenApi(spec, '/api/coupon/') as { spec: BizApiSpec }).spec
    const op = specOperations(parsed)[0]!
    expect(schemaToTs(responseType(op)!.schema, parsed)).toBe('{ list?: { id?: string }[]; has_more?: boolean }')
  })

  it('生成的类型声明按路径给出返回类型', () => {
    const parsed = (normalizeOpenApi(spec, '/api/coupon/') as { spec: BizApiSpec }).spec
    const dts = generateBizApiDts([{ prefix: '/api/coupon/', title: '优惠券', spec: parsed }])
    expect(dts).toContain('"/api/coupon/list": { list?: { id?: string }[]; has_more?: boolean }')
    expect(dts).toContain('interface BizApiResults extends BizApiResultEntries {}')
    // 没有 2xx schema 的接口不生成类型
    expect(dts).not.toContain('claim')
  })

  it('索引只列签名，细节按需渲染', () => {
    const parsed = (normalizeOpenApi(spec, '/api/coupon/') as { spec: BizApiSpec }).spec
    const entries = [{ prefix: '/api/coupon/', title: '优惠券', description: '领券', spec: parsed, docs: '金额单位是分' }]
    const index = renderBizApiIndex(entries)
    expect(index).toContain('GET /api/coupon/list')
    expect(index).not.toContain('金额单位是分')
    expect(renderBizApiDetail(entries)).toContain('金额单位是分')
    expect(renderBizApiDetail(entries, { path: '/api/coupon/list' })).not.toContain('claim')
  })

  it('主站信封在详情里提示 SDK 未展开', () => {
    const res = normalizeOpenApi({
      openapi: '3.0.3',
      paths: {
        '/api/coupon/summary': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { error_code: { type: 'integer' }, error_msg: { type: 'string' }, data: { type: 'object', properties: { total: { type: 'number' } } } } },
                  },
                },
              },
            },
          },
        },
      },
    }, '/api/coupon/')
    expect(res.ok).toBe(true)
    const detail = renderBizApiDetail([{ prefix: '/api/coupon/', title: '优惠券', spec: (res as { spec: BizApiSpec }).spec }])
    expect(detail).toContain('上游完整信封')
    expect(detail).toContain('data?: { total?: number }')
  })

  it('对外路径可改写为不同的上游路径', () => {
    expect(rewriteBizPath({ path: '/api/v1/test1', upstreamPath: '/api/v1/test' }, '/api/v1/test1')).toBe('/api/v1/test')
    expect(rewriteBizPath({ path: '/api/v1/items/{id}', upstreamPath: '/internal/{id}/detail' }, '/api/v1/items/42')).toBe('/internal/42/detail')
    expect(rewriteBizPath({ path: '/api/v1/test2' }, '/api/v1/test2')).toBe('/api/v1/test2')
    expect(extractBizParams('/api/v1/items/{id}', '/api/v1/items/42')).toEqual({ id: '42' })
    // 上游路径里的参数必须能从对外路径取到
    const bad = normalizeOpenApi({ openapi: '3.0.3', paths: { '/api/v1/test1': { get: { 'x-upstream-path': '/real/{id}', responses: {} } } } }, '/api/v1/')
    expect(bad.ok).toBe(false)
    const good = normalizeOpenApi({ openapi: '3.0.3', paths: { '/api/v1/test1': { get: { 'x-upstream-path': '/api/v1/test', responses: {} } } } }, '/api/v1/')
    expect(good.ok).toBe(true)
  })

  it('静态核对 platform.biz.request 的路径、方法、参数', () => {
    const parsed = (normalizeOpenApi(spec, '/api/coupon/') as { spec: BizApiSpec }).spec
    const entries = [{ prefix: '/api/coupon/', title: '优惠券', spec: parsed }]
    const files = [{
      path: 'src/api.ts',
      content: `
        await platform.biz.request('/api/coupon/list', { data: { page: 1 } })
        await platform.biz.request('/api/coupon/list', { data: { pgae: 1 } })
        await platform.biz.request('/api/coupon/list', { method: 'POST' })
        await platform.biz.request('/api/coupon/1/claim', { method: 'POST', data: { reason: 'x' } })
        await platform.biz.request('/api/coupon/unknown')
        await platform.biz.request('/api/other/thing')
      `,
    }]
    const issues = checkBizCalls(files, { granted: ['/api/coupon/'], entries })
    const messages = issues.map(i => i.message).join('\n')
    expect(messages).toContain('没有参数 pgae')
    expect(messages).toContain('只登记了 GET')
    expect(messages).toContain('不在已登记的文档中')
    expect(issues.some(i => i.severity === 'error' && i.message.includes('/api/other/thing'))).toBe(true)
    expect(issues.some(i => i.severity === 'warning' && i.message.includes('/api/coupon/unknown'))).toBe(true)

    // manifest 已声明但未开通：warning，而不是未授权 error
    const pending = checkBizCalls(files, { granted: [], declared: ['/api/coupon/'], entries })
    expect(pending.some(i => i.severity === 'warning' && i.message.includes('尚未开通'))).toBe(true)
    expect(pending.some(i => i.severity === 'error' && i.message.includes('/api/coupon/list'))).toBe(false)
    // 未开通时也继续核对文档，避免审批通过后才发现参数写错
    expect(pending.some(i => i.message.includes('没有参数 pgae'))).toBe(true)
    expect(issues.filter(i => i.message.includes('/api/coupon/list') && i.message.includes('没有参数')).map(i => i.message)).toEqual([expect.stringContaining('pgae')])
  })
})
