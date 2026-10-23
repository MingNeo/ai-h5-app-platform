import { loadDoc } from '@app-platform/agent-docs'
import type { Attachment } from '@app-platform/shared'
import { config } from '../../config'
import { approvedGrants, draftManifest } from '../../core/apps'
import { bizApiIndex, bizCatalogHint } from '../../core/biz-docs'
import { listDraft, readDraftText } from '../../core/drafts'
import { type AppDoc, type ChatMessage } from '../../lib/mongo'

export async function buildSystemPrompt(app: AppDoc, planMode: boolean) {
  const [files, manifest, grants, bizIndex, bizCatalog] = await Promise.all([listDraft(app._id), draftManifest(app._id), approvedGrants(app._id), bizApiIndex(app._id), bizCatalogHint(app._id)])
  const parts = [
    `你是「H5 应用平台」的 AI 开发助手，正在开发应用「${app.name}」（appId: ${app._id}）。`,
    loadDoc('rules'),
    loadDoc('sdk'),
    loadDoc('manifest'),
    '# 当前应用状态',
    `已开通能力：${[...grants.capabilities].join('、') || '无'}；已授权业务接口前缀：${grants.bizPrefixes.join('、') || '无'}。`,
    'manifest.json 中声明但未开通的能力或业务接口需要用户去后台「能力」页申请，你不能代为开通；请在回复里提醒用户。',
    bizCatalog ? `业务接口情况：\n${bizCatalog}` : '',
    '业务接口的路径、方法、参数、返回结构只能来自 read_biz_api 返回的文档。文档里没有的接口，不要按「命名惯例」猜路径或字段写死在代码里；manifest.bizApis 只能使用平台目录里已登记的前缀。请改写代码前先告诉用户「平台还没有登记这个接口」，并给出目录里已登记的服务供用户选择，或请用户提供接口文档。',
    manifest.errors.length ? `⚠️ 当前 manifest.json 有错误：\n${manifest.errors.join('\n')}` : '',
    `文件列表：\n${files.map(f => `- ${f.path} (${f.size}B)`).join('\n')}`,
    bizIndex ? `# 业务接口（签名索引）\n${bizIndex}\n调用前先 read_biz_api 查看该接口的参数、方法和返回结构，不要凭猜测传参或取字段。platform.biz.request 返回上游完整响应体（主站信封为 { error_code, error_msg, data }），按文档结构取字段。` : '',
    `今天是 ${new Date().toLocaleDateString('zh-CN')}。`,
  ]
  if (planMode) {
    parts.push('【方案模式】本轮只读：可以阅读文件和数据，但不能修改任何文件。请分析需求和现有代码，输出清晰的分步实施方案（涉及哪些文件、数据集合怎么设计、页面怎么交互），最后提示用户点击「按此执行」。')
  }
  return parts.filter(Boolean).join('\n\n')
}

export async function buildUserContent(appId: string, message: string, attachments: Attachment[], vision: boolean): Promise<ChatMessage['content']> {
  const blocks: string[] = []
  const images: string[] = []
  for (const a of attachments.slice(0, 10)) {
    if (a.type === 'file') {
      const text = await readDraftText(appId, a.value)
      blocks.push(text === null ? `（引用的文件 ${a.value} 不存在）` : `引用文件 ${a.value}：\n\`\`\`\n${text.slice(0, 12000)}\n\`\`\``)
    }
    else if (a.type === 'collection') {
      const m = (await draftManifest(appId)).manifest
      blocks.push(`引用数据集合 ${a.value}：${JSON.stringify(m?.collections[a.value] ?? '未声明')}`)
    }
    else if (a.type === 'error') {
      blocks.push(`预览中出现的错误：\n${a.value.slice(0, 4000)}`)
    }
    else if (a.type === 'image') {
      if (vision)
        images.push(a.value)
      else blocks.push(`（用户附带了一张图片${a.label ? `「${a.label}」` : ''}，但当前模型不支持看图，请根据文字描述完成）`)
    }
  }
  const text = [message, ...blocks].join('\n\n')
  if (!images.length)
    return text
  return [{ type: 'text', text }, ...images.map(url => ({ type: 'image_url' as const, image_url: { url } }))]
}

export function supportsVision(model: string) {
  return config.llm.visionModels.includes(model)
}
