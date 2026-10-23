import { type AppManifest, type Channel, MANIFEST_FILE, parseManifestText } from '@app-platform/shared'
import { blobs } from '../lib/blob'
import { col, type AppDoc } from '../lib/mongo'
import { store } from '../lib/store'

interface Cached<T> {
  value: T
  at: number
}

const TTL = 5000
const appCache = new Map<string, Cached<AppDoc | null>>()
const manifestCache = new Map<string, { manifest: AppManifest | null, errors: string[] }>()
const grantCache = new Map<string, Cached<{ capabilities: Set<string>, bizPrefixes: string[] }>>()

let subscribed = false
function ensureSubscribed() {
  if (subscribed)
    return
  subscribed = true
  store.subscribe('app:changed', (appId) => {
    appCache.delete(appId)
    grantCache.delete(appId)
  })
}

export function invalidateApp(appId: string) {
  appCache.delete(appId)
  grantCache.delete(appId)
  void store.publish('app:changed', appId)
}

export async function getApp(appId: string): Promise<AppDoc | null> {
  ensureSubscribed()
  const c = appCache.get(appId)
  if (c && Date.now() - c.at < TTL)
    return c.value
  const doc = await col.apps.findOne({ _id: appId, status: { $ne: 'deleted' } })
  appCache.set(appId, { value: doc, at: Date.now() })
  return doc
}

async function manifestFromHash(hash: string) {
  const hit = manifestCache.get(hash)
  if (hit)
    return hit
  const buf = await blobs.get(hash)
  const res = parseManifestText(buf?.toString('utf8') ?? '')
  const value = res.ok ? { manifest: res.manifest, errors: [] } : { manifest: null, errors: res.errors }
  manifestCache.set(hash, value)
  return value
}

export async function draftManifest(appId: string) {
  const f = await col.draftFiles.findOne({ appId, path: MANIFEST_FILE })
  if (!f)
    return { manifest: null, errors: ['缺少 manifest.json'] }
  return manifestFromHash(f.hash)
}

/** 某个渠道当前生效的 manifest：dev 取草稿，beta/prod 取对应构建 */
export async function effectiveManifest(appId: string, channel: Channel): Promise<AppManifest | null> {
  if (channel === 'dev')
    return (await draftManifest(appId)).manifest
  const app = await getApp(appId)
  const buildId = channel === 'prod' ? app?.prodBuildId : app?.betaBuildId
  if (!buildId)
    return null
  const build = await col.builds.findOne({ _id: buildId }, { projection: { manifest: 1 } })
  return build?.manifest ?? null
}

export async function approvedGrants(appId: string) {
  ensureSubscribed()
  const c = grantCache.get(appId)
  if (c && Date.now() - c.at < TTL)
    return c.value
  const grants = await col.grants.find({ appId, status: 'approved' }).toArray()
  const value = {
    capabilities: new Set(grants.filter(g => g.type === 'capability').map(g => g.key)),
    bizPrefixes: grants.filter(g => g.type === 'biz').map(g => g.key),
  }
  grantCache.set(appId, { value, at: Date.now() })
  return value
}

/** manifest 声明且已获批的业务接口前缀 */
export function allowedBizPrefixes(manifest: AppManifest | null, granted: string[]) {
  if (!manifest)
    return []
  return manifest.bizApis.filter(p => granted.some(g => p.startsWith(g)))
}

export function isWithinSchedule(app: AppDoc, now = new Date()) {
  const s = app.schedule
  if (s?.startAt && now < s.startAt)
    return 'not_started' as const
  if (s?.endAt && now > s.endAt)
    return 'ended' as const
  return 'ok' as const
}
