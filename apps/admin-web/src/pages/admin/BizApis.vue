<script setup lang="ts">
import type { BizOpForm, BizOperation, HttpMethod, OpFormFlags } from '@app-platform/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { emptyOpForm, HTTP_METHODS, normalizeOpenApi, opToForm, parseOpenApiText, removeOperation, specOperations, upsertOperation } from '@app-platform/shared'
import { api } from '../../api'
import CodeEditor from '../../components/editor/CodeEditor.vue'
import FieldRows from '../../components/biz/FieldRows.vue'
import HeaderRows, { type HeaderRow } from '../../components/biz/HeaderRows.vue'

interface Biz {
  id: string
  prefix: string
  title: string
  description: string
  docs: string
  /** 文档原文（YAML / JSON） */
  specText?: string
  /** 目录默认上游地址 */
  upstream?: string
  /** 目录默认请求头 JSON 文本 */
  headers?: string
  /** 已登记的密钥名（值从不下发） */
  secretNames?: string[]
  operations: number
}
const list = ref<Biz[]>([])
const checking = ref(false)
const fileInput = ref<HTMLInputElement>()
const activeTab = ref('basic')

interface FormState {
  id?: string
  isNew: boolean
  prefix: string
  title: string
  description: string
  docs: string
  upstream: string
  specText: string
}
const visible = ref(false)
const form = ref<FormState>(emptyForm())
const catalogHeaderRows = ref<HeaderRow[]>([])

interface SecretRow { name: string, status: 'kept' | 'new' | 'updated' | 'deleted' }
const secretRows = ref<SecretRow[]>([])
const secretsPatch = ref<Record<string, string | null>>({})
const newSecretName = ref('')
const newSecretValue = ref('')
/** 本次编辑里还有效的密钥名，供请求头下拉引用 */
const availableSecretNames = computed(() => secretRows.value.filter(r => r.status !== 'deleted').map(r => r.name))

/** 按内容判断高亮：以 { 开头当作 JSON，其余按 YAML */
const specPath = computed(() => (form.value.specText.trim().startsWith('{') ? 'openapi.json' : 'openapi.yaml'))

function emptyForm(): FormState {
  return { isNew: true, prefix: '', title: '', description: '', docs: '', upstream: '', specText: '' }
}

const SPEC_TEMPLATE = `openapi: 3.0.3
info:
  title: 优惠券
  version: 1.0.0
paths:
  /api/coupon/list:
    get:
      summary: 优惠券列表
      parameters:
        - name: page
          in: query
          schema: { type: integer, default: 1 }
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  list:
                    type: array
                    items: { type: object }
`

function headersTextToRows(text: string): HeaderRow[] {
  if (!text.trim())
    return []
  try {
    const obj = JSON.parse(text) as Record<string, string>
    return Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }))
  }
  catch {
    return []
  }
}
function rowsToHeadersText(rows: HeaderRow[]): string {
  const obj: Record<string, string> = {}
  for (const r of rows) {
    if (r.name.trim())
      obj[r.name.trim()] = r.value
  }
  return Object.keys(obj).length ? JSON.stringify(obj, null, 2) : ''
}

/** 解析该前缀下登记的接口，用于列表展开行（读的是已保存的 specText） */
function entryOps(b: Biz) {
  const text = b.specText?.trim()
  if (!text)
    return []
  const parsed = parseOpenApiText(text)
  if (!parsed.ok || !parsed.doc || typeof parsed.doc !== 'object')
    return []
  return specOperations(parsed.doc as any)
}

/** 当前编辑弹窗里的文档（宽松解析，不要求已经满足前缀等约束，仅用于渲染接口列表） */
const parsedDoc = computed(() => {
  const text = form.value.specText.trim()
  if (!text)
    return undefined
  const parsed = parseOpenApiText(text)
  if (!parsed.ok || !parsed.doc || typeof parsed.doc !== 'object')
    return undefined
  const doc = parsed.doc as any
  if (!doc.paths || typeof doc.paths !== 'object')
    return undefined
  return doc
})
const specError = computed(() => {
  const text = form.value.specText.trim()
  if (!text)
    return ''
  const parsed = parseOpenApiText(text)
  if (!parsed.ok)
    return parsed.errors[0]!
  if (!parsedDoc.value)
    return '文档需要是包含 paths 的对象'
  return ''
})
const operations = computed<BizOperation[]>(() => (parsedDoc.value ? specOperations(parsedDoc.value) : []))

function rawOpOf(method: HttpMethod, path: string) {
  const item = parsedDoc.value?.paths?.[path]
  return item && typeof item[method] === 'object' ? item[method] as Record<string, unknown> : undefined
}
function pathItemHasParams(path: string) {
  const item = parsedDoc.value?.paths?.[path]
  return Boolean(item && Array.isArray(item.parameters) && item.parameters.length)
}

async function load() {
  list.value = (await api<{ bizApis: Biz[] }>('/catalog')).bizApis
}

function edit(b?: Biz) {
  form.value = b
    ? {
        id: b.id,
        isNew: false,
        prefix: b.prefix,
        title: b.title,
        description: b.description ?? '',
        docs: b.docs ?? '',
        upstream: b.upstream ?? '',
        specText: b.specText ?? '',
      }
    : emptyForm()
  catalogHeaderRows.value = headersTextToRows(b?.headers ?? '')
  secretRows.value = (b?.secretNames ?? []).map(name => ({ name, status: 'kept' as const }))
  secretsPatch.value = {}
  newSecretName.value = ''
  newSecretValue.value = ''
  activeTab.value = 'basic'
  visible.value = true
}

function addSecret() {
  const name = newSecretName.value.trim()
  if (!/^\w{1,64}$/.test(name))
    return ElMessage.warning('密钥名只能是字母、数字、下划线')
  if (!newSecretValue.value.trim())
    return ElMessage.warning('请输入密钥值')
  if (secretRows.value.some(r => r.name === name && r.status !== 'deleted'))
    return ElMessage.warning('密钥名已存在')
  secretsPatch.value[name] = newSecretValue.value
  secretRows.value.push({ name, status: 'new' })
  newSecretName.value = ''
  newSecretValue.value = ''
}
async function replaceSecret(row: SecretRow) {
  try {
    const { value } = await ElMessageBox.prompt(`输入「${row.name}」的新值`, '替换密钥', { inputType: 'password', confirmButtonText: '确定', cancelButtonText: '取消' })
    if (!value.trim())
      return ElMessage.warning('值不能为空')
    secretsPatch.value[row.name] = value
    if (row.status === 'kept')
      row.status = 'updated'
  }
  catch {}
}
function deleteSecret(row: SecretRow) {
  if (row.status === 'new') {
    secretRows.value = secretRows.value.filter(r => r !== row)
    delete secretsPatch.value[row.name]
  }
  else {
    secretsPatch.value[row.name] = null
    row.status = 'deleted'
  }
}
function undoDeleteSecret(row: SecretRow) {
  delete secretsPatch.value[row.name]
  row.status = 'kept'
}

async function validate() {
  const e = form.value
  checking.value = true
  try {
    const res = await api<{ operations: number }>('/biz-apis/validate', { body: { prefix: e.prefix, specText: e.specText }, quiet: true })
    ElMessage.success(e.specText.trim() ? `文档有效，共 ${res.operations} 个接口` : '已清空接口文档')
  }
  catch (err) {
    ElMessage.error((err as Error).message)
  }
  finally {
    checking.value = false
  }
}

function fillExample() {
  if (form.value.specText.trim()) {
    ElMessageBox.confirm('会覆盖当前文档内容，确定填入示例吗？', '提示', { type: 'warning' }).then(() => {
      form.value.specText = SPEC_TEMPLATE
    }).catch(() => {})
    return
  }
  form.value.specText = SPEC_TEMPLATE
}

async function save() {
  const e = form.value
  if (!e.prefix.trim())
    return ElMessage.warning('请填写路径前缀，例如 /api/coupon/')
  const body = {
    prefix: e.prefix,
    title: e.title,
    description: e.description ?? '',
    docs: e.docs ?? '',
    upstream: e.upstream ?? '',
    headers: rowsToHeadersText(catalogHeaderRows.value),
    specText: e.specText,
    ...(Object.keys(secretsPatch.value).length ? { secrets: secretsPatch.value } : {}),
  }
  if (e.isNew)
    await api('/biz-apis', { body })
  else await api(`/biz-apis/${e.id}`, { method: 'PUT', body })
  ElMessage.success('已保存')
  visible.value = false
  await load()
}

async function importFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file)
    return
  form.value.specText = await file.text()
  ;(ev.target as HTMLInputElement).value = ''
  await validate()
}

async function remove(b: Biz) {
  await ElMessageBox.confirm(`删除 ${b.title}？已授权的应用会失去访问权限。`, '删除', { type: 'warning' })
  await api(`/biz-apis/${b.id}`, { method: 'DELETE' })
  await load()
}

// ---------- 单条接口表单 ----------
const opDialogVisible = ref(false)
const opOriginal = ref<{ method: HttpMethod, path: string } | null>(null)
const opForm = ref<BizOpForm>(emptyOpForm())
const opFlags = ref<OpFormFlags>({ paramsEditable: true, bodyEditable: true, responseEditable: true })

function openOpDialog(original: { method: HttpMethod, path: string } | null) {
  if (original) {
    const raw = rawOpOf(original.method, original.path)
    const { form: f, flags } = opToForm(original.method, original.path, raw, pathItemHasParams(original.path))
    opForm.value = f
    opFlags.value = flags
  }
  else {
    opForm.value = emptyOpForm(form.value.prefix)
    opFlags.value = { paramsEditable: true, bodyEditable: true, responseEditable: true }
  }
  opOriginal.value = original
  opDialogVisible.value = true
}

function saveOp() {
  const res = upsertOperation(form.value.specText, opOriginal.value, opForm.value, opFlags.value)
  if (!res.ok)
    return ElMessage.error(res.errors[0])
  const parsed = parseOpenApiText(res.specText)
  if (parsed.ok) {
    const norm = normalizeOpenApi(parsed.doc, form.value.prefix || '/')
    if (!norm.ok)
      return ElMessage.error(norm.errors[0])
  }
  form.value.specText = res.specText
  opDialogVisible.value = false
  ElMessage.success('已加入接口列表，记得点下面的「保存」')
}

async function removeOp(method: HttpMethod, path: string) {
  await ElMessageBox.confirm(`删除 ${method.toUpperCase()} ${path}？`, '删除', { type: 'warning' })
  const res = removeOperation(form.value.specText, method, path)
  if (!res.ok)
    return ElMessage.error(res.errors[0])
  form.value.specText = res.specText
}

// ---------- 连通性测试 ----------
const testVisible = ref(false)
const testOp = ref<BizOperation | null>(null)
const testPathParams = ref<Record<string, string>>({})
const testQuery = ref<{ key: string, value: string }[]>([])
const testBody = ref('')
const testCookie = ref('')
const testing = ref(false)
interface TestResult { ok: boolean, status?: number, durationMs?: number, contentType?: string, body?: string, truncated?: boolean, error?: string, url?: string }
const testResult = ref<TestResult | null>(null)

function pathParamNames(path: string) {
  return [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]!)
}

function openTest(op: BizOperation) {
  testOp.value = op
  testPathParams.value = Object.fromEntries(pathParamNames(op.path).map(n => [n, '']))
  testQuery.value = op.parameters.filter(p => p.in === 'query').map(p => ({ key: p.name, value: '' }))
  const bodyProps = op.requestBody?.schema?.properties
  testBody.value = bodyProps ? JSON.stringify(Object.fromEntries(Object.keys(bodyProps).map(k => [k, ''])), null, 2) : ''
  testCookie.value = ''
  testResult.value = null
  testVisible.value = true
}
function addTestQuery() {
  testQuery.value.push({ key: '', value: '' })
}
function removeTestQuery(i: number) {
  testQuery.value = testQuery.value.filter((_, idx) => idx !== i)
}

async function runTest() {
  if (!testOp.value)
    return
  testing.value = true
  testResult.value = null
  try {
    const res = await api<TestResult>('/biz-apis/test', {
      body: {
        id: form.value.id,
        prefix: form.value.prefix,
        upstream: form.value.upstream,
        headers: rowsToHeadersText(catalogHeaderRows.value),
        specText: form.value.specText,
        method: testOp.value.method,
        path: testOp.value.path,
        pathParams: testPathParams.value,
        query: Object.fromEntries(testQuery.value.filter(q => q.key.trim()).map(q => [q.key.trim(), q.value])),
        body: testBody.value,
        cookie: testCookie.value,
      },
      quiet: true,
    })
    testResult.value = res
  }
  catch (err) {
    testResult.value = { ok: false, error: (err as Error).message }
  }
  finally {
    testing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="max-w-1100px mx-auto p-6">
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="flex items-center mb-2">
        <span class="font-600 flex-1">业务接口目录</span>
        <el-button size="small" type="primary" @click="edit()">
          登记服务
        </el-button>
      </div>
      <div class="text-13px text-[var(--muted)] mb-4">
        一条记录对应一个路径前缀（通常是一个服务），授权按前缀发放；一个服务下面可以登记多条接口。
        应用通过 platform.biz.request 调用平台同源代理，由平台服务器请求这里的上游（内网地址即可，不需要开放 CORS），主站 cookie 会转发给上游。
        底层按 OpenAPI 3 存储，会提供给 AI 参考、生成应用的类型声明，并在校验时检查调用路径和参数。
      </div>
      <el-table :data="list" size="small" empty-text="还没有登记接口" row-key="prefix">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="px-8 py-2">
              <div v-if="!entryOps(row).length" class="text-12px text-[var(--muted)]">
                还没有可解析的接口文档
              </div>
              <div v-for="op in entryOps(row)" :key="`${op.method} ${op.path}`" class="flex items-center gap-2 py-1 text-12px">
                <el-tag size="small" :type="op.method === 'get' ? 'success' : op.method === 'delete' ? 'danger' : 'warning'">
                  {{ op.method.toUpperCase() }}
                </el-tag>
                <span class="font-mono">{{ op.path }}</span>
                <span v-if="op.upstreamPath && op.upstreamPath !== op.path" class="font-mono text-[var(--muted)]">→ {{ op.upstreamPath }}</span>
                <span class="text-[var(--muted)]">{{ op.summary }}</span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="服务名称" prop="title" width="180" />
        <el-table-column label="路径前缀（授权单位）" width="260">
          <template #default="{ row }">
            <span class="font-mono">{{ row.prefix }}</span>
          </template>
        </el-table-column>
        <el-table-column label="上游" width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="font-mono text-12px">{{ row.upstream || 'BIZ_API_ORIGIN' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="接口数" width="80">
          <template #default="{ row }">
            <span :class="row.operations ? '' : 'text-[var(--muted)]'">{{ row.operations || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="说明" prop="description" show-overflow-tooltip />
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="edit(row)">
              编辑
            </el-button>
            <el-button size="small" link type="danger" @click="remove(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="visible" class="biz-api-dialog" :title="form.isNew ? '登记服务' : '编辑服务'" width="920px" top="5vh">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="基本信息" name="basic">
          <el-form label-width="90px">
            <el-form-item label="服务名称">
              <el-input v-model="form.title" maxlength="50" placeholder="例如：优惠券" />
            </el-form-item>
            <el-form-item label="路径前缀">
              <el-input v-model="form.prefix" placeholder="/api/coupon/（对外路径前缀，可以和真实接口不一致）" />
              <div class="text-12px text-[var(--muted)] mt-1">
                授权单位，也是应用看到的对外路径前缀。应用在 manifest 里声明、申请并获批的前缀就是它；接口必须落在前缀下面。可以和上游真实路径不同，转发时再改写。
              </div>
            </el-form-item>
            <el-form-item label="说明">
              <el-input v-model="form.description" maxlength="500" />
            </el-form-item>
            <el-form-item label="上游地址">
              <el-input v-model="form.upstream" placeholder="http://coupon-service.internal:8080，留空则用 BIZ_API_ORIGIN" />
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="密钥" name="secrets">
          <div class="text-12px text-[var(--muted)] mb-3">
            服务令牌等敏感值存在这里，值只写不回显；请求头里用 secret:名字 引用。明文密钥不能直接写在请求头里。
          </div>
          <div v-for="row in secretRows" :key="row.name" class="flex items-center gap-2 py-1 text-13px">
            <span class="font-mono flex-1" :class="row.status === 'deleted' ? 'line-through text-[var(--muted)]' : ''">{{ row.name }}</span>
            <el-tag v-if="row.status === 'new'" size="small" type="success">
              新增
            </el-tag>
            <el-tag v-else-if="row.status === 'updated'" size="small" type="warning">
              将更新
            </el-tag>
            <el-tag v-else-if="row.status === 'deleted'" size="small" type="danger">
              将删除
            </el-tag>
            <el-tag v-else size="small">
              已设置
            </el-tag>
            <el-button v-if="row.status !== 'deleted'" size="small" link @click="replaceSecret(row)">
              替换
            </el-button>
            <el-button v-if="row.status !== 'deleted'" size="small" link type="danger" @click="deleteSecret(row)">
              删除
            </el-button>
            <el-button v-else size="small" link @click="undoDeleteSecret(row)">
              撤销
            </el-button>
          </div>
          <div class="flex items-center gap-2 mt-3">
            <el-input v-model="newSecretName" placeholder="密钥名，如 coupon_token" size="small" class="w-200px" />
            <el-input v-model="newSecretValue" placeholder="密钥值" size="small" class="flex-1" show-password />
            <el-button size="small" @click="addSecret">
              + 添加
            </el-button>
          </div>
        </el-tab-pane>

        <el-tab-pane label="目录请求头" name="headers">
          <div class="text-12px text-[var(--muted)] mb-3">
            所有接口默认都会带上这些请求头，单条接口可以在「接口」里覆盖。
          </div>
          <HeaderRows v-model="catalogHeaderRows" :secret-names="availableSecretNames" />
        </el-tab-pane>

        <el-tab-pane name="ops">
          <template #label>
            接口 <el-badge :value="operations.length" v-if="operations.length" class="ml-1" />
          </template>
          <div v-if="specError" class="text-12px text-red-500 mb-2">
            文档有误：{{ specError }}，请先在「YAML（高级）」标签页修正
          </div>
          <div class="flex justify-end mb-2">
            <el-button size="small" type="primary" :disabled="!!specError" @click="openOpDialog(null)">
              + 添加接口
            </el-button>
          </div>
          <div v-if="!operations.length" class="text-12px text-[var(--muted)] py-4 text-center">
            还没有登记接口
          </div>
          <div v-for="op in operations" :key="`${op.method} ${op.path}`" class="flex items-center gap-2 py-2 border-b border-[var(--border)] text-13px">
            <el-tag size="small" :type="op.method === 'get' ? 'success' : op.method === 'delete' ? 'danger' : 'warning'">
              {{ op.method.toUpperCase() }}
            </el-tag>
            <span class="font-mono">{{ op.path }}</span>
            <span class="text-12px text-[var(--muted)] flex-1">{{ op.summary }}</span>
            <el-button size="small" link @click="openTest(op)">
              测试
            </el-button>
            <el-button size="small" link type="primary" @click="openOpDialog({ method: op.method, path: op.path })">
              编辑
            </el-button>
            <el-button size="small" link type="danger" @click="removeOp(op.method, op.path)">
              删除
            </el-button>
          </div>
        </el-tab-pane>

        <el-tab-pane label="补充说明" name="docs">
          <el-input v-model="form.docs" type="textarea" :rows="8" placeholder="文档之外的约定，例如：返回的金额单位是分；只返回在售优惠券。" />
        </el-tab-pane>

        <el-tab-pane label="YAML（高级）" name="yaml">
          <div class="flex gap-2 mb-2">
            <el-button size="small" :loading="checking" @click="validate">
              校验
            </el-button>
            <el-button size="small" @click="fileInput?.click()">
              导入文件
            </el-button>
            <el-button size="small" @click="fillExample">
              填入示例
            </el-button>
            <span class="text-12px text-[var(--muted)] self-center">OpenAPI 3.x，YAML 或 JSON 均可，路径必须落在上面的前缀内；留空表示只有「补充说明」</span>
            <input ref="fileInput" type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" style="display:none" @change="importFile">
          </div>
          <div class="h-[45vh] min-h-260px border border-[var(--border)] rounded overflow-hidden">
            <CodeEditor v-model="form.specText" :path="specPath" scrollbar="visible" />
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="visible = false">
          取消
        </el-button>
        <el-button type="primary" @click="save">
          保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="opDialogVisible" :title="opOriginal ? '编辑接口' : '添加接口'" width="760px" top="5vh" append-to-body>
      <el-form label-width="90px">
        <div class="flex gap-2">
          <el-form-item label="方法" class="w-130px">
            <el-select v-model="opForm.method">
              <el-option v-for="m in HTTP_METHODS" :key="m" :label="m.toUpperCase()" :value="m" />
            </el-select>
          </el-form-item>
          <el-form-item label="路径" class="flex-1">
            <el-input v-model="opForm.path" placeholder="/api/coupon/list" />
          </el-form-item>
        </div>
        <el-form-item label="摘要">
          <el-input v-model="opForm.summary" maxlength="100" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="opForm.description" type="textarea" :rows="2" />
        </el-form-item>
        <el-form-item label="参数">
          <FieldRows v-if="opFlags.paramsEditable" v-model="opForm.params" show-in />
          <div v-else class="text-12px text-[var(--muted)]">
            参数包含复杂类型（枚举、数组、$ref 等），请到「YAML（高级）」标签页编辑
          </div>
        </el-form-item>
        <el-form-item v-if="opForm.method !== 'get'" label="请求体">
          <FieldRows v-if="opFlags.bodyEditable" v-model="opForm.body" />
          <div v-else class="text-12px text-[var(--muted)]">
            请求体结构复杂，请到「YAML（高级）」标签页编辑
          </div>
        </el-form-item>
        <el-form-item label="返回字段">
          <FieldRows v-if="opFlags.responseEditable" v-model="opForm.response" />
          <div v-else class="text-12px text-[var(--muted)]">
            200 返回结构复杂，请到「YAML（高级）」标签页编辑
          </div>
        </el-form-item>
        <el-collapse>
          <el-collapse-item title="转发设置（可选，不填用目录默认值）">
            <el-form-item label="覆盖上游">
              <el-input v-model="opForm.upstream" placeholder="留空用目录默认上游" />
            </el-form-item>
            <el-form-item label="改写路径">
              <el-input v-model="opForm.upstreamPath" placeholder="对外路径和上游路径不同时填，例如 /internal/{id}" />
            </el-form-item>
            <el-form-item label="请求头">
              <HeaderRows v-model="opForm.headers" :secret-names="availableSecretNames" />
            </el-form-item>
          </el-collapse-item>
        </el-collapse>
      </el-form>
      <template #footer>
        <el-button @click="opDialogVisible = false">
          取消
        </el-button>
        <el-button type="primary" @click="saveOp">
          确定
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="testVisible" title="测试连通性" width="640px" append-to-body>
      <template v-if="testOp">
        <div class="text-13px mb-3">
          <el-tag size="small" class="mr-1">
            {{ testOp.method.toUpperCase() }}
          </el-tag>
          <span class="font-mono">{{ testOp.path }}</span>
        </div>
        <el-alert v-if="!form.id" type="warning" :closable="false" class="mb-3" title="还没保存过，secret: 引用暂时不会生效，建议先保存一次再测试" />
        <div v-if="Object.keys(testPathParams).length" class="mb-3">
          <div class="text-12px text-[var(--muted)] mb-1">
            路径参数
          </div>
          <div v-for="k in Object.keys(testPathParams)" :key="k" class="flex items-center gap-2 mb-1">
            <span class="font-mono text-12px w-100px">{{ k }}</span>
            <el-input v-model="testPathParams[k]" size="small" />
          </div>
        </div>
        <div class="mb-3">
          <div class="text-12px text-[var(--muted)] mb-1">
            Query 参数
          </div>
          <div v-for="(q, i) in testQuery" :key="i" class="flex items-center gap-2 mb-1">
            <el-input v-model="q.key" placeholder="key" size="small" class="w-150px" />
            <el-input v-model="q.value" placeholder="value" size="small" class="flex-1" />
            <el-button size="small" link type="danger" @click="removeTestQuery(i)">
              删除
            </el-button>
          </div>
          <el-button size="small" @click="addTestQuery">
            + 添加参数
          </el-button>
        </div>
        <div v-if="testOp.method !== 'get'" class="mb-3">
          <div class="text-12px text-[var(--muted)] mb-1">
            请求体（JSON）
          </div>
          <el-input v-model="testBody" type="textarea" :rows="4" />
        </div>
        <el-form-item label="Cookie" label-width="60px">
          <el-input v-model="testCookie" placeholder="需要登录态的接口可以手填主站 cookie" />
        </el-form-item>
        <el-button type="primary" :loading="testing" @click="runTest">
          发送
        </el-button>
        <div v-if="testResult" class="mt-4 border border-[var(--border)] rounded p-3 text-13px">
          <template v-if="testResult.ok">
            <div class="flex items-center gap-2 mb-2">
              <el-tag size="small" :type="testResult.status && testResult.status < 400 ? 'success' : 'danger'">
                {{ testResult.status }}
              </el-tag>
              <span class="text-12px text-[var(--muted)]">{{ testResult.durationMs }}ms · {{ testResult.contentType }}</span>
              <span v-if="testResult.truncated" class="text-12px text-orange-500">响应体过大，已截断</span>
            </div>
            <pre class="text-12px bg-[var(--bg-soft)] p-2 rounded max-h-300px overflow-auto whitespace-pre-wrap break-all">{{ testResult.body }}</pre>
          </template>
          <template v-else>
            <span class="text-red-500">{{ testResult.error }}</span>
          </template>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
:deep(.biz-api-dialog) {
  display: flex;
  flex-direction: column;
  max-height: 90vh;
}
:deep(.biz-api-dialog .el-dialog__body) {
  overflow-y: auto;
  min-height: 0;
}
</style>
