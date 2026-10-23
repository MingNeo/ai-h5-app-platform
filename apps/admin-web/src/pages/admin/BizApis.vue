<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { type BizApiSpec, parseOpenApiText, specOperations } from '@app-platform/shared'
import { api } from '../../api'
import CodeEditor from '../../components/editor/CodeEditor.vue'

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
  operations: number
}
const list = ref<Biz[]>([])
const checking = ref(false)
const fileInput = ref<HTMLInputElement>()

interface FormState {
  id?: string
  isNew: boolean
  prefix: string
  title: string
  description: string
  docs: string
  upstream: string
  headers: string
  specText: string
}
const visible = ref(false)
const form = ref<FormState>(emptyForm())
/** 按内容判断高亮：以 { 开头当作 JSON，其余按 YAML */
const specPath = computed(() => (form.value.specText.trim().startsWith('{') ? 'openapi.json' : 'openapi.yaml'))

function emptyForm(): FormState {
  return { isNew: true, prefix: '', title: '', description: '', docs: '', upstream: '', headers: '', specText: SPEC_TEMPLATE }
}

const SPEC_TEMPLATE = `# 下面路径和参数是示例，请替换成你上游的真实接口；路径必须以「路径前缀」开头
openapi: 3.0.3
info:
  title: 优惠券
  version: 1.0.0
  description: 优惠券查询与领取
tags:
  - name: coupon
    description: 优惠券
paths:
  /api/coupon/list:
    get:
      tags: [coupon]
      operationId: listCoupons
      summary: 优惠券列表
      description: 分页返回当前用户可见的优惠券
      parameters:
        - name: page
          in: query
          description: 页码，从 1 开始
          schema:
            type: integer
            default: 1
            minimum: 1
        - name: size
          in: query
          description: 每页条数
          schema:
            type: integer
            default: 20
            maximum: 100
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CouponList'
        '401':
          description: 未登录
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
      # 可选：接口级上游覆盖目录默认值
      # x-upstream: http://other-service.internal:8080
      # 可选：对外路径与上游不同时改写（{id} 会从上面的路径参数取值）
      # x-upstream-path: /real/path/{id}
      # x-upstream-headers:
      #   X-Token: env:OTHER_TOKEN
  /api/coupon/{couponId}:
    get:
      tags: [coupon]
      operationId: getCoupon
      summary: 优惠券详情
      parameters:
        - name: couponId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Coupon'
        '404':
          description: 优惠券不存在
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /api/coupon/claim:
    post:
      tags: [coupon]
      operationId: claimCoupon
      summary: 领取优惠券
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [coupon_id]
              properties:
                coupon_id:
                  type: string
                  description: 优惠券 ID
                reason:
                  type: string
                  maxLength: 200
                  description: 领取备注
      responses:
        '200':
          description: 领取成功，返回最新信息
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Coupon'
        '400':
          description: 已领完或重复领取
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
components:
  schemas:
    Coupon:
      type: object
      properties:
        id:
          type: string
        title:
          type: string
        amount:
          type: number
          description: 面额，单位是分
        expire_at:
          type: string
          format: date-time
    CouponList:
      type: object
      properties:
        list:
          type: array
          items:
            $ref: '#/components/schemas/Coupon'
        has_more:
          type: boolean
    Error:
      type: object
      properties:
        error_code:
          type: integer
        error_msg:
          type: string
`

/** 解析该前缀下登记的接口，用于列表展开行 */
function entryOps(b: Biz) {
  const text = b.specText?.trim()
  if (!text)
    return []
  const parsed = parseOpenApiText(text)
  if (!parsed.ok)
    return []
  const spec = parsed.doc as BizApiSpec
  if (!spec || !spec.paths || typeof spec.paths !== 'object')
    return []
  return specOperations(spec)
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
        headers: b.headers ?? '',
        specText: b.specText ?? '',
      }
    : emptyForm()
  visible.value = true
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
    headers: e.headers ?? '',
    specText: e.specText,
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

onMounted(load)
</script>

<template>
  <div class="max-w-1100px mx-auto p-6">
    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="flex items-center mb-2">
        <span class="font-600 flex-1">业务接口目录</span>
        <el-button size="small" type="primary" @click="edit()">
          登记接口
        </el-button>
      </div>
      <div class="text-13px text-[var(--muted)] mb-4">
        一条记录对应一个路径前缀（通常是一个服务），授权按前缀发放；接口文档里可以登记该前缀下的多个接口。
        应用通过 platform.biz.request 调用平台同源代理，由平台服务器请求这里的上游（内网地址即可，不需要开放 CORS），主站 cookie 会转发给上游。
        文档使用 OpenAPI 3（3.0 / 3.1，YAML 或 JSON），会提供给 AI 参考、生成应用的类型声明，并在校验时检查调用路径和参数。
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
    <el-dialog v-model="visible" class="biz-api-dialog" :title="form.isNew ? '登记接口前缀' : '编辑接口前缀'" width="900px" top="5vh">
      <el-form label-width="90px">
        <el-form-item label="服务名称">
          <el-input v-model="form.title" maxlength="50" placeholder="例如：优惠券" />
        </el-form-item>
        <el-form-item label="路径前缀">
          <el-input v-model="form.prefix" placeholder="/api/coupon/（对外路径前缀，可以和真实接口不一致）" />
          <div class="text-12px text-[var(--muted)] mt-1">
            授权单位，也是应用看到的对外路径前缀。应用在 manifest 里声明、申请并获批的前缀就是它；文档里的接口必须落在前缀下面。可以和上游真实路径不同，转发时再改写。
          </div>
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.description" maxlength="500" />
        </el-form-item>
        <el-form-item label="上游地址">
          <el-input v-model="form.upstream" placeholder="http://coupon-service.internal:8080，留空则用 BIZ_API_ORIGIN" />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span class="inline-flex items-center gap-1">
              接口文档
              <el-popover trigger="click" placement="right-start" :width="420">
                <template #reference>
                  <svg class="w-3.5 h-3.5 text-[var(--muted)] cursor-pointer hover:text-[var(--el-color-primary)]" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6.6" stroke="currentColor" stroke-width="1.2" />
                    <path d="M8 4.4v4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
                  </svg>
                </template>
                <div class="text-12px leading-5">
                  <div class="font-600 mb-1">
                    接口文档填写说明
                  </div>
                  <ul class="pl-4 list-disc space-y-1">
                    <li>格式为 OpenAPI 3.0 / 3.1，YAML 或 JSON 均可，可直接导入官方导出的文件。</li>
                    <li>每条 path 必须以上面的「路径前缀」开头，否则校验不通过。</li>
                    <li>平台只读取 paths、parameters、requestBody、responses、components.schemas 和 $ref，其余字段忽略。</li>
                    <li>单个接口需要不同上游时，在该操作下加 <code>x-upstream: http://host:port</code>；需要额外请求头时加 <code>x-upstream-headers</code>，值可写 <code>env:变量名</code>。</li>
                    <li>对外路径可以自定义，不必和上游一致：在操作下加 <code>x-upstream-path: /上游真实路径</code>，平台转发时替换。多个对外接口可以指向同一个上游路径，配不同 <code>x-upstream</code> 即可。上游路径里的 <code>{id}</code> 会从对外路径的同名参数取值。</li>
                    <li>「校验」只检查文档结构和路径前缀，不会请求上游。</li>
                    <li>留空表示不提供结构化文档，AI 只能看到下面的补充说明。</li>
                    <li>登记后：AI 可查询接口文档、应用会生成类型声明、check 时核对调用路径与参数名。</li>
                  </ul>
                </div>
              </el-popover>
            </span>
          </template>
          <div class="w-full">
            <div class="flex gap-2 mb-2">
              <el-button size="small" :loading="checking" @click="validate">
                校验
              </el-button>
              <el-button size="small" @click="fileInput?.click()">
                导入文件
              </el-button>
              <span class="text-12px text-[var(--muted)] self-center">OpenAPI 3.x，YAML 或 JSON 均可，路径必须落在上面的前缀内；留空表示只有下面的补充说明</span>
              <input ref="fileInput" type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" style="display:none" @change="importFile">
            </div>
            <div class="h-[45vh] min-h-260px border border-[var(--border)] rounded overflow-hidden">
              <CodeEditor v-model="form.specText" :path="specPath" scrollbar="visible" />
            </div>
          </div>
        </el-form-item>
        <el-form-item label="补充说明">
          <el-input v-model="form.docs" type="textarea" :rows="5" placeholder="文档之外的约定，例如：返回的金额单位是分；只返回在售优惠券。" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">
          取消
        </el-button>
        <el-button type="primary" @click="save">
          保存
        </el-button>
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
