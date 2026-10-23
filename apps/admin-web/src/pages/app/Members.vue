<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api'
import { useAppStore } from '../../stores/app'

const store = useAppStore()
const appId = store.app!.appId
const isOwner = computed(() => store.app?.role === 'owner')
const members = ref<Array<{ userId: string, role: string, name: string, avatar: string, email: string }>>([])
const adding = ref(false)
const searchResult = ref<Array<{ id: string, name: string, email: string }>>([])
const selectedUser = ref('')
const newRole = ref('developer')
const ROLE_LABEL: Record<string, string> = { owner: '负责人', developer: '开发者', viewer: '只读' }

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
  if (!selectedUser.value)
    return
  await setRole(selectedUser.value, newRole.value)
  adding.value = false
  selectedUser.value = ''
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
        <el-button v-if="isOwner" size="small" type="primary" @click="adding = true; search('')">
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
        <el-table-column label="角色" width="160">
          <template #default="{ row }">
            <el-select v-if="isOwner" :model-value="row.role" size="small" @change="(r: string) => setRole(row.userId, r)">
              <el-option v-for="(l, k) in ROLE_LABEL" :key="k" :label="l" :value="k" />
            </el-select>
            <span v-else>{{ ROLE_LABEL[row.role] }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="isOwner" label="操作" width="80">
          <template #default="{ row }">
            <el-button size="small" link type="danger" @click="remove(row.userId, row.name)">
              移除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="text-12px text-[var(--muted)] mt-3">
        负责人：确认上线、管理成员、导出数据；开发者：对话开发、编辑代码、生成测试版；只读：查看。成员需要先登录过一次后台。
      </div>
    </div>
    <el-dialog v-model="adding" title="添加成员" width="440px">
      <el-select v-model="selectedUser" filterable remote :remote-method="search" placeholder="搜索姓名或邮箱" class="w-full mb-3">
        <el-option v-for="u in searchResult" :key="u.id" :label="`${u.name} ${u.email}`" :value="u.id" />
      </el-select>
      <el-radio-group v-model="newRole">
        <el-radio-button v-for="(l, k) in ROLE_LABEL" :key="k" :value="k">
          {{ l }}
        </el-radio-button>
      </el-radio-group>
      <template #footer>
        <el-button @click="adding = false">
          取消
        </el-button>
        <el-button type="primary" :disabled="!selectedUser" @click="add">
          添加
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
