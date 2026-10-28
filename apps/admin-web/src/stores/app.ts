import type { AppPerm, AppRole } from '@app-platform/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

export interface AppDetail {
  appId: string
  name: string
  description: string
  icon: string
  status: 'active' | 'offline'
  schedule: { startAt?: string | null, endAt?: string | null } | null
  betaBuildId: string | null
  prodBuildId: string | null
  createdAt: string
  updatedAt: string
  role: AppRole
  perms: AppPerm[]
  urls: { prod: string, beta?: string, dev?: string }
  manifest: any
  manifestErrors: string[]
  grants: Array<{ _id: string, type: string, key: string, status: string, reason: string, reviewNote?: string, createdAt: string }>
}

/** 当前打开的应用，以及开发页内各面板之间的协作（例如把预览报错交给 AI） */
export const useAppStore = defineStore('app', () => {
  const app = ref<AppDetail | null>(null)
  /** 待放入对话输入框的引用 */
  const pendingAttachments = ref<Array<{ type: 'file' | 'collection' | 'error' | 'image', value: string, label?: string }>>([])
  /** 文件改动版本号：AI 或他人修改文件后递增，代码面板据此刷新 */
  const filesVersion = ref(0)
  /** 预览刷新信号 */
  const previewVersion = ref(0)
  /** 最近一轮对话还没定型（排队/发送中/运行中/被中断）：预览面板据此暂不展示报错，避免半成品报错误导 */
  const aiBusy = ref(false)

  async function load(appId: string) {
    app.value = await api<AppDetail>(`/apps/${appId}`)
    return app.value
  }

  function can(...perms: AppPerm[]) {
    const owned = new Set(app.value?.perms ?? [])
    return perms.every(p => owned.has(p))
  }

  function canAny(...perms: AppPerm[]) {
    const owned = new Set(app.value?.perms ?? [])
    return perms.some(p => owned.has(p))
  }

  const canEdit = () => can('app.edit')

  return { app, pendingAttachments, filesVersion, previewVersion, aiBusy, load, can, canAny, canEdit }
})
