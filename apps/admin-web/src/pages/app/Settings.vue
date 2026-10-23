<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api'
import { useAppStore } from '../../stores/app'

const store = useAppStore()
const router = useRouter()
const app = store.app!
const isOwner = computed(() => store.app?.role === 'owner')
const form = reactive({
  name: app.name,
  description: app.description,
  range: [app.schedule?.startAt ?? null, app.schedule?.endAt ?? null] as [string | null, string | null],
})

async function saveBasic() {
  await api(`/apps/${app.appId}`, { method: 'PATCH', body: { name: form.name, description: form.description } })
  await store.load(app.appId)
  ElMessage.success('已保存')
}

async function saveSchedule() {
  await api(`/apps/${app.appId}`, {
    method: 'PATCH',
    body: { schedule: { startAt: form.range?.[0] ? new Date(form.range[0]).toISOString() : null, endAt: form.range?.[1] ? new Date(form.range[1]).toISOString() : null } },
  })
  await store.load(app.appId)
  ElMessage.success('已保存')
}

async function toggleStatus() {
  const offline = store.app!.status !== 'offline'
  await ElMessageBox.confirm(offline ? '下线后线上用户将看到「应用已下线」页面。' : '重新上线后用户可以正常访问。', offline ? '下线应用' : '重新上线', { type: 'warning' })
  await api(`/apps/${app.appId}`, { method: 'PATCH', body: { status: offline ? 'offline' : 'active' } })
  await store.load(app.appId)
}

async function remove() {
  const { value } = await ElMessageBox.prompt(`删除后应用无法访问。请输入 appId「${app.appId}」确认。`, '删除应用', { type: 'error', inputPattern: new RegExp(`^${app.appId}$`), inputErrorMessage: 'appId 不匹配' })
  if (value !== app.appId)
    return
  await api(`/apps/${app.appId}`, { method: 'DELETE' })
  ElMessage.success('已删除')
  await router.push('/')
}
</script>

<template>
  <div class="max-w-720px mx-auto p-6 flex flex-col gap-4">
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        基本信息
      </div>
      <el-form label-width="90px">
        <el-form-item label="appId">
          {{ app.appId }}
        </el-form-item>
        <el-form-item label="访问地址">
          <div class="text-13px flex flex-col">
            <span>线上：{{ app.urls.prod }}</span>
            <span class="text-[var(--muted)]">测试版：{{ app.urls.beta }}（需要预览权限）</span>
          </div>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="form.name" maxlength="40" :disabled="!store.canEdit()" />
        </el-form-item>
        <el-form-item label="简介">
          <el-input v-model="form.description" type="textarea" maxlength="200" :disabled="!store.canEdit()" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :disabled="!store.canEdit()" @click="saveBasic">
            保存
          </el-button>
        </el-form-item>
      </el-form>
    </div>
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        上线时间
      </div>
      <div class="text-13px text-[var(--muted)] mb-3">
        设置后，时间范围外访问线上版会显示「活动未开始 / 已结束」。
      </div>
      <div class="flex gap-2">
        <el-date-picker v-model="form.range" type="datetimerange" start-placeholder="开始（不限）" end-placeholder="结束（不限）" :disabled="!isOwner" />
        <el-button :disabled="!isOwner" @click="saveSchedule">
          保存
        </el-button>
      </div>
    </div>
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        危险操作
      </div>
      <div class="flex gap-2">
        <el-button :type="store.app?.status === 'offline' ? 'success' : 'warning'" plain :disabled="!isOwner" @click="toggleStatus">
          {{ store.app?.status === 'offline' ? '重新上线' : '下线应用' }}
        </el-button>
        <el-button type="danger" plain :disabled="!isOwner" @click="remove">
          删除应用
        </el-button>
      </div>
    </div>
  </div>
</template>
