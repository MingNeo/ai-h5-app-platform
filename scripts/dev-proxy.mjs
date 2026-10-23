// 本地 HTTPS 入口（没有 Docker 时代替 nginx，规则与 deploy/nginx 一致）
//   admin.<base>/admin-api/*  → server
//   admin.<base>/*            → admin-web（Vite dev）
//   其余 *.<base>             → server
// 用法：node scripts/dev-proxy.mjs   （macOS 10.14+ 普通用户可以监听 443）
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from './dev-dns.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
loadEnvFile()
const DOMAIN = (process.env.APP_BASE_DOMAIN || '').toLowerCase()
if (!DOMAIN) {
  console.error('缺少 APP_BASE_DOMAIN：请在 .env.local 中配置应用基础域名，例如 local.example.test')
  process.exit(1)
}
const PORT = Number(process.env.PROXY_PORT || 443)
const SERVER = { host: '127.0.0.1', port: Number(process.env.SERVER_PORT || 3000) }
const ADMIN = { host: '127.0.0.1', port: Number(process.env.ADMIN_PORT || 5173) }

function upstreamFor(req) {
  const host = (req.headers.host || '').split(':')[0]
  if (!host.endsWith(`.${DOMAIN}`))
    return null
  if (host === `admin.${DOMAIN}` && !req.url.startsWith('/admin-api/'))
    return ADMIN
  return SERVER
}

function forwardedHeaders(req) {
  return {
    ...req.headers,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': req.socket.remoteAddress,
    'x-real-ip': req.socket.remoteAddress,
  }
}

const server = https.createServer({
  cert: readFileSync(join(root, 'deploy/certs/cert.pem')),
  key: readFileSync(join(root, 'deploy/certs/key.pem')),
}, (req, res) => {
  const up = upstreamFor(req)
  if (!up) {
    res.writeHead(404).end('unknown host')
    return
  }
  const p = http.request({ ...up, method: req.method, path: req.url, headers: forwardedHeaders(req) }, (r) => {
    res.writeHead(r.statusCode, r.headers)
    r.pipe(res)
  })
  p.on('error', (e) => {
    if (!res.headersSent)
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`上游不可用（${up.port}）：${e.message}`)
  })
  req.pipe(p)
})

server.on('upgrade', (req, socket, head) => {
  const up = upstreamFor(req)
  if (!up)
    return socket.destroy()
  const conn = net.connect(up.port, up.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    const headers = forwardedHeaders(req)
    for (const [k, v] of Object.entries(headers))
      lines.push(`${k}: ${v}`)
    conn.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head?.length)
      conn.write(head)
    conn.pipe(socket)
    socket.pipe(conn)
  })
  const close = () => {
    conn.destroy()
    socket.destroy()
  }
  conn.on('error', close)
  socket.on('error', close)
})

server.listen(PORT, () => {
  console.log(`本地 HTTPS 入口已启动：https://admin.${DOMAIN}${PORT === 443 ? '' : `:${PORT}`}/`)
})
