// 一键启动本地开发环境：DNS + HTTPS proxy + server + admin-web。
// 用法：make dev（先由 Makefile 执行 scripts/dns-setup.sh，幂等）。
// Ctrl-C 一次即可停止全部子进程。
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import https from 'node:https'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnvFile } from './dev-dns.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DNS_PORT = 5354

loadEnvFile()

const domain = (process.env.APP_BASE_DOMAIN || '').toLowerCase().replace(/\.$/, '')
if (!domain) {
  console.error('缺少 APP_BASE_DOMAIN：请在 .env.local 中配置应用基础域名，例如 local.example.test')
  process.exit(1)
}
const dnsPort = Number(process.env.DNS_PORT || DEFAULT_DNS_PORT)
const proxyPort = Number(process.env.PROXY_PORT || 443)

const children = []
let stopping = false
let finalCode = 0

function tcpPortFree(port, host) {
  return new Promise((done) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => done(false))
    server.once('listening', () => server.close(() => done(true)))
    // 低端口在 macOS 上绑定 127.0.0.1 会 EACCES，必须和 dev-proxy 一样不指定 host
    if (host)
      server.listen(port, host)
    else
      server.listen(port)
  })
}

function udpPortFree(port) {
  return new Promise((done) => {
    const socket = dgram.createSocket('udp4')
    socket.once('error', () => done(false))
    socket.bind(port, '127.0.0.1', () => socket.close(() => done(true)))
  })
}

/** 轮询到后台返回非 5xx，避免浏览器打开时还是 502 */
function waitReady(url, timeoutMs = 30000) {
  return new Promise((done) => {
    const deadline = Date.now() + timeoutMs
    const retry = () => {
      if (Date.now() >= deadline)
        done(false)
      else
        setTimeout(attempt, 700)
    }
    function attempt() {
      let settled = false
      const req = https.get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
        res.resume()
        if (settled)
          return
        settled = true
        if (res.statusCode && res.statusCode < 500)
          done(true)
        else
          retry()
      })
      const fail = () => {
        if (settled)
          return
        settled = true
        retry()
      }
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', fail)
      req.on('close', fail)
    }
    attempt()
  })
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(command, [url], { stdio: 'ignore', detached: true })
  child.once('error', () => console.warn(`[dev] 无法自动打开浏览器，请手动访问：${url}`))
  child.unref()
}

function killGroup(child, signal) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return
  try {
    // detached: true 让子进程成为进程组组长，负 pid 一次杀掉 pnpm/tsx/vite 子孙进程
    process.kill(-child.pid, signal)
  }
  catch {}
}

function waitAll(list, ms = 5000) {
  return Promise.all(list.map(({ child }) => new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null)
      return done()
    const timer = setTimeout(done, ms)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
  })))
}

async function shutdown() {
  if (stopping)
    return
  stopping = true
  console.log('\n[dev] 正在停止...')
  const alive = () => children.filter(({ child }) => child.exitCode === null && child.signalCode === null)

  for (const { child } of alive())
    killGroup(child, 'SIGTERM')

  const forceTimer = setTimeout(() => {
    for (const { child } of alive())
      killGroup(child, 'SIGKILL')
  }, 3000)

  await waitAll(alive())
  clearTimeout(forceTimer)
  process.exit(finalCode)
}

function spawnChild(name, command, args) {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
    detached: true,
  })

  child.on('error', (err) => {
    if (stopping)
      return
    console.error(`[dev] ${name} 启动失败：${err.message}`)
    finalCode = 1
    void shutdown()
  })

  child.on('exit', (code, signal) => {
    if (stopping)
      return
    console.error(`[dev] ${name} 已退出（${code ?? signal}），关闭其余进程`)
    finalCode = code ?? 1
    void shutdown()
  })

  children.push({ name, child })
}

async function main() {
  const checks = [
    ['HTTPS proxy', proxyPort, tcpPortFree(proxyPort), `lsof -nP -iTCP:${proxyPort} -sTCP:LISTEN`],
  ]
  for (const [name, port, pending, hint] of checks) {
    if (!(await pending)) {
      console.error(`[dev] ${name} 端口 ${port} 已被占用，先停掉旧进程：${hint}`)
      process.exit(1)
    }
  }

  console.log(`[dev] 域名 ${domain}`)
  spawnChild('proxy', 'node', [join(REPO_ROOT, 'scripts/dev-proxy.mjs')])
  spawnChild('server+admin', 'pnpm', [
    '-r',
    '--parallel',
    '--filter',
    '@app-platform/server',
    '--filter',
    '@app-platform/admin-web',
    'dev',
  ])

  const adminUrl = `https://${domain}/admin/`
  console.log(`[dev] 后台：${adminUrl}`)
  console.log(`[dev] 应用：https://${domain}/a/<appId>/`)
  console.log(`[dev] 预览：https://${domain}/a/<appId>--dev/`)
  console.log(`[dev] demo：https://${domain}/a/demo/（未生成时先 make seed）`)
  console.log('[dev] Ctrl-C 停止全部进程')

  if (!/^(1|true|yes|on)$/i.test(process.env.DEV_NO_OPEN || '')) {
    if (await waitReady(adminUrl)) {
      console.log(`[dev] 已在浏览器打开：${adminUrl}（DEV_NO_OPEN=1 可关闭自动打开）`)
      openBrowser(adminUrl)
    }
    else {
      console.warn(`[dev] 后台尚未就绪，请手动打开：${adminUrl}`)
    }
  }
}

process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })

void main()