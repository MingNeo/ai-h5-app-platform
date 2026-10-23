export const ERROR_CODES = {
  LOGIN_REQUIRED: 401,
  LOGIN_CANCELLED: 499,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  CONFLICT: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  CAPABILITY_NOT_GRANTED: 403,
  UPSTREAM_ERROR: 502,
  NETWORK_ERROR: 0,
  INTERNAL_ERROR: 500,
} as const

export type ErrorCode = keyof typeof ERROR_CODES

/** 与主站一致的响应信封 */
export interface ApiEnvelope<T = unknown> {
  error_code: 0 | ErrorCode
  error_msg: string
  data?: T
}
