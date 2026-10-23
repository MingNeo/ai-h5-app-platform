import type { FastifyReply, FastifyRequest } from 'fastify'
import { ZodError, type ZodType, type z } from 'zod'
import { AppError, err } from './errors'

export function ok<T>(data: T) {
  return { error_code: 0, error_msg: '', data }
}

export function parseBody<S extends ZodType>(schema: S, value: unknown): z.infer<S> {
  const res = schema.safeParse(value ?? {})
  if (!res.success) {
    const msg = res.error.issues.map(i => `${i.path.join('.') || '参数'}: ${i.message}`).join('; ')
    throw err.invalid(msg)
  }
  return res.data
}

export function errorHandler(error: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AppError) {
    return reply.status(error.status).send({ error_code: error.code, error_msg: error.message, data: error.extra })
  }
  if (error instanceof ZodError)
    return reply.status(422).send({ error_code: 'VALIDATION_FAILED', error_msg: error.message })
  const e = error as { statusCode?: number, message?: string, code?: string }
  if (e.statusCode && e.statusCode < 500) {
    const code = e.statusCode === 413 ? 'VALIDATION_FAILED' : e.statusCode === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED'
    return reply.status(e.statusCode).send({ error_code: code, error_msg: e.statusCode === 413 ? '请求体过大' : e.message })
  }
  req.log.error(error)
  return reply.status(500).send({ error_code: 'INTERNAL_ERROR', error_msg: '服务器开小差了，请稍后重试' })
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header)
    return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0)
      continue
    const k = part.slice(0, i).trim()
    if (!k || k in out)
      continue
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim())
    }
    catch {
      out[k] = part.slice(i + 1).trim()
    }
  }
  return out
}

export function clientIp(req: FastifyRequest) {
  return req.ip
}
