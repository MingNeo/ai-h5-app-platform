<script setup lang="ts">
import { ROLE_LABELS, type AppRole } from '@app-platform/shared'
import { ElMessage } from 'element-plus'
import { computed, ref } from 'vue'
import { api } from '../../api'
import PreviewPanel from '../../components/preview/PreviewPanel.vue'
import { useAppStore } from '../../stores/app'

const store = useAppStore()
const app = computed(() => store.app!)
const roleLabel = computed(() => ROLE_LABELS[app.value.role as AppRole] ?? app.value.role)
const online = computed(() => Boolean(app.value.prodBuildId) && app.value.status !== 'offline')
const canManage = computed(() => store.can('app.manage'))
const hasPreview = computed(() => Boolean(app.value.betaBuildId || app.value.prodBuildId))
const observeOpen = ref(Boolean(app.value.observeOpen))
const savingObserve = ref(false)
/** 预览分享链接：登录后台的人打开后即使不是成员，也能看到概览和内嵌预览 */
const observeUrl = computed(() => `${location.origin}${import.meta.env.BASE_URL}apps/${app.value.appId}/overview`)

function statusTag() {
  if (app.value.status === 'offline')
    return { type: 'info', text: '已下线' }
  if (app.value.prodBuildId)
    return { type: 'success', text: '已上线' }
  if (app.value.betaBuildId)
    return { type: 'warning', text: '测试中' }
  return { type: 'info', text: '开发中' }
}

/** 测试版预览要现签票据；直接打开 beta 地址会被预览 cookie 拦住 */
async function openBeta() {
  const res = await api<{ url: string }>(`/apps/${app.value.appId}/preview-url`, {
    body: { channel: 'beta', path: '/' },
  })
  window.open(res.url, '_blank')
}

async function setObserve(open: boolean) {
  savingObserve.value = true
  try {
    await api(`/apps/${app.value.appId}/observe`, { method: 'PUT', body: { open } })
    app.value.observeOpen = open
    ElMessage.success(open ? '已允许其他人预览' : '已关闭预览')
  }
  catch {
    observeOpen.value = !open
  }
  finally {
    savingObserve.value = false
  }
}

async function copyObserveUrl() {
  await navigator.clipboard.writeText(observeUrl.value)
  ElMessage.success('预览链接已复制')
}
</script>

<template>
  <div class="max-w-1000px mx-auto p-6">
    <div class="bg-white rounded-xl p-6 border border-[var(--border)]">
      <div class="flex items-start gap-4">
        <div class="w-48px h-48px rounded-xl bg-gradient-to-br from-orange-400 to-red-500 text-white flex items-center justify-center font-600 text-20px shrink-0">
          {{ app.name.slice(0, 1) }}
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-18px font-600 truncate">{{ app.name }}</span>
            <el-tag :type="statusTag().type as any" size="small">
              {{ statusTag().text }}
            </el-tag>
          </div>
          <div class="text-12px text-[var(--muted)] mt-1">
            {{ app.appId }} · {{ roleLabel }}
          </div>
          <div class="text-14px text-[var(--muted)] mt-3">
            {{ app.description || '暂无描述' }}
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 mt-6 text-13px">
        <div class="rounded-lg bg-[var(--bg-soft)] p-4">
          <div class="text-[var(--muted)] mb-1">
            创建时间
          </div>
          {{ new Date(app.createdAt).toLocaleString('zh-CN') }}
        </div>
        <div class="rounded-lg bg-[var(--bg-soft)] p-4">
          <div class="text-[var(--muted)] mb-1">
            最近更新
          </div>
          {{ new Date(app.updatedAt).toLocaleString('zh-CN') }}
        </div>
      </div>

      <div class="flex items-center gap-3 mt-6">
        <el-button v-if="online" type="primary" tag="a" :href="app.urls.prod" target="_blank">
          打开线上版
        </el-button>
        <span v-else class="text-13px text-[var(--muted)]">
          {{ app.status === 'offline' ? '应用已下线' : '尚未上线' }}
        </span>
        <el-button v-if="app.betaBuildId" @click="openBeta">
          打开测试版
        </el-button>
        <span v-else class="text-13px text-[var(--muted)]">测试版尚未生成</span>
      </div>
    </div>

    <div class="bg-white rounded-xl border border-[var(--border)] mt-4 overflow-hidden">
      <div class="flex items-center gap-3 px-4 h-48px border-b border-[var(--border)]">
        <span class="font-600">预览</span>
        <el-tag v-if="app.observeOpen" size="small" type="success">
          已开放
        </el-tag>
        <span class="flex-1" />
        <template v-if="canManage">
          <span class="text-13px text-[var(--muted)]">允许其他登录用户预览</span>
          <el-switch v-model="observeOpen" :loading="savingObserve" @change="setObserve(observeOpen)" />
          <el-button v-if="observeOpen" size="small" @click="copyObserveUrl">
            复制预览链接
          </el-button>
        </template>
        <span v-else class="text-12px text-[var(--muted)]">
          {{ app.observeOpen ? '负责人已开放预览' : '未开放预览' }}
        </span>
      </div>
      <div v-if="hasPreview" class="h-[68vh] min-h-520px">
        <PreviewPanel :app-id="app.appId" mode="observe" />
      </div>
      <el-empty v-else description="还没有可预览的测试版或线上版" :image-size="80" />
    </div>
  </div>
</template>
