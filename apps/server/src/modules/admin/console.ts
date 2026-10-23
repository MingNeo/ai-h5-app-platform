import { loadDoc } from '@app-platform/agent-docs'
import { ADMIN_VIEW_FILE, type AdminView, parseAdminViewText, validateAdminView } from '@app-platform/shared'
import { config } from '../../config'
import { effectiveManifest } from '../../core/apps'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { readDraftText, writeDraft } from '../../core/drafts'
import { blobs } from '../../lib/blob'
import { err } from '../../lib/errors'
import { ok, parseBody } from '../../lib/http'
import { chat } from '../../lib/llm'
import { col } from '../../lib/mongo'
import { rateLimit } from '../../lib/store'
import { requireAppRole } from './auth'

const envSchema = z.enum(['dev', 'prod'])

/** dev 读草稿；prod 读线上构建快照里的同一文件 */
async function viewText(appId: string, env: 'dev' | 'prod') {
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

export function registerConsoleRoutes(app: FastifyInstance) {
  /** 应用后台视图：AI 或人写在 admin.json，管理端按配置渲染 */
  app.get('/admin-api/apps/:appId/admin-view', async (req) => {
    const { appId } = req.params as { appId: string }
    await requireAppRole(req, appId, 'viewer')
    const env = envSchema.parse((req.query as { env?: string }).env ?? 'dev')
    const raw = await viewText(appId, env)
    const manifest = await effectiveManifest(appId, env)
    if (raw === null)
      return ok({ env, raw: null, view: null, errors: [], manifest })
    const parsed = parseAdminViewText(raw)
    if (!parsed.ok)
      return ok({ env, raw, view: null, errors: parsed.errors, manifest })
    return ok({ env, raw, view: parsed.view, errors: validateAdminView(parsed.view, manifest), manifest })
  })

  /** 配置规范（agent-docs/admin-view.md），后台直接展示给操作的人 */
  app.get('/admin-api/apps/:appId/admin-view/doc', async (req) => {
    const { appId } = req.params as { appId: string }
    await requireAppRole(req, appId, 'viewer')
    return ok({ markdown: loadDoc('admin-view') })
  })

  /** 用一句话生成/修改后台视图；只返回配置，不落盘 */
  app.post('/admin-api/apps/:appId/admin-view/ai', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'developer')
    if (!await rateLimit(`adminview:ai:${user._id}`, 10, 60))
      throw err.rate('生成太频繁，请稍后再试')
    const { instruction, current } = parseBody(z.object({
      instruction: z.string().min(2).max(2000),
      current: z.string().max(200_000).optional(),
    }), req.body)
    const manifest = await effectiveManifest(appId, 'dev')
    const res = await chat({
      model: config.llm.defaultModel,
      temperature: 0.2,
      maxTokens: 4000,
      messages: [
        { role: 'system', content: `${loadDoc('admin-view')}\n\n你只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。只能使用下面 manifest 里声明过的集合和字段。` },
        { role: 'user', content: `manifest.json：\n${JSON.stringify(manifest)}\n\n${current ? `当前 admin.json：\n${current}\n\n` : ''}需求：${instruction}` },
      ],
    })
    const raw = res.content.trim()
    const json = extractJson(raw)
    if (!json)
      return ok({ raw, view: null, errors: ['模型没有返回可解析的 JSON，请重试或手动调整'] })
    const parsed = parseAdminViewText(json)
    if (!parsed.ok)
      return ok({ raw: json, view: null, errors: parsed.errors })
    return ok({ raw: json, view: parsed.view, errors: validateAdminView(parsed.view, manifest) })
  })

  app.put('/admin-api/apps/:appId/admin-view', async (req) => {
    const { appId } = req.params as { appId: string }
    const { user } = await requireAppRole(req, appId, 'developer')
    const { content } = parseBody(z.object({ content: z.string().max(200_000) }), req.body)
    const parsed = parseAdminViewText(content)
    if (!parsed.ok)
      throw err.invalid(`admin.json 校验失败：${parsed.errors.join('；')}`)
    const manifest = await effectiveManifest(appId, 'dev')
    const errors = validateAdminView(parsed.view, manifest)
    if (errors.length)
      throw err.invalid(errors.join('；'))
    await writeDraft(appId, ADMIN_VIEW_FILE, `${JSON.stringify(parsed.view, null, 2)}\n`, { userId: user._id })
    return ok({ view: parsed.view as AdminView })
  })
}

/** 去掉代码块围栏，取出第一个 JSON 对象 */
function extractJson(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : ''
}
