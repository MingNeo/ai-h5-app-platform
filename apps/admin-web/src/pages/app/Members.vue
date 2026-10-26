<script setup lang="ts">
import { APP_ROLES, type AppRole, ROLE_LABELS } from '@app-platform/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api'
import { useAppStore } from '../../stores/app'

const store = useAppStore()
const appId = store.app!.appId
const canManage = computed(() => store.can('app.manage'))
const members = ref<Array<{ userId: string, role: AppRole, perms: string[], name: string, avatar: string, email: string }>>([])
const adding = ref(false)
const submitting = ref(false)
const searchResult = ref<Array<{ id: string, name: string, email: string }>>([])
const selectedUser = ref('')
const newRole = ref('developer')
const ROLES = APP_ROLES.map(key => ({ key, label: ROLE_LABELS[key] }))

function roleLabel(role: string) {
  return ROLE_LABELS[role as AppRole] ?? role
}

async function load() {
  members.value = await api(`/apps/${appId}/members`)
}

async function search(q: string) {
  searchResult.value = await api('/users', { query: { q } })
}

async function setRole(userId: string, role: string) {
  await api(`/apps/${appId}/members/${userId}`, { method: 'PUT', body: { role } })
  ElMessage.success('已更新')
  await load()
}

async function add() {
  if (!selectedUser.value || submitting.value)
    return
  submitting.value = true
  try {
    await setRole(selectedUser.value, newRole.value)
    adding.value = false
    selectedUser.value = ''
  }
  finally {
    submitting.value = false
  }
}

async function remove(userId: string, name: string) {
  await ElMessageBox.confirm(`移除成员 ${name}？`, '移除', { type: 'warning' })
  await api(`/apps/${appId}/members/${userId}`, { method: 'DELETE' })
  await load()
}

onMounted(load)
</script>

<template>
  <div class="max-w-800px mx-auto p-6">
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="flex items-center mb-3">
        <span class="font-600 flex-1">成员</span>
        <el-button v-if="canManage" size="small" type="primary" @click="adding = true; search('')">
          添加成员
        </el-button>
      </div>
      <el-table :data="members" size="small">
        <el-table-column label="成员">
          <template #default="{ row }">
            <div class="flex items-center gap-2">
              <el-avatar :size="24" :src="row.avatar">
                {{ row.name.slice(0, 1) }}
              </el-avatar>
              {{ row.name }} <span class="text-12px text-[var(--muted)]">{{ row.email }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="200">
          <template #default="{ row }">
            <el-select v-if="canManage" :model-value="row.role" size="small" @change="(r: string) => setRole(row.userId, r)">
              <el-option v-for="r in ROLES" :key="r.key" :label="r.label" :value="r.key" />
            </el-select>
            <span v-else>{{ roleLabel(row.role) }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="canManage" label="操作" width="80">
          <template #default="{ row }">
            <el-button size="small" link type="danger" @click="remove(row.userId, row.name)">
              移除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="text-12px text-[var(--muted)] mt-3">
        负责人：全部权限；开发者：对话开发、编辑代码、写测试数据、生成测试版；发布员：发布与回滚；数据管理员：读写数据、导出与同步；运营：只看后台视图与监控；只读：查看视图和数据。成员需要先登录过一次后台。
      </div>
    </div>
    <el-dialog v-model="adding" title="添加成员" width="500px">
      <el-select v-model="selectedUser" filterable remote :remote-method="search" placeholder="搜索姓名或邮箱" class="w-full mb-3">
        <el-option v-for="u in searchResult" :key="u.id" :label="`${u.name} ${u.email}`" :value="u.id" />
      </el-select>
      <el-radio-group v-model="newRole" class="role-picker">
        <el-radio-button v-for="r in ROLES" :key="r.key" :value="r.key">
          {{ r.label }}
        </el-radio-button>
      </el-radio-group>
      <template #footer>
        <el-button :disabled="submitting" @click="adding = false">
          取消
        </el-button>
        <el-button type="primary" :loading="submitting" :disabled="!selectedUser" @click="add">
          添加
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.role-picker {
  flex-wrap: wrap;
  width: 100%;
}
</style>
