import type { ErrorCode } from '@app-platform/shared'
import { ERROR_CODES } from '@app-platform/shared'

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = ERROR_CODES[code] || 500,
    public extra?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export const err = {
  login: (msg = '请先登录') => new AppError('LOGIN_REQUIRED', msg, 401),
  forbidden: (msg = '没有权限') => new AppError('FORBIDDEN', msg, 403),
  notFound: (msg = '资源不存在') => new AppError('NOT_FOUND', msg, 404),
  invalid: (msg: string, extra?: Record<string, unknown>) => new AppError('VALIDATION_FAILED', msg, 422, extra),
  duplicate: (msg = '数据已存在') => new AppError('DUPLICATE', msg, 409),
  rate: (msg = '操作太频繁，请稍后再试') => new AppError('RATE_LIMITED', msg, 429),
  quota: (msg: string) => new AppError('QUOTA_EXCEEDED', msg, 429),
  capability: (msg: string) => new AppError('CAPABILITY_NOT_GRANTED', msg, 403),
  upstream: (msg: string) => new AppError('UPSTREAM_ERROR', msg, 502),
}
