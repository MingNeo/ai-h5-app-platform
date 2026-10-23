import type { SiteInfo } from '@app-platform/shared'
import type { AdminUserDoc } from './lib/mongo'

declare module 'fastify' {
  interface FastifyRequest {
    site: SiteInfo | null
    admin?: AdminUserDoc
  }
}
