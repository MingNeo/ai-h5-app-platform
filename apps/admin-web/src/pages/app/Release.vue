<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import QRCode from 'qrcode'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, ApiError } from '../../api'
import { useAppStore } from '../../stores/app'

const store = useAppStore()
const appId = store.app!.appId
const canPublish = computed(() => store.can('app.publish'))

interface Issue { source: string, severity: string, message: string, file?: string, line?: number }
interface Build { id: string, status: string, issues: Issue[], sizeBytes: number, summary?: string, confirmations: string[], createdAt: string, finishedAt?: string, createdByName: string }
interface Release { id: string, buildId: string, kind: string, note: string, createdAt: string, createdByName: string }

const builds = ref<Build[]>([])
const releases = ref<Release[]>([])
const building = ref(false)
const betaQr = ref('')
const betaHost = computed(() => store.app?.urls.beta.replace(/^https:\/\//, '').replace(/\/$/, '') ?? '')
const releaseDialog = ref<Build | null>(null)
const releaseNote = ref('')
const confirmChecked = ref(false)
const releasing = ref(false)
let timer = 0

const beta = computed(() => builds.value.find(b => b.id === store.app?.betaBuildId))
const latest = computed(() => builds.value[0])
const inProgress = computed(() => builds.value.some(b => b.status === 'queued' || b.status === 'running'))

async function load() {
  const res = await api<{ builds: Build[], releases: Release[] }>(`/apps/${appId}/builds`)
  builds.value = res.builds
  releases.value = res.releases
  await store.load(appId)
  if (store.app?.betaBuildId && !betaQr.value)
    void makeQr()
}

async function makeQr() {
  const res = await api<{ url: string }>(`/apps/${appId}/preview-url`, { body: { channel: 'beta', qr: true } })
  betaQr.value = await QRCode.toDataURL(res.url, { width: 180, margin: 1 })
}

/** 票据有有效期，打开时现签一张 */
async function openBeta() {
  const res = await api<{ url: string }>(`/apps/${appId}/preview-url`, { body: { channel: 'beta' } })
  window.open(res.url, '_blank')
}

async function build() {
  building.value = true
  try {
    await api(`/apps/${appId}/builds`, { body: {} })
    ElMessage.success('已开始生成测试版')
    await load()
  }
  finally {
    building.value = false
  }
}

async function openRelease(b: Build) {
  const detail = await api<Build>(`/apps/${appId}/builds/${b.id}`)
  releaseDialog.value = detail
  releaseNote.value = ''
  confirmChecked.value = false
}

async function doRelease() {
  const b = releaseDialog.value!
  if (b.confirmations.length && !confirmChecked.value)
    return ElMessage.warning('请先确认变更')
  releasing.value = true
  try {
    await api(`/apps/${appId}/release`, { body: { buildId: b.id, note: releaseNote.value, confirmed: confirmChecked.value } })
    ElMessage.success('已上线')
    releaseDialog.value = null
    betaQr.value = ''
    await load()
  }
  catch (e) {
    if (!(e instanceof ApiError))
      throw e
  }
  finally {
    releasing.value = false
  }
}

async function rollback(r: Release) {
  await ElMessageBox.confirm(`把线上版本回滚到 ${new Date(r.createdAt).toLocaleString('zh-CN')} 发布的版本？`, '回滚', { type: 'warning' })
  await api(`/apps/${appId}/rollback`, { body: { releaseId: r.id } })
  ElMessage.success('已回滚')
  await load()
}

function statusTag(s: string) {
  return ({ queued: ['info', '排队中'], running: ['warning', '构建中'], success: ['success', '成功'], failed: ['danger', '失败'] } as Record<string, [string, string]>)[s] ?? ['info', s]
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => {
    if (inProgress.value)
      void load()
  }, 3000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="max-w-1100px mx-auto p-6 flex flex-col gap-5">
    <div class="grid grid-cols-3 gap-4">
      <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
        <div class="text-[var(--muted)] text-13px">
          草稿
        </div>
        <div class="font-600 mt-1">
          当前编辑中的代码
        </div>
        <el-button type="primary" class="mt-4" :loading="building || inProgress" :disabled="!store.canEdit()" @click="build">
          {{ inProgress ? '正在生成…' : '生成测试版' }}
        </el-button>
        <div class="text-12px text-[var(--muted)] mt-2">
          自动执行安全扫描、类型检查、构建和变更分析
        </div>
      </div>
      <div class="bg-white rounded-xl p-5 border border-[var(--border)] flex gap-3">
        <div class="flex-1">
          <div class="text-[var(--muted)] text-13px">
            测试版
          </div>
          <div v-if="beta" class="mt-1">
            <div class="font-600">
              {{ new Date(beta.createdAt).toLocaleString('zh-CN') }}
            </div>
            <div class="text-12px text-[var(--muted)]">
              {{ beta.createdByName }} · 使用测试数据
            </div>
            <el-link v-if="betaHost" type="primary" class="mt-2 text-13px" @click="openBeta">
              {{ betaHost }}
            </el-link>
            <el-button v-if="canPublish" type="success" class="mt-3" @click="openRelease(beta)">
              确认上线
            </el-button>
            <div v-else class="text-12px text-[var(--muted)] mt-3">
              需要应用负责人确认上线
            </div>
          </div>
          <div v-else class="text-[var(--muted)] mt-2 text-13px">
            还没有测试版
          </div>
        </div>
        <img v-if="betaQr" :src="betaQr" class="w-100px h-100px" title="扫码在手机上测试">
      </div>
      <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
        <div class="text-[var(--muted)] text-13px">
          线上版
        </div>
        <template v-if="store.app?.prodBuildId">
          <div class="font-600 mt-1">
            {{ releases[0] ? new Date(releases[0].createdAt).toLocaleString('zh-CN') : '' }}
          </div>
          <el-link :href="store.app.urls.prod" target="_blank" type="primary" class="mt-2 text-13px">
            {{ store.app.urls.prod }}
          </el-link>
          <div v-if="store.app.status === 'offline'" class="mt-2">
            <el-tag type="info">
              已下线（可在设置中重新上线）
            </el-tag>
          </div>
        </template>
        <div v-else class="text-[var(--muted)] mt-2 text-13px">
          尚未发布
        </div>
      </div>
    </div>

    <div v-if="latest && latest.status !== 'success'" class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="flex items-center gap-2 mb-3">
        <span class="font-600">最近一次构建</span>
        <el-tag :type="statusTag(latest.status)[0] as any" size="small">
          {{ statusTag(latest.status)[1] }}
        </el-tag>
      </div>
      <div v-for="(i, k) in latest.issues" :key="k" class="text-13px py-1 font-mono">
        <el-tag size="small" :type="i.severity === 'error' ? 'danger' : 'warning'">
          {{ i.severity === 'error' ? '错误' : '警告' }}
        </el-tag>
        {{ i.file ? `${i.file}${i.line ? `:${i.line}` : ''}` : '' }} {{ i.message }}
      </div>
      <div v-if="latest.status === 'failed'" class="text-13px text-[var(--muted)] mt-2">
        可以把这些问题复制到「开发」页让 AI 修复
      </div>
    </div>

    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        构建记录
      </div>
      <el-table :data="builds" size="small">
        <el-table-column label="时间" width="170">
          <template #default="{ row }">
            {{ new Date(row.createdAt).toLocaleString('zh-CN') }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)[0] as any" size="small">
              {{ statusTag(row.status)[1] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="检查结果">
          <template #default="{ row }">
            <span class="text-12px">{{ row.issues.filter((i: Issue) => i.severity === 'error').length }} 错误 / {{ row.issues.filter((i: Issue) => i.severity === 'warning').length }} 警告</span>
            <span v-if="row.sizeBytes" class="text-12px text-[var(--muted)] ml-2">{{ (row.sizeBytes / 1024).toFixed(0) }}KB</span>
          </template>
        </el-table-column>
        <el-table-column label="发起人" width="100" prop="createdByName" />
        <el-table-column label="" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.id === store.app?.prodBuildId" size="small" type="success">
              线上
            </el-tag>
            <el-tag v-else-if="row.id === store.app?.betaBuildId" size="small" type="warning">
              测试版
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button v-if="row.status === 'success' && canPublish && row.id !== store.app?.prodBuildId" size="small" link type="primary" @click="openRelease(row)">
              上线
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        发布记录
      </div>
      <el-table :data="releases" size="small" empty-text="暂无发布">
        <el-table-column label="时间" width="170">
          <template #default="{ row }">
            {{ new Date(row.createdAt).toLocaleString('zh-CN') }}
          </template>
        </el-table-column>
        <el-table-column label="类型" width="80">
          <template #default="{ row }">
            {{ row.kind === 'rollback' ? '回滚' : '上线' }}
          </template>
        </el-table-column>
        <el-table-column label="说明" prop="note" />
        <el-table-column label="操作人" width="100" prop="createdByName" />
        <el-table-column label="操作" width="90">
          <template #default="{ row, $index }">
            <el-button v-if="canPublish && $index > 0 && row.buildId !== store.app?.prodBuildId" size="small" link type="warning" @click="rollback(row)">
              回滚到此
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog :model-value="!!releaseDialog" title="确认上线" width="620px" @close="releaseDialog = null">
      <template v-if="releaseDialog">
        <div v-if="releaseDialog.summary" class="mb-4">
          <div class="font-600 mb-1">
            变更摘要（AI 生成）
          </div>
          <div class="text-13px whitespace-pre-wrap bg-gray-50 rounded-lg p-3">
            {{ releaseDialog.summary }}
          </div>
        </div>
        <div v-if="releaseDialog.issues.length" class="mb-4">
          <div class="font-600 mb-1">
            检查提示
          </div>
          <div v-for="(i, k) in releaseDialog.issues" :key="k" class="text-13px py-0.5">
            ⚠️ {{ i.file ? `${i.file} ` : '' }}{{ i.message }}
          </div>
        </div>
        <el-alert v-if="releaseDialog.confirmations.length" type="warning" :closable="false" class="mb-4" title="以下变更需要确认">
          <ul class="pl-4 my-1">
            <li v-for="c in releaseDialog.confirmations" :key="c">
              {{ c }}
            </li>
          </ul>
          <el-checkbox v-model="confirmChecked">
            我已了解并确认这些变更
          </el-checkbox>
        </el-alert>
        <el-input v-model="releaseNote" placeholder="上线说明（可选）" maxlength="200" />
        <div class="text-12px text-[var(--muted)] mt-2">
          上线后线上用户立即看到新版本，数据使用正式数据库；如有问题可在发布记录里一键回滚。
        </div>
      </template>
      <template #footer>
        <el-button @click="releaseDialog = null">
          取消
        </el-button>
        <el-button type="success" :loading="releasing" @click="doRelease">
          确认上线
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
