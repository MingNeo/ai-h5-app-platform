<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { onMounted, ref } from 'vue'
import { api } from '../../api'
import { useUserStore } from '../../stores/user'

interface AdminUserRow {
  id: string
  name: string
  avatar: string
  email: string
  isPlatformAdmin: boolean
  source: 'feishu' | 'dev'
  pinned: boolean
  createdAt: string
  lastLoginAt: string
}

const userStore = useUserStore()
const list = ref<AdminUserRow[]>([])
const keyword = ref('')

async function load() {
  list.value = await api<AdminUserRow[]>('/admin-users', { query: { q: keyword.value } })
}

/** 自己和 PLATFORM_ADMINS 配置里的账号，页面上不能取消 */
function disabledReason(row: AdminUserRow) {
  if (row.id === userStore.me?.id)
    return '不能取消自己的平台管理员'
  if (row.pinned)
    return '在 PLATFORM_ADMINS 配置中，需先从配置移除'
  return ''
}

async function toggle(row: AdminUserRow, next: boolean) {
  if (!next)
    await ElMessageBox.confirm(`取消「${row.name}」的平台管理员？对方将失去所有应用的管理权限。`, '取消平台管理员', { type: 'warning' })
  await api(`/admin-users/${row.id}`, { method: 'PATCH', body: { isPlatformAdmin: next } })
  ElMessage.success('已更新')
  await load()
}

onMounted(load)
</script>

<template>
  <div class="max-w-1100px mx-auto p-6 flex flex-col gap-4">
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="flex items-center mb-1">
        <span class="font-600 flex-1">用户管理</span>
        <el-input v-model="keyword" placeholder="按姓名或邮箱搜索" clearable class="w-220px" @keyup.enter="load" @clear="load" />
      </div>
      <div class="text-12px text-[var(--muted)] mb-3">
        平台管理员对所有应用等价于负责人；应用内角色请在各应用的「成员」页单独设置。
      </div>
      <el-table :data="list" size="small" empty-text="没有记录">
        <el-table-column label="用户" min-width="180">
          <template #default="{ row }">
            <div class="flex items-center gap-2">
              <el-avatar :size="24" :src="row.avatar">
                {{ row.name?.slice(0, 1) }}
              </el-avatar>
              <span>{{ row.name }}</span>
              <el-tag v-if="row.id === userStore.me?.id" size="small">
                我
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="邮箱" min-width="160">
          <template #default="{ row }">
            {{ row.email || '—' }}
          </template>
        </el-table-column>
        <el-table-column label="登录方式" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.source === 'dev' ? 'info' : ''">
              {{ row.source === 'dev' ? '本地免登' : '飞书' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近登录" width="160">
          <template #default="{ row }">
            {{ row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString('zh-CN') : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="首次登录" width="160">
          <template #default="{ row }">
            {{ row.createdAt ? new Date(row.createdAt).toLocaleString('zh-CN') : '—' }}
          </template>
        </el-table-column>
        <el-table-column label="平台管理员" width="140">
          <template #default="{ row }">
            <el-tooltip v-if="disabledReason(row)" :content="disabledReason(row)">
              <el-switch :model-value="row.isPlatformAdmin" disabled />
            </el-tooltip>
            <el-switch v-else :model-value="row.isPlatformAdmin" @change="(v: string | number | boolean) => toggle(row, Boolean(v))" />
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
