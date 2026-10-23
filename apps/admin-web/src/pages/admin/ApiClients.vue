<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { onMounted, ref } from 'vue'
import { api } from '../../api'

interface Client {
  id: string
  name: string
  appIds: string[]
  scopes: string[]
  allowedIps?: string[]
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

const list = ref<Client[]>([])
const created = ref<{ token: string, name: string } | null>(null)
const form = ref({ name: '', appIds: '*', scopes: ['read'] as string[], allowedIps: '' })
const SCOPE_LABEL: Record<string, string> = { read: '读', write: '写', export: '导出', dev: '测试数据' }

async function load() {
  const res = await api<{ clients: Client[] }>('/api-clients')
  list.value = res.clients
}

async function create() {
  if (!form.value.name.trim())
    return ElMessage.error('请填写调用方名称')
  const res = await api<{ id: string, token: string }>('/api-clients', {
    body: {
      name: form.value.name.trim(),
      appIds: form.value.appIds.split(',').map(s => s.trim()).filter(Boolean),
      scopes: form.value.scopes,
      allowedIps: form.value.allowedIps.split(',').map(s => s.trim()).filter(Boolean),
    },
  })
  created.value = { token: res.token, name: form.value.name }
  form.value = { name: '', appIds: '*', scopes: ['read'], allowedIps: '' }
  await load()
}

async function revoke(c: Client) {
  await ElMessageBox.confirm(`吊销「${c.name}」的 token？调用方会立即失效。`, '吊销', { type: 'warning' })
  await api(`/api-clients/${c.id}/revoke`, { method: 'POST', body: {} })
  await load()
}

async function remove(c: Client) {
  await ElMessageBox.confirm(`删除「${c.name}」？`, '删除', { type: 'warning' })
  await api(`/api-clients/${c.id}`, { method: 'DELETE' })
  await load()
}

async function copy() {
  await navigator.clipboard.writeText(created.value!.token)
  ElMessage.success('已复制')
}

onMounted(load)
</script>

<template>
  <div class="max-w-1100px mx-auto p-6 flex flex-col gap-4">
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-1">
        新建开放接口调用方
      </div>
      <div class="text-12px text-[var(--muted)] mb-3">
        调用方使用 <code>Authorization: Bearer &lt;token&gt;</code> 访问 <code>/open-api/v1/*</code>。默认只能读正式数据。
      </div>
      <div class="flex flex-wrap gap-2 items-center">
        <el-input v-model="form.name" placeholder="调用方名称，例如 张大妈活动后台" class="w-260px" />
        <el-input v-model="form.appIds" placeholder="应用，逗号分隔；* 表示全部" class="w-220px" />
        <el-input v-model="form.allowedIps" placeholder="IP 白名单（可选）" class="w-200px" />
        <el-checkbox-group v-model="form.scopes">
          <el-checkbox value="read">
            读
          </el-checkbox>
          <el-checkbox value="write">
            写
          </el-checkbox>
          <el-checkbox value="export">
            导出
          </el-checkbox>
          <el-checkbox value="dev">
            测试数据
          </el-checkbox>
        </el-checkbox-group>
        <el-button type="primary" @click="create">
          创建
        </el-button>
      </div>
    </div>

    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        调用方
      </div>
      <el-table :data="list" size="small" border>
        <el-table-column prop="name" label="名称" width="180" />
        <el-table-column label="应用" min-width="160">
          <template #default="{ row }">
            {{ row.appIds.join('、') }}
          </template>
        </el-table-column>
        <el-table-column label="权限" width="180">
          <template #default="{ row }">
            <el-tag v-for="s in row.scopes" :key="s" size="small" class="mr-1">
              {{ SCOPE_LABEL[s] ?? s }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="IP 白名单" width="160">
          <template #default="{ row }">
            {{ row.allowedIps?.join('、') || '不限' }}
          </template>
        </el-table-column>
        <el-table-column label="最近调用" width="160">
          <template #default="{ row }">
            {{ row.lastUsedAt ? new Date(row.lastUsedAt).toLocaleString('zh-CN') : '从未' }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.revokedAt" size="small" type="info">
              已吊销
            </el-tag>
            <el-tag v-else size="small" type="success">
              可用
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button v-if="!row.revokedAt" size="small" link type="warning" @click="revoke(row)">
              吊销
            </el-button>
            <el-button size="small" link type="danger" @click="remove(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog :model-value="!!created" title="token 已创建" width="560px" :close-on-click-modal="false" @close="created = null">
      <div class="text-13px mb-2">
        把下面这行配置给「{{ created?.name }}」。<b>只显示这一次</b>，关闭后无法再查看。
      </div>
      <el-input :model-value="created?.token" readonly class="font-mono">
        <template #append>
          <el-button @click="copy">
            复制
          </el-button>
        </template>
      </el-input>
      <div class="text-12px text-[var(--muted)] mt-2">
        接口文档：<a href="/open-api/v1/openapi.json" target="_blank" class="text-blue-600">/open-api/v1/openapi.json</a>
      </div>
    </el-dialog>
  </div>
</template>
