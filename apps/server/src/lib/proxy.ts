import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'

/** 把请求原样转发到本机端口（预览 dev server），可在返回前改写响应头/文本 */
export function proxyHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
  opts: {
    setHeaders?: (headers: http.IncomingHttpHeaders, status: number) => Record<string, string>
    /** 只在 text/html 响应上生效；用于修掉 Vite 给平台路径补的 base 前缀 */
    rewriteText?: (text: string) => string
  } = {},
) {
  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, 'accept-encoding': 'identity' },
  }, (up) => {
    const headers: Record<string, string | string[] | undefined> = { ...up.headers }
    const extra = opts.setHeaders?.(up.headers, up.statusCode ?? 200) ?? {}
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === '')
        delete headers[k.toLowerCase()]
      else headers[k.toLowerCase()] = v
    }
    const status = up.statusCode ?? 502
    if (opts.rewriteText && String(up.headers['content-type'] ?? '').includes('text/html')) {
      const chunks: Buffer[] = []
      up.on('data', c => chunks.push(c as Buffer))
      up.on('end', () => {
        const body = Buffer.from(opts.rewriteText!(Buffer.concat(chunks).toString('utf8')), 'utf8')
        delete headers['transfer-encoding']
        headers['content-length'] = String(body.length)
        res.writeHead(status, headers)
        res.end(body)
      })
      return
    }
    res.writeHead(status, headers)
    up.pipe(res)
  })
  upstream.on('error', (e) => {
    if (!res.headersSent)
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`预览服务不可用：${e.message}`)
  })
  req.pipe(upstream)
}

/** 转发 WebSocket 升级请求（HMR） */
export function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, port: number) {
  const upstream = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head?.length)
      upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const close = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.on('error', close)
  socket.on('error', close)
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}
