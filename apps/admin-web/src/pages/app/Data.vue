<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'
import { api, download } from '../../api'
import { useAppStore } from '../../stores/app'

const store = useAppStore()
const appId = store.app!.appId
const isOwner = computed(() => store.app?.role === 'owner')
const env = ref<'dev' | 'prod'>('dev')
const canWrite = computed(() => env.value === 'dev' ? store.canEdit() : isOwner.value)

interface ColInfo { name: string, acl: string, description: string, fields: Record<string, any>, count: number }
const collections = ref<ColInfo[]>([])
const kvApp = ref<Array<{ key: string, value: unknown }>>([])
const current = ref<string | null>(null)
const rows = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 20
const loading = ref(false)
const editDialog = ref<{ id?: string, json: string } | null>(null)
const mode = ref<'table' | 'stats'>('table')
const groupField = ref('')
const groups = ref<Array<{ value: unknown, count: number }>>([])
const groupTotal = ref(0)
const loadingGroup = ref(false)
const kvDialog = ref<{ key: string, json: string, isNew: boolean } | null>(null)

const ACL_LABEL: Record<string, string> = { private: '仅本人', public_read: '公开读', submit_only: '仅提交', public_submit: '游客可提交', public_write: '游客可读写', readonly: '只读配置', admin_only: '仅后台' }
const currentCol = computed(() => collections.value.find(c => c.name === current.value))
const columns = computed(() => Object.keys(currentCol.value?.fields ?? {}))

async function loadCollections() {
  const res = await api<{ collections: ColInfo[], kvApp: Array<{ key: string, value: unknown }> }>(`/apps/${appId}/data/${env.value}/collections`)
  collections.value = res.collections
  kvApp.value = res.kvApp
  if (!current.value || !collections.value.some(c => c.name === current.value))
    current.value = collections.value[0]?.name ?? null
  if (current.value)
    await loadRows()
}

async function loadGroup() {
  if (!current.value || !groupField.value)
    return
  loadingGroup.value = true
  try {
    const res = await api<{ total: number, groups: Array<{ value: unknown, count: number }> }>(`/apps/${appId}/data/${env.value}/${current.value}/group`, { body: { field: groupField.value, limit: 50 } })
    groups.value = res.groups
    groupTotal.value = res.total
  }
  finally {
    loadingGroup.value = false
  }
}

async function loadRows() {
  if (!current.value)
    return
  loading.value = true
  try {
    const res = await api<{ list: any[], total: number }>(`/apps/${appId}/data/${env.value}/${current.value}/query`, { body: { limit: pageSize, skip: (page.value - 1) * pageSize } })
    rows.value = res.list
    total.value = res.total
  }
  finally {
    loading.value = false
  }
}

function fmt(v: unknown) {
  if (v === undefined || v === null)
    return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

function openEdit(row?: any) {
  const data: Record<string, unknown> = {}
  for (const c of columns.value) {
    if (row && row[c] !== undefined)
      data[c] = row[c]
  }
  editDialog.value = { id: row?._id, json: JSON.stringify(data, null, 2) }
}

async function saveEdit() {
  let data: unknown
  try {
    data = JSON.parse(editDialog.value!.json)
  }
  catch {
    return ElMessage.error('不是合法的 JSON')
  }
  const base = `/apps/${appId}/data/${env.value}/${current.value}`
  if (editDialog.value!.id)
    await api(`${base}/${editDialog.value!.id}`, { method: 'PATCH', body: { data } })
  else await api(base, { body: { data } })
  editDialog.value = null
  ElMessage.success('已保存')
  await loadRows()
}

async function remove(row: any) {
  await ElMessageBox.confirm('删除这条数据？', '删除', { type: 'warning' })
  await api(`/apps/${appId}/data/${env.value}/${current.value}/${row._id}`, { method: 'DELETE' })
  await loadRows()
}

function exportCsv() {
  void download(`/apps/${appId}/data/${env.value}/${current.value}/export`)
}

async function syncToProd() {
  await ElMessageBox.confirm(`用测试环境「${current.value}」的数据覆盖正式环境？`, '同步到正式环境', { type: 'warning' })
  const res = await api<{ rows: number }>(`/apps/${appId}/data/sync-readonly`, { body: { collection: current.value } })
  ElMessage.success(`已同步 ${res.rows} 条`)
}

async function saveKv() {
  let value: unknown
  try {
    value = JSON.parse(kvDialog.value!.json)
  }
  catch {
    return ElMessage.error('不是合法的 JSON（字符串需要加引号）')
  }
  await api(`/apps/${appId}/data/${env.value}/kv/${encodeURIComponent(kvDialog.value!.key)}`, { method: 'PUT', body: { value } })
  kvDialog.value = null
  await loadCollections()
}

async function removeKv(key: string) {
  await ElMessageBox.confirm(`删除配置 ${key}？`, '删除', { type: 'warning' })
  await api(`/apps/${appId}/data/${env.value}/kv/${encodeURIComponent(key)}`, { method: 'DELETE' })
  await loadCollections()
}

watch(env, () => {
  page.value = 1
  void loadCollections()
})
watch(current, () => {
  page.value = 1
  groupField.value = columns.value[0] ?? ''
  groups.value = []
  void loadRows()
  if (mode.value === 'stats')
    void loadGroup()
})
watch(mode, (m) => {
  if (m === 'stats') {
    if (!groupField.value)
      groupField.value = columns.value[0] ?? ''
    void loadGroup()
  }
})
watch(groupField, () => {
  if (mode.value === 'stats')
    void loadGroup()
})
onMounted(loadCollections)
</script>

<template>
  <div class="p-6 flex gap-4 h-full">
    <div class="w-240px shrink-0 bg-white rounded-xl border border-[var(--border)] p-3 flex flex-col gap-2">
      <el-radio-group v-model="env" class="w-full">
        <el-radio-button value="dev" class="flex-1">
          测试数据
        </el-radio-button>
        <el-radio-button value="prod" class="flex-1">
          正式数据
        </el-radio-button>
      </el-radio-group>
      <div class="text-12px text-[var(--muted)] mt-2">
        数据集合
      </div>
      <div
        v-for="c in collections" :key="c.name"
        class="px-3 py-2 rounded-lg cursor-pointer"
        :class="c.name === current ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'"
        @click="current = c.name"
      >
        <div class="flex items-center justify-between">
          <span class="font-500">{{ c.name }}</span>
          <span class="text-12px text-[var(--muted)]">{{ c.count }}</span>
        </div>
        <div class="text-12px text-[var(--muted)]">
          {{ ACL_LABEL[c.acl] }} {{ c.description }}
        </div>
      </div>
      <div v-if="!collections.length" class="text-13px text-[var(--muted)] py-2">
        {{ env === 'prod' ? '线上版本还没有数据集合' : 'manifest.json 里还没有声明数据集合' }}
      </div>
      <div class="flex items-center justify-between mt-3">
        <span class="text-12px text-[var(--muted)]">应用配置（KV）</span>
        <el-button size="small" link type="primary" :disabled="!canWrite" @click="kvDialog = { key: '', json: '\'\'', isNew: true }">
          新增
        </el-button>
      </div>
      <div v-for="k in kvApp" :key="k.key" class="group flex items-center gap-1 px-3 py-1.5 rounded-lg hover:bg-gray-50 text-13px">
        <span class="flex-1 truncate cursor-pointer" @click="kvDialog = { key: k.key, json: JSON.stringify(k.value, null, 2), isNew: false }">{{ k.key }}</span>
        <el-button v-if="canWrite" size="small" link type="danger" class="opacity-0 group-hover:opacity-100" @click="removeKv(k.key)">
          删除
        </el-button>
      </div>
    </div>

    <div class="flex-1 min-w-0 bg-white rounded-xl border border-[var(--border)] p-4 flex flex-col">
      <template v-if="currentCol">
        <div class="flex items-center gap-2 mb-3">
          <span class="font-600">{{ currentCol.name }}</span>
          <el-tag size="small">
            {{ ACL_LABEL[currentCol.acl] }}
          </el-tag>
          <span class="text-13px text-[var(--muted)]">共 {{ total }} 条</span>
          <span class="flex-1" />
          <el-radio-group v-model="mode" size="small">
            <el-radio-button value="table">
              表格
            </el-radio-button>
            <el-radio-button value="stats">
              统计
            </el-radio-button>
          </el-radio-group>
          <el-button size="small" @click="mode === 'stats' ? loadGroup() : loadRows()">
            刷新
          </el-button>
          <el-button size="small" :disabled="!canWrite" @click="openEdit()">
            新增
          </el-button>
          <el-button v-if="isOwner" size="small" @click="exportCsv">
            导出 CSV
          </el-button>
          <el-button v-if="isOwner && env === 'dev' && currentCol.acl === 'readonly'" size="small" type="warning" plain @click="syncToProd">
            同步到正式环境
          </el-button>
        </div>
        <div v-if="mode === 'stats'" v-loading="loadingGroup" class="flex-1 flex flex-col gap-3 min-h-0 overflow-auto">
          <div class="flex items-center gap-2">
            <span class="text-13px text-[var(--muted)]">按字段分组</span>
            <el-select v-model="groupField" size="small" class="w-180px" placeholder="选择字段">
              <el-option v-for="c in columns" :key="c" :label="c" :value="c" />
            </el-select>
            <span class="text-13px text-[var(--muted)]">共 {{ groupTotal }} 条</span>
          </div>
          <div v-if="!groups.length" class="text-13px text-[var(--muted)] py-6 text-center">
            暂无数据
          </div>
          <div v-for="g in groups" :key="String(g.value)" class="flex items-center gap-3">
            <span class="w-140px truncate text-13px">{{ g.value === null ? '（空）' : fmt(g.value) }}</span>
            <div class="flex-1 h-20px rounded bg-gray-100 overflow-hidden">
              <div class="h-full bg-blue-500" :style="{ width: (groupTotal ? Math.round((g.count / groupTotal) * 100) : 0) + '%' }" />
            </div>
            <span class="w-90px text-right text-13px">{{ g.count }}（{{ groupTotal ? Math.round((g.count / groupTotal) * 100) : 0 }}%）</span>
          </div>
        </div>
        <el-table v-else v-loading="loading" :data="rows" size="small" border class="flex-1" height="100%">
          <el-table-column v-for="c in columns" :key="c" :label="c" min-width="120" show-overflow-tooltip>
            <template #default="{ row }">
              {{ fmt(row[c]) }}
            </template>
          </el-table-column>
          <el-table-column label="创建者" width="130" show-overflow-tooltip>
            <template #default="{ row }">
              {{ row._ownerProfile?.nickname || row._owner }}
            </template>
          </el-table-column>
          <el-table-column label="创建时间" width="160">
            <template #default="{ row }">
              {{ new Date(row._createdAt).toLocaleString('zh-CN') }}
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button size="small" link type="primary" :disabled="!canWrite" @click="openEdit(row)">
                编辑
              </el-button>
              <el-button size="small" link type="danger" :disabled="!canWrite" @click="remove(row)">
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination v-model:current-page="page" class="mt-3 justify-end" layout="prev, pager, next" :page-size="pageSize" :total="total" @current-change="loadRows" />
      </template>
      <el-empty v-else description="选择左侧的数据集合" />
    </div>

    <el-dialog :model-value="!!editDialog" :title="editDialog?.id ? '编辑数据' : '新增数据'" width="560px" @close="editDialog = null">
      <div class="text-12px text-[var(--muted)] mb-2">
        字段：{{ columns.join('、') }}
      </div>
      <el-input v-if="editDialog" v-model="editDialog.json" type="textarea" :rows="14" class="font-mono" />
      <template #footer>
        <el-button @click="editDialog = null">
          取消
        </el-button>
        <el-button type="primary" @click="saveEdit">
          保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog :model-value="!!kvDialog" title="应用配置" width="560px" @close="kvDialog = null">
      <template v-if="kvDialog">
        <el-input v-model="kvDialog.key" placeholder="key，例如 config" :disabled="!kvDialog.isNew" class="mb-2" />
        <el-input v-model="kvDialog.json" type="textarea" :rows="12" placeholder="JSON 值" class="font-mono" />
        <div class="text-12px text-[var(--muted)] mt-1">
          应用里用 platform.kv.app.get('{{ kvDialog.key || 'key' }}') 读取
        </div>
      </template>
      <template #footer>
        <el-button @click="kvDialog = null">
          取消
        </el-button>
        <el-button type="primary" :disabled="!canWrite" @click="saveKv">
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
