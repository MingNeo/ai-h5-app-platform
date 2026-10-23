// 端到端冒烟测试：直接请求 server（模拟 nginx 的 Host 头），走一遍
// 后台登录 → 建应用 → 预览 → 网关读写/登录拦截/ACL → 构建 → 审批上线 → 线上访问 → 回滚
// 用法：node scripts/smoke.mjs [http://127.0.0.1:3000]
import http from 'node:http'
import { loadEnvFile } from './dev-dns.mjs'

loadEnvFile()
const BASE = process.argv[2] || 'http://127.0.0.1:3000'
const DOMAIN = (process.env.APP_BASE_DOMAIN || '').toLowerCase()
if (!DOMAIN) {
  console.error('缺少 APP_BASE_DOMAIN：请在 .env.local 中配置应用基础域名，例如 local.example.test')
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

const adminJar = cookieJar()
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

const admin = (path, opts = {}) => req(`admin.${DOMAIN}`, `/admin-api${path}`, { ...opts, jar: adminJar, headers: { 'x-app-admin': '1', ...opts.headers } })
const appHost = ch => ch === 'prod' ? `${APP}.${DOMAIN}` : `${APP}--${ch}.${DOMAIN}`

function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  }
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : '')
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log(`冒烟测试 ${BASE}，应用 ${APP}`)

  console.log('\n[后台]')
  let r = await admin('/auth/me')
  check('未登录访问后台接口返回 401', r.status === 401)
  r = await req(`admin.${DOMAIN}`, '/admin-api/apps', { method: 'POST', body: {}, jar: adminJar })
  check('缺少后台请求头被拒（CSRF 防护）', r.status === 403, r.json)
  r = await admin('/auth/dev-login', { method: 'POST', body: { name: '冒烟测试' } })
  check('本地免登', r.status === 200, r.json)
  r = await admin('/apps', { method: 'POST', body: { appId: 'Bad_ID', name: 'x' } })
  check('非法 appId 被拒', r.status === 422)
  r = await admin('/apps', { method: 'POST', body: { appId: 'admin', name: 'x' } })
  check('保留 appId 被拒', r.status === 422)
  r = await admin('/apps', { method: 'POST', body: { appId: APP, name: '冒烟应用' } })
  check('创建应用', r.status === 200 && r.json?.data?.appId === APP, r.json)
  r = await admin(`/apps/${APP}/files`)
  check('模板文件已初始化', r.json?.data?.files?.some(f => f.path === 'src/pages/home.js'), r.json)

  console.log('\n[预览访问控制]')
  r = await req(appHost('dev'), '/')
  check('无票据访问草稿预览被拒', r.status === 403)
  r = await admin(`/apps/${APP}/preview-url`, { method: 'POST', body: { channel: 'dev', identity: 'self' } })
  const previewUrl = new URL(r.json.data.url)
  const devJar = cookieJar()
  r = await req(appHost('dev'), `${previewUrl.pathname}${previewUrl.search}`, { jar: devJar })
  check('预览票据换 cookie 并跳转', r.status === 302 && devJar.header().includes('__Host-app_preview'), { status: r.status })
  r = await req(appHost('dev'), '/', { jar: devJar })
  check('草稿预览直接返回源码', r.status === 200 && r.text.includes('/__platform/boot.js') && r.text.includes('/src/app.js'), r.text.slice(0, 300))
  check('预览注入平台运行时', ['/__platform/tailwind.js', '/__platform/ui.css'].every(p => r.text.includes(p)), r.text.slice(0, 400))
  check('预览页面带 CSP', (r.headers.get('content-security-policy') ?? '').includes("connect-src 'self'"))
  check('预览允许后台嵌入', (r.headers.get('content-security-policy') ?? '').includes(`frame-ancestors 'self' https://admin.${DOMAIN}`))
  r = await req(appHost('dev'), '/src/app.js', { jar: devJar })
  check('预览模块可加载', r.status === 200 && r.text.includes('renderHome'), r.text.slice(0, 200))
  r = await req(appHost('dev'), '/__platform/tailwind.js', { jar: devJar })
  check('原子类运行时可用', r.status === 200 && r.text.includes('tailwind'), r.text.slice(0, 120))
  r = await req(appHost('dev'), '/__platform/ui.js', { jar: devJar })
  check('平台交互工具可用', r.status === 200 && r.text.includes('export function toast'), r.text.slice(0, 120))
  r = await req(appHost('dev'), '/__platform/boot.js', { jar: devJar })
  check('SDK 注入配置', r.status === 200 && r.text.includes('window.__APP_CONFIG__') && r.text.includes(`"appId":"${APP}"`))

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

  console.log('\n[网关：登录拦截、ACL、唯一约束]')
  const api = (path, opts = {}) => req(appHost('dev'), `/__platform/api${path}`, { ...opts, jar: devJar, headers: { 'x-app-sdk': '1', ...opts.headers } })
  r = await req(appHost('dev'), '/__platform/api/auth/me', { jar: devJar })
  check('缺少 SDK 头被拒', r.status === 403)
  r = await api('/auth/me', { headers: { 'sec-fetch-site': 'same-site' } })
  check('跨站（其他应用）调用被拒', r.status === 403)
  r = await api('/auth/me')
  check('游客 auth/me 返回空用户', r.status === 200 && r.json.data.user === null, r.json)
  r = await api('/db/votes/group', { method: 'POST', body: { field: 'option' } })
  check('游客可读 public_read 集合', r.status === 200, r.json)
  r = await api('/db/votes', { method: 'POST', body: { data: { option: 'a' } } })
  check('游客写入返回 401（触发全局登录）', r.status === 401 && r.json.error_code === 'LOGIN_REQUIRED', r.json)
  r = await api('/dev/mock-login', { method: 'POST', body: { mobile: '13800001234' } })
  check('模拟登录写入共享 cookie', r.status === 200 && devJar.header().includes('app_mock_user'), r.json)
  r = await api('/auth/me')
  check('登录后 auth/me 返回用户', r.json?.data?.user?.uid === 'mock_1234', r.json)
  r = await api('/db/votes', { method: 'POST', body: { data: { option: 'a' } } })
  check('登录后重放写入成功', r.status === 200 && r.json.data._owner === 'mock_1234', r.json)
  r = await api('/db/votes', { method: 'POST', body: { data: { option: 'b' } } })
  check('唯一约束：重复投票返回 DUPLICATE', r.status === 409 && r.json.error_code === 'DUPLICATE', r.json)
  r = await api('/db/votes', { method: 'POST', body: { data: { option: 'z' } } })
  check('schema 校验：非法枚举值被拒', r.status === 422, r.json)
  r = await api('/db/votes', { method: 'POST', body: { data: { option: 'a', hacker: 1 } } })
  check('schema 校验：未声明字段被拒', r.status === 422, r.json)
  r = await api('/db/votes/query', { method: 'POST', body: { where: { $where: '1' } } })
  check('DSL：$where 被拒', r.status === 422, r.json)
  r = await api('/db/votes/query', { method: 'POST', body: { where: { option: { $regex: '.*' } } } })
  check('DSL：$regex 被拒', r.status === 422, r.json)
  r = await api('/db/votes/group', { method: 'POST', body: { field: 'option' } })
  check('分组计数', r.json?.data?.groups?.[0]?.count === 1, r.json)
  r = await api('/db/nope/query', { method: 'POST', body: {} })
  check('未声明集合返回 404', r.status === 404)
  r = await api('/kv/user/save', { method: 'PUT', body: { value: { level: 3 } } })
  check('用户 KV 写入', r.status === 200, r.json)
  r = await api('/kv/user/save')
  check('用户 KV 读取', r.json?.data?.value?.level === 3, r.json)

  console.log('\n[构建与发布]')
  r = await req(appHost('prod'), '/')
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
  r = await req(appHost('prod'), '/')
  check('线上版可访问', r.status === 200 && r.text.includes('/__platform/boot.js') && r.text.includes('/src/app.js'), r.text.slice(0, 300))
  const csp = r.headers.get('content-security-policy') ?? ''
  check('线上 CSP：只允许自身 + 主站登录 + 授权接口', csp.includes("default-src 'self'") && csp.includes("script-src 'self'") && !csp.includes('wss://'), csp)
  const asset = /src="(\/src\/[^"]+\.js)"/.exec(r.text)?.[1]
  r = await req(appHost('prod'), asset)
  check('静态资源可访问', r.status === 200 && (r.headers.get('cache-control') ?? '').includes('max-age'))
  r = await req(appHost('prod'), '/some/deep/route')
  check('history 路由回退 index.html', r.status === 200 && r.text.includes('/__platform/boot.js'))
  r = await req(appHost('prod'), '/src/x.js.map')
  check('sourcemap 不对外', r.status === 404)
  const prodJar = cookieJar()
  r = await req(appHost('prod'), '/__platform/api/db/votes/group', { method: 'POST', body: { field: 'option' }, jar: prodJar, headers: { 'x-app-sdk': '1' } })
  check('线上使用独立的 prod 数据库（测试数据不可见）', r.status === 200 && r.json.data.groups.length === 0, r.json)

  console.log('\n[下线与回滚]')
  r = await admin(`/apps/${APP}`, { method: 'PATCH', body: { status: 'offline' } })
  await sleep(5200)
  r = await req(appHost('prod'), '/')
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
