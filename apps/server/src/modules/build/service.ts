import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ACL_OPENNESS, type AppManifest, type CheckIssue, appUrl } from '@app-platform/shared'
import { config } from '../../config'
import { approvedGrants, invalidateApp } from '../../core/apps'
import { bizCheckInput, generatedFiles } from '../../core/biz-docs'
import { checkWorkspace } from '../../core/checks'
import { createSnapshot } from '../../core/drafts'
import { materialize } from '../../core/workspace'
import { audit } from '../../lib/audit'
import { blobs } from '../../lib/blob'
import { chat } from '../../lib/llm'
import { col, type BuildDoc, type SnapshotFile } from '../../lib/mongo'
import { store } from '../../lib/store'
import { newId } from '../../lib/tokens'
import { ensureIndexes } from '../gateway/data'
import { notifyFeishu } from './notify'

const SIZE_BUDGET = 3 * 1024 * 1024

export async function requestBuild(appId: string, userId: string) {
  const running = await col.builds.findOne({ appId, status: { $in: ['queued', 'running'] } })
  if (running)
    return running
  const snap = await createSnapshot(appId, { kind: 'build', message: '生成测试版', userId })
  const doc: BuildDoc = {
    _id: newId(),
    appId,
    snapshotId: snap._id,
    status: 'queued',
    issues: [],
    files: [],
    sizeBytes: 0,
    confirmations: [],
    createdBy: userId,
    createdAt: new Date(),
  }
  await col.builds.insertOne(doc)
  void kickBuilds()
  return doc
}

/** 与当前线上 manifest 相比，需要审批人确认或阻断发布的变更 */
export async function compareManifest(appId: string, next: AppManifest | null) {
  const issues: CheckIssue[] = []
  const confirmations: string[] = []
  if (!next)
    return { issues, confirmations }
  const app = await col.apps.findOne({ _id: appId })
  const prodBuild = app?.prodBuildId ? await col.builds.findOne({ _id: app.prodBuildId }, { projection: { manifest: 1 } }) : null
  const prev = prodBuild?.manifest
  const grants = await approvedGrants(appId)
  for (const c of next.capabilities) {
    if (!grants.capabilities.has(c))
      issues.push({ source: 'manifest', severity: 'warning', message: `能力 ${c} 尚未审批通过，上线后调用会失败` })
  }
  for (const p of next.bizApis) {
    if (!grants.bizPrefixes.some(g => p.startsWith(g)))
      issues.push({ source: 'manifest', severity: 'warning', message: `业务接口 ${p} 尚未审批通过，上线后会被拦截` })
  }
  if (prev) {
    for (const [name, def] of Object.entries(prev.collections)) {
      const now = next.collections[name]
      if (!now) {
        confirmations.push(`删除了数据集合 ${name}（线上数据会保留，但应用无法再访问）`)
        continue
      }
      if (ACL_OPENNESS[now.acl] > ACL_OPENNESS[def.acl])
        confirmations.push(`数据集合 ${name} 的权限从 ${def.acl} 放宽为 ${now.acl}`)
      for (const f of Object.keys(def.fields)) {
        if (!now.fields[f])
          confirmations.push(`数据集合 ${name} 删除了字段 ${f}（已有数据中的该字段会导致更新校验失败）`)
      }
    }
    if (prev.requireLogin && !next.requireLogin)
      confirmations.push('取消了「必须登录才能使用」')
  }
  return { issues, confirmations }
}

async function summarize(appId: string, files: SnapshotFile[], manifest: AppManifest | null) {
  if (config.llm.provider === 'mock' || !config.llm.baseUrl)
    return ''
  try {
    const app = await col.apps.findOne({ _id: appId })
    const prev = app?.prodBuildId ? await col.builds.findOne({ _id: app.prodBuildId }) : null
    const prevSnap = prev ? await col.snapshots.findOne({ _id: prev.snapshotId }) : null
    const before = new Map((prevSnap?.files ?? []).map(f => [f.path, f.hash]))
    const changed = files.filter(f => before.get(f.path) !== f.hash && /\.(?:vue|ts|json|html)$/.test(f.path)).slice(0, 8)
    const parts: string[] = []
    for (const f of changed) {
      const b = await blobs.get(f.hash)
      parts.push(`### ${f.path}\n${b?.toString('utf8').slice(0, 3000) ?? ''}`)
    }
    const res = await chat({
      model: config.llm.smallModel,
      messages: [
        { role: 'system', content: '你是发布审核助手。根据改动的文件，用中文写 3-6 条要点：这次版本做了什么、需要审批人重点关注的风险（数据收集、权限、外部链接、文案合规等）。不要寒暄。' },
        { role: 'user', content: `${prevSnap ? '与线上版本相比改动的文件' : '首次发布的主要文件'}：\n${parts.join('\n\n')}\n\nmanifest：${JSON.stringify(manifest)}` },
      ],
      maxTokens: 600,
    })
    return res.content.trim()
  }
  catch (e) {
    console.warn('[build] 生成变更摘要失败', (e as Error).message)
    return ''
  }
}

async function runBuild(build: BuildDoc) {
  const snap = await col.snapshots.findOne({ _id: build.snapshotId })
  if (!snap)
    throw new Error('快照不存在')
  const root = join(config.dataDir, 'builds-src', build._id)
  const outDir = join(config.dataDir, 'builds-out', build._id)
  try {
    await materialize(root, snap.files, await generatedFiles(build.appId))
    const res = await checkWorkspace(root, { outDir, cacheDir: join(config.dataDir, 'vite-cache', `${build.appId}-build`), biz: await bizCheckInput(build.appId) })
    const issues = [...res.issues]
    let files: SnapshotFile[] = []
    let sizeBytes = 0
    if (res.buildFiles.length) {
      for (const f of res.buildFiles) {
        if (f.path.endsWith('.map'))
          continue
        const { hash, size } = await blobs.put(readFileSync(join(outDir, f.path)))
        files.push({ path: f.path, hash, size })
        sizeBytes += size
      }
      if (sizeBytes > SIZE_BUDGET)
        issues.push({ source: 'build', severity: 'warning', message: `产物体积 ${(sizeBytes / 1024 / 1024).toFixed(1)}MB，超过建议值 3MB，首屏加载可能较慢` })
    }
    const cmp = await compareManifest(build.appId, res.manifest)
    issues.push(...cmp.issues)
    const ok = res.ok && files.some(f => f.path === 'index.html')
    if (!ok)
      files = []
    const summary = ok ? await summarize(build.appId, snap.files, res.manifest) : ''
    await col.builds.updateOne({ _id: build._id }, {
      $set: { status: ok ? 'success' : 'failed', issues, files, sizeBytes, manifest: res.manifest ?? undefined, summary, confirmations: cmp.confirmations, finishedAt: new Date() },
    })
    if (ok) {
      await col.apps.updateOne({ _id: build.appId }, { $set: { betaBuildId: build._id, updatedAt: new Date() } })
      invalidateApp(build.appId)
      // 测试版使用 dev 数据库，提前建好索引
      for (const [name, def] of Object.entries(res.manifest?.collections ?? {}))
        await ensureIndexes(build.appId, 'dev', name, def)
    }
    void notifyFeishu(ok ? `【测试版已生成】${build.appId}，请负责人确认上线` : `【测试版生成失败】${build.appId}`)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
}

let kicking = false
export async function kickBuilds() {
  if (kicking)
    return
  kicking = true
  try {
    for (;;) {
      const build = await col.builds.findOneAndUpdate({ status: 'queued' }, { $set: { status: 'running', startedAt: new Date() } }, { sort: { createdAt: 1 }, returnDocument: 'after' })
      if (!build)
        break
      if (!await store.setNX(`build:lock:${build._id}`, '1', 600))
        continue
      try {
        await runBuild(build)
      }
      catch (e) {
        console.error('[build] 失败', e)
        await col.builds.updateOne({ _id: build._id }, { $set: { status: 'failed', issues: [{ source: 'build', severity: 'error', message: (e as Error).message }], finishedAt: new Date() } })
      }
    }
  }
  finally {
    kicking = false
  }
}

export async function startBuildWorker() {
  mkdirSync(join(config.dataDir, 'builds-out'), { recursive: true })
  await col.builds.updateMany({ status: 'running' }, { $set: { status: 'queued' } })
  void kickBuilds()
  setInterval(() => void kickBuilds(), 5000).unref()
}

/** 把测试版发布到线上：schema 增量 → 切换指针 */
export async function release(appId: string, buildId: string, userId: string, note: string, kind: 'release' | 'rollback') {
  const build = await col.builds.findOne({ _id: buildId, appId })
  if (!build || build.status !== 'success')
    throw new Error('构建不存在或未成功')
  for (const [name, def] of Object.entries(build.manifest?.collections ?? {}))
    await ensureIndexes(appId, 'prod', name, def)
  const rel = { _id: newId(), appId, buildId, kind, note, createdBy: userId, createdAt: new Date() }
  await col.releases.insertOne(rel)
  await col.apps.updateOne({ _id: appId }, { $set: { prodBuildId: buildId, prodReleaseId: rel._id, updatedAt: new Date() } })
  invalidateApp(appId)
  await purgeCdn(appId)
  audit(userId, kind === 'release' ? 'app.release' : 'app.rollback', appId, { buildId })
  void notifyFeishu(`【${kind === 'release' ? '已上线' : '已回滚'}】${appId}，构建 ${buildId}`)
  return rel
}

/** 有 CDN 时刷新 index.html（配置 CDN_PURGE_URL 后生效） */
async function purgeCdn(appId: string) {
  const url = process.env.CDN_PURGE_URL
  if (!url)
    return
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ urls: [appUrl(appId, 'prod', config.baseDomain), `${appUrl(appId, 'prod', config.baseDomain)}index.html`] }) }).catch(e => console.warn('[cdn] 刷新失败', e))
}
