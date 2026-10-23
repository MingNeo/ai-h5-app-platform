<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../../api'
import { useAppStore } from '../../stores/app'

interface Filter { field: string, type?: 'select' | 'input' | 'date', label?: string, options?: Array<string | number>, placeholder?: string }
interface Actions { detail?: boolean, edit?: boolean, delete?: boolean, create?: boolean }
interface Block {
  type: 'stat' | 'chart' | 'table' | 'text'
  title?: string
  collection?: string
  field?: string
  agg?: 'count' | 'sum' | 'avg'
  unit?: string
  hint?: string
  chart?: 'bar' | 'pie' | 'line'
  timeField?: string
  interval?: 'day' | 'hour'
  columns?: string[]
  where?: Record<string, unknown>
  orderBy?: Array<[string, 'asc' | 'desc']>
  pageSize?: number
  filters?: Filter[]
  search?: { fields: string[], placeholder?: string }
  actions?: Actions
  content?: string
  limit?: number
}
interface View { title?: string, description?: string, pages: Array<{ title: string, blocks: Block[] }> }
type FieldDef = { type?: string, enum?: Array<string | number>, required?: boolean, maxLength?: number, min?: number, max?: number } | string
interface Manifest { collections?: Record<string, { fields: Record<string, FieldDef>, acl?: string, description?: string }> }

interface TableState {
  filters: Record<string, unknown>
  search: string
  page: number
  list: any[]
  total: number
  loading: boolean
}

const store = useAppStore()
const appId = store.app!.appId
const env = ref<'dev' | 'prod'>('dev')
const raw = ref<string | null>(null)
const view = ref<View | null>(null)
const errors = ref<string[]>([])
const manifest = ref<Manifest>({})
const activePage = ref(0)
const loading = ref(false)
const results = ref<Record<string, any>>({})
const tables = ref<Record<string, TableState>>({})

const editDialog = ref(false)
const draft = ref('')
const detail = ref<{ title: string, row: any } | null>(null)

const aiDialog = ref(false)
const aiInstruction = ref('')
const aiResult = ref<{ raw: string, view: View | null, errors: string[] } | null>(null)
const aiLoading = ref(false)

const docDialog = ref(false)
const doc = ref('')

const formDialog = ref<{ key: string, collection: string, fields: string[], id?: string, model: Record<string, any>, json: Record<string, string> } | null>(null)

const canEdit = computed(() => store.canEdit())
const pages = computed(() => view.value?.pages ?? [])
const currentBlocks = computed(() => pages.value[activePage.value]?.blocks ?? [])

function keyOf(i: number) {
  return `p${activePage.value}b${i}`
}

function collectionFields(name?: string) {
  return manifest.value.collections?.[name ?? '']?.fields ?? {}
}

function fieldDef(collection: string | undefined, field: string): FieldDef {
  return collectionFields(collection)[field] ?? 'string'
}

function fieldType(collection: string | undefined, field: string) {
  const d = fieldDef(collection, field)
  return typeof d === 'string' ? d : (d.type ?? 'string')
}

function fieldEnum(collection: string | undefined, field: string) {
  const d = fieldDef(collection, field)
  return typeof d === 'object' ? d.enum : undefined
}

function columnsOf(block: Block) {
  return block.columns?.length ? block.columns : Object.keys(collectionFields(block.collection))
}

function actionsOf(block: Block): Actions {
  return { detail: true, ...(block.actions ?? {}) }
}

async function load() {
  loading.value = true
  try {
    const res = await api<{ raw: string | null, view: View | null, errors: string[], manifest: Manifest }>(`/apps/${appId}/admin-view`, { query: { env: env.value } })
    raw.value = res.raw
    view.value = res.view
    errors.value = res.errors
    manifest.value = res.manifest ?? {}
    if (activePage.value >= pages.value.length)
      activePage.value = 0
    results.value = {}
    tables.value = {}
    await loadBlocks()
  }
  finally {
    loading.value = false
  }
}

function buildWhere(block: Block, st?: TableState) {
  const where: Record<string, any> = { ...(block.where ?? {}) }
  for (const f of block.filters ?? []) {
    const v = st?.filters[f.field]
    if (v === '' || v === null || v === undefined)
      continue
    if (f.type === 'date') {
      const day = new Date(String(v))
      if (!Number.isNaN(day.getTime())) {
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
        where[f.field] = { $gte: start, $lt: start + 86400_000 }
      }
    }
    else {
      where[f.field] = v
    }
  }
  return where
}

async function loadBlock(i: number) {
  const block = currentBlocks.value[i]
  const key = keyOf(i)
  if (!block || block.type === 'text')
    return
  try {
    if (block.type === 'stat') {
      const res = await api<{ value: number }>(`/apps/${appId}/data/${env.value}/${block.collection}/stats`, {
        body: { op: block.agg ?? 'count', field: block.field, where: block.where },
      })
      results.value[key] = res.value
    }
    else if (block.type === 'chart') {
      if (block.chart === 'line') {
        const res = await api<{ series: Array<{ bucket: string, value: number }> }>(`/apps/${appId}/data/${env.value}/${block.collection}/stats`, {
          body: { op: 'count', where: block.where, timeField: block.timeField ?? '_createdAt', interval: block.interval ?? 'day' },
        })
        results.value[key] = { series: res.series ?? [] }
      }
      else {
        const res = await api<{ total: number, groups: Array<{ value: unknown, count: number }> }>(`/apps/${appId}/data/${env.value}/${block.collection}/group`, {
          body: { field: block.field, where: block.where, limit: block.limit ?? 12 },
        })
        results.value[key] = { groups: res.groups ?? [], total: res.total ?? 0 }
      }
    }
    else if (block.type === 'table') {
      const st = tables.value[key]
      if (!st)
        return
      st.loading = true
      const body: Record<string, unknown> = {
        where: buildWhere(block, st),
        orderBy: block.orderBy,
        limit: block.pageSize ?? 20,
        skip: (st.page - 1) * (block.pageSize ?? 20),
      }
      if (block.search && st.search)
        body.search = { value: st.search, fields: block.search.fields }
      const res = await api<{ list: any[], total: number }>(`/apps/${appId}/data/${env.value}/${block.collection}/query`, { body })
      st.list = res.list
      st.total = res.total
      st.loading = false
    }
  }
  catch (e: any) {
    results.value[key] = { error: e?.message ?? '加载失败' }
    const st = tables.value[key]
    if (st)
      st.loading = false
  }
}

async function loadBlocks() {
  for (let i = 0; i < currentBlocks.value.length; i++) {
    const b = currentBlocks.value[i]
    if (b.type === 'table') {
      const key = keyOf(i)
      if (!tables.value[key]) {
        tables.value[key] = {
          filters: Object.fromEntries((b.filters ?? []).map(f => [f.field, f.type === 'date' ? '' : ''])),
          search: '',
          page: 1,
          list: [],
          total: 0,
          loading: false,
        }
      }
    }
  }
  await Promise.all(currentBlocks.value.map((_, i) => loadBlock(i)))
}

function pageTable(i: number) {
  const st = tables.value[keyOf(i)]
  return st
}

function changePage(i: number, page: number) {
  const st = tables.value[keyOf(i)]
  if (!st)
    return
  st.page = page
  void loadBlock(i)
}

function setFilter(i: number, field: string, value: unknown) {
  const st = tables.value[keyOf(i)]
  if (st)
    st.filters[field] = value
}

function setSearch(i: number, value: string) {
  const st = tables.value[keyOf(i)]
  if (st)
    st.search = value
}

function applyFilters(i: number) {
  const st = tables.value[keyOf(i)]
  if (!st)
    return
  st.page = 1
  void loadBlock(i)
}

function openDetail(block: Block, row: any) {
  detail.value = { title: `${block.title || block.collection} · 详情`, row }
}

function openForm(block: Block, row?: any) {
  const key = keyOf(currentBlocks.value.indexOf(block))
  const fields = columnsOf(block)
  const model: Record<string, any> = {}
  const json: Record<string, string> = {}
  for (const f of fields) {
    const t = fieldType(block.collection, f)
    if (row && row[f] !== undefined)
      model[f] = row[f]
    else if (t === 'boolean')
      model[f] = false
    else if (t === 'array' || t === 'object')
      json[f] = row?.[f] ? JSON.stringify(row[f], null, 2) : ''
    else
      model[f] = row?.[f] ?? ''
  }
  formDialog.value = { key, collection: block.collection!, fields, id: row?._id, model, json }
}

async function saveForm() {
  const d = formDialog.value
  if (!d)
    return
  const data: Record<string, unknown> = {}
  for (const f of d.fields) {
    const t = fieldType(d.collection, f)
    if (t === 'array' || t === 'object') {
      const text = d.json[f]?.trim()
      if (!text) {
        if (t === 'array')
          data[f] = []
        continue
      }
      try {
        data[f] = JSON.parse(text)
      }
      catch {
        return ElMessage.error(`${f} 不是合法 JSON`)
      }
    }
    else if (t === 'number' || t === 'integer') {
      if (d.model[f] === '' || d.model[f] === null || d.model[f] === undefined)
        continue
      data[f] = Number(d.model[f])
    }
    else if (d.model[f] !== '' && d.model[f] !== undefined) {
      data[f] = d.model[f]
    }
  }
  const base = `/apps/${appId}/data/${env.value}/${d.collection}`
  if (d.id)
    await api(`${base}/${d.id}`, { method: 'PATCH', body: { data } })
  else await api(base, { body: { data } })
  formDialog.value = null
  ElMessage.success('已保存')
  await loadBlocks()
}

async function removeRow(block: Block, row: any) {
  await ElMessageBox.confirm('删除这条数据？不可恢复。', '删除', { type: 'warning' })
  await api(`/apps/${appId}/data/${env.value}/${block.collection}/${row._id}`, { method: 'DELETE' })
  await loadBlocks()
}

function exportCsv(collection: string) {
  window.open(`/admin-api/apps/${appId}/data/${env.value}/${collection}/export`, '_blank')
}

function openEditor() {
  draft.value = raw.value ?? templateText()
  editDialog.value = true
}

function templateText() {
  return JSON.stringify({
    title: '运营后台',
    description: '',
    pages: [{
      title: '概览',
      blocks: Object.keys(manifest.value.collections ?? {}).slice(0, 3).map(name => ({ type: 'stat', title: `${name} 总数`, collection: name })),
    }],
  }, null, 2)
}

async function saveRaw() {
  await api(`/apps/${appId}/admin-view`, { method: 'PUT', body: { content: draft.value } })
  editDialog.value = false
  ElMessage.success('已保存')
  await load()
}

async function loadDoc() {
  const res = await api<{ markdown: string }>(`/apps/${appId}/admin-view/doc`)
  doc.value = res.markdown
  docDialog.value = true
}

function openAi() {
  aiInstruction.value = ''
  aiResult.value = null
  aiDialog.value = true
}

async function generate() {
  if (aiInstruction.value.trim().length < 2)
    return ElMessage.error('先描述你要看什么')
  aiLoading.value = true
  try {
    aiResult.value = await api(`/apps/${appId}/admin-view/ai`, { body: { instruction: aiInstruction.value, current: raw.value ?? undefined } })
  }
  finally {
    aiLoading.value = false
  }
}

function useAiResult() {
  if (!aiResult.value)
    return
  draft.value = aiResult.value.raw
  aiDialog.value = false
  editDialog.value = true
}

async function applyAi() {
  const r = aiResult.value
  if (!r || !r.view || r.errors.length)
    return
  await api(`/apps/${appId}/admin-view`, { method: 'PUT', body: { content: JSON.stringify(r.view, null, 2) } })
  aiDialog.value = false
  ElMessage.success('已应用')
  await load()
}

function percent(count: number, total: number) {
  return total ? Math.round((count / total) * 100) : 0
}

const PIE_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']

function pieStyle(groups: Array<{ value: unknown, count: number }>, total: number) {
  let acc = 0
  const parts: string[] = []
  groups.forEach((g, i) => {
    const from = acc
    acc += percent(g.count, total)
    parts.push(`${PIE_COLORS[i % PIE_COLORS.length]} ${from}% ${acc}%`)
  })
  return { background: `conic-gradient(${parts.join(', ')})` }
}

function linePoints(series: Array<{ bucket: string, value: number }>) {
  if (!series.length)
    return ''
  const max = Math.max(...series.map(s => s.value), 1)
  const step = series.length > 1 ? 300 / (series.length - 1) : 0
  return series.map((s, i) => `${(i * step).toFixed(1)},${(110 - (s.value / max) * 100).toFixed(1)}`).join(' ')
}

function fmt(v: unknown) {
  if (v === undefined || v === null)
    return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

watch(env, load)
watch(activePage, async () => {
  results.value = {}
  tables.value = {}
  await loadBlocks()
})
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="p-6 h-full overflow-auto">
    <div class="flex items-center gap-3 mb-4">
      <div>
        <div class="font-600">
          {{ view?.title || '后台视图' }}
        </div>
        <div v-if="view?.description" class="text-12px text-[var(--muted)]">
          {{ view.description }}
        </div>
      </div>
      <el-radio-group v-model="env" size="small">
        <el-radio-button value="dev">
          测试数据
        </el-radio-button>
        <el-radio-button value="prod">
          正式数据
        </el-radio-button>
      </el-radio-group>
      <span class="flex-1" />
      <el-button size="small" @click="load">
        刷新
      </el-button>
      <el-button size="small" @click="loadDoc">
        配置说明
      </el-button>
      <el-button size="small" type="primary" plain :disabled="!canEdit" @click="openAi">
        AI 生成
      </el-button>
      <el-button size="small" :disabled="!canEdit" @click="openEditor">
        {{ raw ? '编辑 JSON' : '创建配置' }}
      </el-button>
    </div>

    <el-alert v-if="errors.length" type="warning" :closable="false" class="mb-4" title="admin.json 有问题，以下区块不会显示">
      <div v-for="e in errors" :key="e" class="text-13px">
        {{ e }}
      </div>
    </el-alert>

    <div v-if="!view" class="text-center py-16">
      <div class="text-[var(--muted)] mb-3">
        还没有后台视图配置。写一句话让 AI 生成，或手写 admin.json。
      </div>
      <el-button size="small" type="primary" :disabled="!canEdit" @click="openAi">
        AI 生成
      </el-button>
      <el-button size="small" :disabled="!canEdit" @click="openEditor">
        创建配置
      </el-button>
    </div>

    <template v-else>
      <el-tabs v-model="activePage">
        <el-tab-pane v-for="(p, i) in pages" :key="i" :label="p.title" :name="i" />
      </el-tabs>

      <div class="flex flex-wrap gap-4">
        <template v-for="(b, i) in currentBlocks" :key="i">
          <!-- stat -->
          <div v-if="b.type === 'stat'" class="bg-white rounded-xl border border-[var(--border)] p-4 min-w-190px flex-1">
            <div class="text-13px text-[var(--muted)]">
              {{ b.title }}
            </div>
            <div class="text-28px font-600 mt-1">
              {{ results[keyOf(i)] ?? '-' }}<span class="text-14px font-400 text-[var(--muted)] ml-1">{{ b.unit }}</span>
            </div>
            <div v-if="b.hint" class="text-12px text-[var(--muted)] mt-1">
              {{ b.hint }}
            </div>
          </div>

          <!-- chart -->
          <div v-else-if="b.type === 'chart'" class="bg-white rounded-xl border border-[var(--border)] p-4" :class="b.chart === 'line' ? 'w-full' : 'w-460px'">
            <div class="flex items-center mb-3">
              <span class="font-500">{{ b.title || (b.chart === 'line' ? '趋势' : b.field) }}</span>
              <span class="flex-1" />
              <span v-if="results[keyOf(i)]?.total !== undefined" class="text-12px text-[var(--muted)]">共 {{ results[keyOf(i)].total }} 条</span>
            </div>
            <div v-if="results[keyOf(i)]?.error" class="text-13px text-red-500">
              {{ results[keyOf(i)].error }}
            </div>

            <template v-else-if="b.chart === 'line'">
              <svg viewBox="0 0 300 120" preserveAspectRatio="none" class="w-full h-140px">
                <polyline :points="linePoints(results[keyOf(i)]?.series ?? [])" fill="none" stroke="#3b82f6" stroke-width="2" vector-effect="non-scaling-stroke" />
              </svg>
              <div class="flex justify-between text-12px text-[var(--muted)] mt-1">
                <span>{{ results[keyOf(i)]?.series?.[0]?.bucket ?? '' }}</span>
                <span>{{ results[keyOf(i)]?.series?.at(-1)?.bucket ?? '' }}</span>
              </div>
            </template>

            <template v-else-if="b.chart === 'pie'">
              <div class="flex items-center gap-4">
                <div class="w-120px h-120px rounded-full shrink-0" :style="pieStyle(results[keyOf(i)]?.groups ?? [], results[keyOf(i)]?.total ?? 0)" />
                <div class="flex-1 min-w-0">
                  <div v-for="(g, gi) in results[keyOf(i)]?.groups ?? []" :key="String(g.value)" class="flex items-center gap-2 text-13px mb-1">
                    <span class="w-8px h-8px rounded-full shrink-0" :style="{ background: PIE_COLORS[Number(gi) % PIE_COLORS.length] }" />
                    <span class="truncate">{{ g.value === null ? '（空）' : fmt(g.value) }}</span>
                    <span class="flex-1" />
                    <span class="text-[var(--muted)]">{{ g.count }} · {{ percent(g.count, results[keyOf(i)]?.total ?? 0) }}%</span>
                  </div>
                </div>
              </div>
            </template>

            <template v-else>
              <div v-for="g in results[keyOf(i)]?.groups ?? []" :key="String(g.value)" class="flex items-center gap-2 mb-2">
                <span class="w-110px truncate text-13px">{{ g.value === null ? '（空）' : fmt(g.value) }}</span>
                <div class="flex-1 h-16px rounded bg-gray-100 overflow-hidden">
                  <div class="h-full bg-blue-500" :style="{ width: percent(g.count, results[keyOf(i)]?.total ?? 0) + '%' }" />
                </div>
                <span class="w-80px text-right text-12px text-[var(--muted)]">{{ g.count }} · {{ percent(g.count, results[keyOf(i)]?.total ?? 0) }}%</span>
              </div>
            </template>
          </div>

          <!-- table -->
          <div v-else-if="b.type === 'table' && pageTable(i)" class="bg-white rounded-xl border border-[var(--border)] p-4 w-full">
            <div class="flex flex-wrap items-center gap-2 mb-3">
              <span class="font-500">{{ b.title || b.collection }}</span>
              <span class="text-12px text-[var(--muted)]">共 {{ pageTable(i)!.total }} 条</span>
              <span class="flex-1" />
              <el-button v-if="actionsOf(b).create" size="small" :disabled="!canEdit" @click="openForm(b)">
                新增
              </el-button>
              <el-button size="small" @click="exportCsv(b.collection!)">
                导出 CSV
              </el-button>
            </div>

            <div v-if="b.filters?.length || b.search" class="flex flex-wrap items-center gap-2 mb-3">
              <template v-for="f in b.filters ?? []" :key="f.field">
                <el-select
                  v-if="(f.type ?? 'select') === 'select'"
                  :model-value="pageTable(i)!.filters[f.field]"
                  size="small" clearable class="w-150px"
                  :placeholder="f.label || f.field"
                  @update:model-value="(v: any) => { setFilter(i, f.field, v); applyFilters(i) }"
                >
                  <el-option v-for="o in (f.options ?? fieldEnum(b.collection, f.field) ?? [])" :key="String(o)" :label="String(o)" :value="o" />
                </el-select>
                <el-date-picker
                  v-else-if="f.type === 'date'"
                  :model-value="pageTable(i)!.filters[f.field]"
                  type="date" size="small" class="w-150px"
                  :placeholder="f.label || f.field"
                  value-format="YYYY-MM-DD"
                  @update:model-value="(v: any) => { setFilter(i, f.field, v); applyFilters(i) }"
                />
                <el-input
                  v-else
                  :model-value="pageTable(i)!.filters[f.field]"
                  size="small" class="w-150px" clearable
                  :placeholder="f.label || f.field"
                  @update:model-value="(v: any) => setFilter(i, f.field, v)"
                  @keyup.enter="applyFilters(i)"
                  @clear="applyFilters(i)"
                />
              </template>
              <el-input
                v-if="b.search"
                :model-value="pageTable(i)!.search"
                size="small" class="w-220px" clearable
                :placeholder="b.search.placeholder || '搜索'"
                @update:model-value="(v: any) => setSearch(i, v)"
                @keyup.enter="applyFilters(i)"
                @clear="applyFilters(i)"
              >
                <template #append>
                  <el-button @click="applyFilters(i)">
                    搜索
                  </el-button>
                </template>
              </el-input>
            </div>

            <el-table v-loading="pageTable(i)!.loading" :data="pageTable(i)!.list" size="small" border max-height="520">
              <el-table-column v-for="c in columnsOf(b)" :key="c" :label="c" min-width="120" show-overflow-tooltip>
                <template #default="{ row }">
                  <el-tag v-if="fieldEnum(b.collection, c) && row[c] === undefined" size="small" type="info">
                    -
                  </el-tag>
                  <el-tag v-else-if="fieldEnum(b.collection, c)" size="small">
                    {{ fmt(row[c]) }}
                  </el-tag>
                  <span v-else>{{ fmt(row[c]) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="创建时间" width="160">
                <template #default="{ row }">
                  {{ row._createdAt ? new Date(row._createdAt).toLocaleString('zh-CN') : '' }}
                </template>
              </el-table-column>
              <el-table-column label="操作" width="150" fixed="right">
                <template #default="{ row }">
                  <el-button v-if="actionsOf(b).detail" size="small" link type="primary" @click="openDetail(b, row)">
                    详情
                  </el-button>
                  <el-button v-if="actionsOf(b).edit" size="small" link type="primary" :disabled="!canEdit" @click="openForm(b, row)">
                    编辑
                  </el-button>
                  <el-button v-if="actionsOf(b).delete" size="small" link type="danger" :disabled="!canEdit" @click="removeRow(b, row)">
                    删除
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-pagination
              v-if="pageTable(i)!.total > (b.pageSize ?? 20)"
              class="mt-3 justify-end"
              layout="prev, pager, next, total"
              :current-page="pageTable(i)!.page"
              :page-size="b.pageSize ?? 20"
              :total="pageTable(i)!.total"
              @current-change="(p: number) => changePage(i, p)"
            />
          </div>

          <!-- text -->
          <div v-else-if="b.type === 'text'" class="bg-white rounded-xl border border-[var(--border)] p-4 w-full text-13px text-[var(--muted)] whitespace-pre-wrap">
            <div v-if="b.title" class="font-500 text-[var(--text)] mb-1">
              {{ b.title }}
            </div>
            {{ b.content }}
          </div>
        </template>
      </div>
    </template>

    <el-drawer :model-value="!!detail" :title="detail?.title" size="420px" @close="detail = null">
      <div v-if="detail" class="flex flex-col gap-2">
        <div v-for="(v, k) in detail.row" :key="k" class="flex gap-3 text-13px">
          <span class="w-110px shrink-0 text-[var(--muted)]">{{ k }}</span>
          <span class="flex-1 break-all">{{ fmt(v) }}</span>
        </div>
      </div>
    </el-drawer>

    <el-dialog :model-value="!!formDialog" :title="formDialog?.id ? '编辑数据' : '新增数据'" width="560px" @close="formDialog = null">
      <template v-if="formDialog">
        <el-form label-width="90px">
          <el-form-item v-for="f in formDialog.fields" :key="f" :label="f">
            <el-select v-if="fieldEnum(formDialog.collection, f)" v-model="formDialog.model[f]" clearable class="w-full">
              <el-option v-for="o in fieldEnum(formDialog.collection, f)" :key="String(o)" :label="String(o)" :value="o" />
            </el-select>
            <el-switch v-else-if="fieldType(formDialog.collection, f) === 'boolean'" v-model="formDialog.model[f]" />
            <el-input-number v-else-if="['number', 'integer'].includes(fieldType(formDialog.collection, f))" v-model="formDialog.model[f]" class="w-full" :controls="false" />
            <el-input v-else-if="['array', 'object'].includes(fieldType(formDialog.collection, f))" v-model="formDialog.json[f]" type="textarea" :rows="4" class="font-mono" placeholder="JSON" />
            <el-input v-else v-model="formDialog.model[f]" class="w-full" />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="formDialog = null">
          取消
        </el-button>
        <el-button type="primary" @click="saveForm">
          保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editDialog" title="admin.json" width="760px">
      <div class="text-12px text-[var(--muted)] mb-2">
        可用集合：{{ Object.keys(manifest.collections ?? {}).join('、') || '无' }}。区块类型：stat / chart / table / text，详见「配置说明」。
      </div>
      <el-input v-model="draft" type="textarea" :rows="22" class="font-mono" />
      <template #footer>
        <el-button @click="editDialog = false">
          取消
        </el-button>
        <el-button type="primary" @click="saveRaw">
          保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="aiDialog" title="AI 生成后台视图" width="720px">
      <div class="text-13px text-[var(--muted)] mb-2">
        描述你要看什么、怎么筛、需要哪些操作。会基于当前 manifest 生成配置，不会直接保存。
      </div>
      <el-input
        v-model="aiInstruction"
        type="textarea"
        :rows="4"
        placeholder="例如：做一个报名管理后台。概览页看总报名数、待审核数、每日报名趋势；管理页看报名名单，能按状态和渠道筛选，能搜索姓名手机号，能改状态和删除。"
      />
      <div v-if="aiResult" class="mt-3">
        <el-alert v-if="aiResult.errors.length" type="warning" :closable="false" title="生成结果有问题">
          <div v-for="e in aiResult.errors" :key="e" class="text-13px">
            {{ e }}
          </div>
        </el-alert>
        <pre class="mt-3 max-h-300px overflow-auto bg-gray-50 rounded-lg p-3 text-12px whitespace-pre-wrap">{{ aiResult.raw }}</pre>
      </div>
      <template #footer>
        <el-button @click="aiDialog = false">
          取消
        </el-button>
        <el-button @click="useAiResult" :disabled="!aiResult">
          放到编辑器
        </el-button>
        <el-button :loading="aiLoading" @click="generate">
          生成
        </el-button>
        <el-button type="primary" :disabled="!aiResult?.view || !!aiResult?.errors.length" @click="applyAi">
          应用并保存
        </el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="docDialog" title="admin.json 配置规范" size="620px">
      <pre class="text-12px leading-6 whitespace-pre-wrap font-sans">{{ doc }}</pre>
    </el-drawer>
  </div>
</template>
