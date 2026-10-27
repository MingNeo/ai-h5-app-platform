// 端到端冒烟测试：直接请求 server（模拟 nginx 的 Host 头），走一遍
// 后台登录 → 建应用 → 预览 → 网关读写/登录拦截/ACL → 构建 → 审批上线 → 线上访问 → 回滚
// 用法：node scripts/smoke.mjs [http://127.0.0.1:3000]
import http from 'node:http'
import { loadEnvFile } from './dev-dns.mjs'

loadEnvFile()
const BASE = process.argv[2] || 'http://127.0.0.1:3000'
const DOMAIN = (process.env.APP_BASE_DOMAIN || '').toLowerCase()
if (!DOMAIN) {
  console.error('缺少 APP_BASE_DOMAIN：请在 .env.local 中配置入口域名，例如 local.example.test')
  process.exit(1)
}
const APP = `smoke${Date.now().toString(36).slice(-5)}`
let failures = 0

function cookieJar() {
  const jar = new Map()
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    store(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv, ...attrs] = c.split(';')
        const i = kv.indexOf('=')
        const k = kv.slice(0, i).trim()
        const v = kv.slice(i + 1).trim()
        if (attrs.some(a => /max-age=0/i.test(a)) || attrs.some(a => /expires=thu, 01 jan 1970/i.test(a)))
          jar.delete(k)
        else jar.set(k, v)
      }
    },
  }
}

const devJar = cookieJar()
const target = new URL(BASE)

/** fetch 不允许改写 Host 头，这里用 node:http 模拟 nginx 转发 */
function req(host, path, { method = 'GET', body, headers = {}, jar } = {}) {
  const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: target.hostname,
      port: target.port || 80,
      method,
      path,
      headers: {
        'host': host,
        'x-forwarded-proto': 'https',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(jar ? { cookie: jar.header() } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'] ?? []
        jar?.store({ headers: { getSetCookie: () => setCookie } })
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        }
        catch {}
        resolve({ status: res.statusCode, json, text, headers: { get: k => [].concat(res.headers[k.toLowerCase()] ?? []).join(', ') || null } })
      })
    })
    r.on('error', reject)
    if (payload)
      r.write(payload)
    r.end()
  })
}

let adminToken = ''
const admin = (path, opts = {}) => req(DOMAIN, `/admin-api${path}`, {
  ...opts,
  headers: { ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}), ...opts.headers },
})
const appBase = ch => `/a/${APP}${ch === 'prod' ? '' : `--${ch}`}`
const appReq = (ch, path, opts = {}) => req(DOMAIN, `${appBase(ch)}${path}`, opts)
const appApi = (ch, path, opts = {}) => req(DOMAIN, `/__platform/api${path}`, {
  ...opts,
  jar: opts.jar ?? devJar,
  headers: { 'x-app-sdk': '1', 'x-app-id': APP, 'x-app-channel': ch, ...opts.headers },
})

function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  }
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '')
  }
}

function previewTicketTtl(url, issuedAt) {
  const ticket = new URL(url).searchParams.get('t')
  const payload = ticket?.split('.')[0]
  if (!payload)
    return 0
  const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString())
  return exp - issuedAt
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log(`冒烟测试 ${BASE}，应用 ${APP}`)

  console.log('\n[后台]')
  let r = await admin('/auth/me')
  check('未登录访问后台接口返回 401', r.status === 401)
  r = await req(DOMAIN, '/admin-api/apps', { method: 'POST', body: {}, headers: { cookie: '__Host-app_admin=forged' } })
  check('cookie 不能用于后台鉴权', r.status === 401, r.json)
  r = await admin('/auth/dev-login', { method: 'POST', body: { name: '冒烟测试' } })
  adminToken = r.json?.data?.token ?? ''
  const resumeSetCookie = r.headers.get('set-cookie') ?? ''
  check('本地免登返回 Bearer token', r.status === 200 && Boolean(adminToken), r.json)
  check(
    '同时只写恢复 cookie（HttpOnly，限定 /admin-api/auth/ 路径）',
    resumeSetCookie.includes('__Secure-adm_resume=') && /httponly/i.test(resumeSetCookie) && /path=\/admin-api\/auth\//i.test(resumeSetCookie),
    resumeSetCookie,
  )
  r = await admin('/auth/me')
  check('Bearer 鉴权可用', r.status === 200 && r.json?.data?.name === '冒烟测试', r.json)

  console.log('\n[用户管理]')
  r = await admin('/admin-users')
  check('能看到自己且为平台管理员', r.status === 200 && r.json?.data?.some(u => u.name === '冒烟测试' && u.isPlatformAdmin), r.json)
  const selfId = r.json?.data?.find(u => u.name === '冒烟测试')?.id
  r = await admin(`/admin-users/${selfId}`, { method: 'PATCH', body: { isPlatformAdmin: false } })
  check('不能取消自己的平台管理员', r.status === 422, r.json)

  console.log('\n[刷新免登 resume cookie]')
  const resumeToken = /__Secure-adm_resume=([^;]+)/.exec(resumeSetCookie)?.[1] ?? ''
  r = await req(DOMAIN, '/admin-api/auth/resume', { headers: { cookie: `__Secure-adm_resume=${resumeToken}`, 'sec-fetch-mode': 'cors' } })
  check('非顶层导航调用 resume 被拒', r.status === 403, r.status)
  r = await req(DOMAIN, '/admin-api/apps', { method: 'POST', body: {}, headers: { cookie: `__Secure-adm_resume=${resumeToken}` } })
  check('仅带恢复 cookie 不能调业务接口', r.status === 401, r.json)
  r = await req(DOMAIN, '/admin-api/auth/resume', { headers: { cookie: `__Secure-adm_resume=${resumeToken}`, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })
  check('顶层导航带恢复 cookie 换回登录票据', r.status === 302 && (r.headers.get('location') ?? '').includes('/admin#t='), r.headers.get('location'))

  r = await admin('/apps', { method: 'POST', body: { appId: 'Bad_ID', name: 'x' } })
  check('非法 appId 被拒', r.status === 422)
  r = await admin('/apps', { method: 'POST', body: { appId: 'admin', name: 'x' } })
  check('保留 appId 被拒', r.status === 422)
  r = await admin('/apps', { method: 'POST', body: { appId: APP, name: '冒烟应用' } })
  check('创建应用', r.status === 200 && r.json?.data?.appId === APP, r.json)
  check('应用地址使用路径', r.json?.data?.urls?.prod === `https://${DOMAIN}/a/${APP}/`, r.json?.data?.urls)
  r = await admin(`/apps/${APP}/files`)
  check('模板文件已初始化', r.json?.data?.files?.some(f => f.path === 'src/pages/home.js'), r.json)

  console.log('\n[预览票据时效]')
  for (const [label, body] of [
    ['普通预览链接', { channel: 'beta' }],
    ['二维码预览链接', { channel: 'beta', qr: true }],
  ]) {
    const issuedAt = Math.floor(Date.now() / 1000)
    r = await admin(`/apps/${APP}/preview-url`, { method: 'POST', body })
    const ttl = previewTicketTtl(r.json?.data?.url ?? '', issuedAt)
    check(`${label}有效期为 30 分钟`, ttl >= 1800 && ttl <= 1801, ttl)
  }

  console.log('\n[预览访问控制]')
  r = await appReq('dev', '/')
  check('无票据访问草稿预览被拒', r.status === 403)
  r = await admin(`/apps/${APP}/preview-url`, { method: 'POST', body: { channel: 'dev', identity: 'self' } })
  const previewUrl = new URL(r.json.data.url)
  r = await req(DOMAIN, `${previewUrl.pathname}${previewUrl.search}`, { jar: devJar })
  check('预览票据换 cookie 并跳转', r.status === 302 && devJar.header().includes(`__Host-app_preview__${APP}`), { status: r.status, location: r.headers.get('location') })
  check('预览跳转到应用路径', (r.headers.get('location') ?? '') === `${appBase('dev')}/`, r.headers.get('location'))
  r = await appReq('dev', '/', { jar: devJar })
  check('草稿预览直接返回源码', r.status === 200 && r.text.includes('/__platform/boot.js') && r.text.includes(`${appBase('dev')}/src/app.js`), r.text.slice(0, 300))
  check('预览注入平台运行时', ['/__platform/tailwind.js', '/__platform/ui.css'].every(p => r.text.includes(p)), r.text.slice(0, 400))
  check('预览页面带 CSP', (r.headers.get('content-security-policy') ?? '').includes("connect-src 'self'"))
  check('预览允许后台嵌入', (r.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'self'"))
  r = await appReq('dev', '/src/app.js', { jar: devJar })
  check('预览模块可加载', r.status === 200 && r.text.includes('renderHome'), r.text.slice(0, 200))
  r = await req(DOMAIN, '/__platform/tailwind.js')
  check('原子类运行时可用', r.status === 200 && r.text.includes('tailwind'), r.text.slice(0, 120))
  r = await req(DOMAIN, '/__platform/ui.js')
  check('平台交互工具可用', r.status === 200 && r.text.includes('export function toast'), r.text.slice(0, 120))
  r = await req(DOMAIN, `/__platform/boot.js?app=${APP}&channel=dev`, { jar: devJar })
  check('SDK 注入配置', r.status === 200 && r.text.includes('window.__APP_CONFIG__') && r.text.includes(`"appId":"${APP}"`), r.text.slice(0, 200))

  console.log('\n[AI 对话（mock 模型）]')
  r = await admin(`/apps/${APP}/sessions`, { method: 'POST', body: {} })
  const sid = r.json.data.id
  r = await admin(`/sessions/${sid}/messages`, { method: 'POST', body: { message: '做一个投票页，3 个选项，每人一票' } })
  check('发送消息', r.status === 200, r.json)
  let done = null
  for (let i = 0; i < 120 && !done; i++) {
    await sleep(1000)
    const ev = await admin(`/sessions/${sid}/events`)
    done = ev.json.data.events.find(e => e.type === 'turn.done')
    if (done) {
      const types = new Set(ev.json.data.events.map(e => e.type))
      check('事件流包含思考、工具、计划、校验', ['thinking.delta', 'tool.start', 'tool.result', 'todo.update', 'check'].every(t => types.has(t)), [...types])
      const checks = ev.json.data.events.filter(e => e.type === 'check' && e.status !== 'running')
      check('AI 改完代码校验通过', checks.some(c => c.status === 'passed'), checks.map(c => c.issues))
    }
  }
  check('轮次完成', done?.status === 'completed', done)
  check('改动统计', done?.changes?.length >= 2, done?.changes)
  r = await admin(`/apps/${APP}/files/content?path=manifest.json`)
  check('manifest 已声明 votes 集合', r.json?.data?.content?.includes('"votes"'))
  const manifest = JSON.parse(r.json.data.content)
  const options = manifest.collections.votes.fields.option.enum
  const [optA, optB] = options

  console.log('\n[网关：登录拦截、ACL、唯一约束]')
  r = await req(DOMAIN, '/__platform/api/auth/me', { headers: { 'x-app-id': APP, 'x-app-channel': 'dev' } })
  check('缺少 SDK 头被拒', r.status === 403)
  r = await appApi('dev', '/auth/me', { headers: { 'sec-fetch-site': 'cross-site' } })
  check('跨站调用被拒', r.status === 403)
  r = await appApi('dev', '/auth/me')
  check('游客 auth/me 返回空用户', r.status === 200 && r.json.data.user === null, r.json)
  r = await appApi('dev', '/db/votes/group', { method: 'POST', body: { field: 'option' } })
  check('游客可读 public_read 集合', r.status === 200, r.json)
  r = await appApi('dev', '/db/votes', { method: 'POST', body: { data: { option: optA } } })
  check('游客写入返回 401（触发全局登录）', r.status === 401 && r.json.error_code === 'LOGIN_REQUIRED', r.json)
  r = await appApi('dev', '/dev/mock-login', { method: 'POST', body: { mobile: '13800001234' } })
  check('模拟登录写入共享 cookie', r.status === 200 && devJar.header().includes('app_mock_user'), r.json)
  r = await appApi('dev', '/auth/me')
  check('登录后 auth/me 返回用户', r.json?.data?.user?.uid === 'mock_1234', r.json)
  r = await appApi('dev', '/db/votes', { method: 'POST', body: { data: { option: optA } } })
  check('登录后重放写入成功', r.status === 200 && r.json.data._owner === 'mock_1234', r.json)
  r = await appApi('dev', '/db/votes', { method: 'POST', body: { data: { option: optB } } })
  check('重复投票被唯一约束/配额拒绝', ['DUPLICATE', 'QUOTA_EXCEEDED'].includes(r.json?.error_code), r.json)
  r = await appApi('dev', '/db/votes', { method: 'POST', body: { data: { option: 'not-in-enum' } } })
  check('schema 校验：非法枚举值被拒', r.status === 422, r.json)
  r = await appApi('dev', '/db/votes', { method: 'POST', body: { data: { option: optA, hacker: 1 } } })
  check('schema 校验：未声明字段被拒', r.status === 422, r.json)
  r = await appApi('dev', '/db/votes/query', { method: 'POST', body: { where: { $where: '1' } } })
  check('DSL：$where 被拒', r.status === 422, r.json)
  r = await appApi('dev', '/db/votes/query', { method: 'POST', body: { where: { option: { $regex: '.*' } } } })
  check('DSL：$regex 被拒', r.status === 422, r.json)
  r = await appApi('dev', '/db/votes/group', { method: 'POST', body: { field: 'option' } })
  check('分组计数', (r.json?.data?.groups?.find(g => g.value === optA)?.count ?? 0) >= 1, r.json)
  r = await appApi('dev', '/db/nope/query', { method: 'POST', body: {} })
  check('未声明集合返回 404', r.status === 404)
  r = await appApi('dev', '/kv/user/save', { method: 'PUT', body: { value: { level: 3 } } })
  check('用户 KV 写入', r.status === 200, r.json)
  r = await appApi('dev', '/kv/user/save')
  check('用户 KV 读取', r.json?.data?.value?.level === 3, r.json)

  console.log('\n[构建与发布]')
  r = await appReq('prod', '/')
  check('未发布时线上显示占位页', r.status === 200 && r.text.includes('尚未发布'))
  r = await admin(`/apps/${APP}/builds`, { method: 'POST', body: {} })
  check('发起构建', r.status === 200, r.json)
  const buildId = r.json.data.id
  let build = null
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    build = (await admin(`/apps/${APP}/builds/${buildId}`)).json.data
    if (build.status === 'success' || build.status === 'failed')
      break
  }
  check('构建成功', build?.status === 'success', build?.issues)
  r = await admin(`/apps/${APP}/release`, { method: 'POST', body: { buildId } })
  check('确认上线', r.status === 200, r.json)
  r = await appReq('prod', '/')
  check('线上版可访问', r.status === 200 && r.text.includes('/__platform/boot.js') && r.text.includes(`${appBase('prod')}/src/app.js`), r.text.slice(0, 300))
  const csp = r.headers.get('content-security-policy') ?? ''
  check('线上 CSP：只允许自身 + 主站登录 + 授权接口', csp.includes("default-src 'self'") && csp.includes("script-src 'self'") && !csp.includes('wss://'), csp)
  const asset = /src="([^"]+\.js)"/.exec(r.text.replace(/<script src="\/__platform[^>]+><\/script>/g, ''))?.[1]
  r = await appReq('prod', asset.replace(appBase('prod'), ''))
  check('静态资源可访问', r.status === 200 && (r.headers.get('cache-control') ?? '').includes('max-age'))
  r = await appReq('prod', '/some/deep/route')
  check('history 路由回退 index.html', r.status === 200 && r.text.includes('/__platform/boot.js'))
  r = await appReq('prod', '/src/x.js.map')
  check('sourcemap 不对外', r.status === 404)
  r = await appApi('prod', '/db/votes/group', { method: 'POST', body: { field: 'option' }, jar: cookieJar() })
  check('线上使用独立的 prod 数据库（测试数据不可见）', r.status === 200 && r.json.data.groups.length === 0, r.json)

  console.log('\n[下线与回滚]')
  r = await admin(`/apps/${APP}`, { method: 'PATCH', body: { status: 'offline' } })
  await sleep(5200)
  r = await appReq('prod', '/')
  check('下线后显示占位页', r.text.includes('已下线'))
  await admin(`/apps/${APP}`, { method: 'PATCH', body: { status: 'active' } })
  r = await admin(`/apps/${APP}/builds`)
  check('发布记录', r.json.data.releases.length === 1)

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
