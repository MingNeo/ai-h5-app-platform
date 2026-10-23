import { ADMIN_VIEW_FILE, type DataEnv, parseAdminViewText } from '@app-platform/shared'
import { blobs } from '../lib/blob'
import { col } from '../lib/mongo'
import { readDraftText } from './drafts'

/**
 * 后台视图文件：dev 读草稿；prod 读线上构建快照里的同一文件。
 * 放在 core 里，鉴权（auth.ts）和接口（modules/admin/console.ts）共用，避免循环依赖。
 */
export async function adminViewText(appId: string, env: DataEnv): Promise<string | null> {
  if (env === 'dev')
    return readDraftText(appId, ADMIN_VIEW_FILE)
  const app = await col.apps.findOne({ _id: appId })
  if (!app?.prodBuildId)
    return null
  const build = await col.builds.findOne({ _id: app.prodBuildId }, { projection: { snapshotId: 1 } })
  if (!build?.snapshotId)
    return null
  const snap = await col.snapshots.findOne({ _id: build.snapshotId }, { projection: { files: 1 } })
  const file = snap?.files.find(f => f.path === ADMIN_VIEW_FILE)
  if (!file)
    return null
  const data = await blobs.get(file.hash)
  return data?.toString('utf8') ?? null
}

interface Cached {
  at: number
  collections: Set<string>
}

const TTL = 5000
const cache = new Map<string, Cached>()

/**
 * admin.json 里声明的集合。只有 console.view 而没有 data.read 的人，
 * 只能读这些集合；否则「看后台视图」就等于能拖走整库。
 */
export async function adminViewCollections(appId: string, env: DataEnv): Promise<Set<string>> {
  const key = `${appId}:${env}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL)
    return hit.collections
  const text = await adminViewText(appId, env)
  const collections = new Set<string>()
  if (text) {
    const parsed = parseAdminViewText(text)
    if (parsed.ok) {
      for (const page of parsed.view.pages) {
        for (const block of page.blocks) {
          if ('collection' in block && block.collection)
            collections.add(block.collection)
        }
      }
    }
  }
  cache.set(key, { at: Date.now(), collections })
  return collections
}
