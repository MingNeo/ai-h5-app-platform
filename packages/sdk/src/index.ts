import { auth, initAuth } from './auth'
import { biz } from './capabilities'
import { config } from './config'
import { db, files, kv } from './data'
import { env } from './env'
import { isPlatformError } from './errors'
import { initTelemetry, report } from './telemetry'

const platform = {
  ready: () => initAuth(),
  app: {
    appId: config.appId,
    channel: config.channel,
    version: config.version,
  },
  env,
  auth,
  db,
  kv,
  files,
  biz,
  track(event: string, props: Record<string, unknown> = {}) {
    report('custom', { event, props })
  },
  isPlatformError,
}

Object.defineProperty(window, 'platform', { value: Object.freeze(platform), writable: false, configurable: false })

initTelemetry()
void initAuth()
