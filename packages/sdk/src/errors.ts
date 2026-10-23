export type ErrorCode =
  | 'LOGIN_REQUIRED'
  | 'LOGIN_CANCELLED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'CAPABILITY_NOT_GRANTED'
  | 'UPSTREAM_ERROR'
  | 'NETWORK_ERROR'
  | 'INTERNAL_ERROR'

export class PlatformError extends Error {
  override name = 'PlatformError' as const
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 0,
    public upstreamCode?: number | string,
  ) {
    super(message)
  }
}

export function isPlatformError(e: unknown): e is PlatformError {
  return e instanceof PlatformError || (typeof e === 'object' && e !== null && (e as any).name === 'PlatformError')
}
