// 本地开发泛域名 DNS：把 *.<APP_BASE_DOMAIN> 解析到 127.0.0.1。
// macOS 通过 /etc/resolver/<domain> 把该域名及子域的查询转发到这里（见 dns-setup.sh）。
// 只支持 UDP：响应固定很小（< 512 字节），不需要 TCP 回退。
import dgram from 'node:dgram'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PORT = 5354

/** 读取仓库根目录的 .env.local（不覆盖已有环境变量），与 apps/server/src/config.ts 保持一致 */
export function loadEnvFile(file = join(REPO_ROOT, '.env.local')) {
  if (!existsSync(file))
    return
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#'))
      continue
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m)
      continue
    let value = m[2]
    if (/^(['"]).*\1$/.test(value))
      value = value.slice(1, -1)
    if (process.env[m[1]] === undefined)
      process.env[m[1]] = value
  }
}

/**
 * 解析 DNS 查询的头部和唯一的 question。
 * 非法报文、响应包（QR=1）、QDCOUNT !== 1、question 名带压缩指针时返回 null。
 */
export function decodeQuestion(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12)
    return null

  const id = buf.readUInt16BE(0)
  const flags = buf.readUInt16BE(2)
  const qdcount = buf.readUInt16BE(4)
  if (flags & 0x8000) // QR=1，这是响应包，不回复
    return null
  if (qdcount !== 1)
    return null

  const labels = []
  let offset = 12
  while (true) {
    if (offset >= buf.length)
      return null
    const len = buf[offset]
    offset += 1
    if (len === 0)
      break
    if (len & 0xc0) // question 名不会出现压缩指针
      return null
    if (offset + len > buf.length)
      return null
    labels.push(buf.subarray(offset, offset + len).toString('latin1'))
    offset += len
  }

  if (offset + 4 > buf.length)
    return null
  const qtype = buf.readUInt16BE(offset)
  const qclass = buf.readUInt16BE(offset + 2)

  return { id, flags, name: labels.join('.'), qtype, qclass, questionEnd: offset + 4 }
}

/**
 * 构造 DNS 响应：
 * - 匹配域名 + A：NOERROR，一条 127.0.0.1 记录
 * - 匹配域名 + 其他类型（如 AAAA）：NOERROR、0 回答，让浏览器立刻回落 IPv4
 * - 不匹配：NXDOMAIN
 */
export function buildResponse(buf, { domain, ip = '127.0.0.1', ttl = 60 } = {}) {
  const question = decodeQuestion(buf)
  if (!question)
    return null

  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255))
    throw new Error(`DNS_IP 不是合法的 IPv4 地址：${ip}`)

  const base = domain.toLowerCase().replace(/\.$/, '')
  const name = question.name.toLowerCase().replace(/\.$/, '')
  const matched = question.qclass === 1 && (name === base || name.endsWith(`.${base}`))
  const isA = matched && question.qtype === 1
  const rcode = matched ? 0 : 3

  const header = Buffer.alloc(12)
  header.writeUInt16BE(question.id, 0)
  // QR=1，复制 Opcode 和 RD，AA=1（本地权威），RA=0
  const flags = 0x8000 | (question.flags & 0x7800) | 0x0400 | (question.flags & 0x0100) | rcode
  header.writeUInt16BE(flags, 2)
  header.writeUInt16BE(1, 4) // QDCOUNT
  header.writeUInt16BE(isA ? 1 : 0, 6) // ANCOUNT
  header.writeUInt16BE(0, 8) // NSCOUNT
  header.writeUInt16BE(0, 10) // ARCOUNT（忽略查询里的 EDNS OPT）

  // question 区原样复制，保留 0x20 大小写随机化
  const questionSection = buf.subarray(12, question.questionEnd)
  const parts = [header, questionSection]

  if (isA) {
    const answer = Buffer.alloc(16)
    answer.writeUInt16BE(0xc00c, 0) // 指针指向 question 名
    answer.writeUInt16BE(1, 2) // TYPE A
    answer.writeUInt16BE(1, 4) // CLASS IN
    answer.writeUInt32BE(ttl, 6)
    answer.writeUInt16BE(4, 10) // RDLENGTH
    answer.set(octets, 12)
    parts.push(answer)
  }

  return Buffer.concat(parts)
}

function main() {
  loadEnvFile()
  const domain = (process.env.APP_BASE_DOMAIN || '').toLowerCase().replace(/\.$/, '')
  if (!domain) {
    console.error('[dns] 缺少 APP_BASE_DOMAIN：请在 .env.local 中配置应用基础域名，例如 local.example.test')
    process.exit(1)
  }
  const port = Number(process.env.DNS_PORT || DEFAULT_PORT)
  const ip = process.env.DNS_IP || '127.0.0.1'
  const debug = /^(1|true|yes|on)$/i.test(process.env.DNS_DEBUG || '')

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[dns] 端口不合法：${process.env.DNS_PORT}`)
    process.exit(1)
  }

  const server = dgram.createSocket('udp4')

  server.on('message', (msg, rinfo) => {
    const res = buildResponse(msg, { domain, ip })
    if (!res) {
      if (debug)
        console.log('[dns] 丢弃非法或不支持的报文')
      return
    }
    if (debug) {
      const q = decodeQuestion(msg)
      console.log(`[dns] ${q.name} type=${q.qtype} answers=${res.readUInt16BE(6)} rcode=${res.readUInt16BE(2) & 0xf}`)
    }
    server.send(res, rinfo.port, rinfo.address)
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE')
      console.error(`[dns] 端口 ${port} 已被占用，可能已有 dev-dns 在运行：lsof -nP -iUDP:${port}`)
    else
      console.error('[dns] 启动失败：', err)
    process.exit(1)
  })

  // 必须显式绑定 127.0.0.1，不能只传端口：Node 默认绑定 0.0.0.0，会暴露到局域网
  server.bind(port, '127.0.0.1', () => {
    console.log(`[dns] 泛域名解析已启动：*.${domain} → ${ip}（127.0.0.1:${port}）`)
    if (!existsSync(`/etc/resolver/${domain}`))
      console.warn(`[dns] 未找到 /etc/resolver/${domain}，系统不会把查询发到这里。先执行 make dns-setup`)
  })

  const shutdown = () => {
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()