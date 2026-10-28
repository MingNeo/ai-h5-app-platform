<script setup lang="ts">
import { validateAppId } from '@app-platform/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, download } from '../api'

interface AppItem {
  appId: string
  name: string
  description: string
  status: string
  role: string
  perms: string[]
  prodBuildId: string | null
  betaBuildId: string | null
  updatedAt: string
  urls: { prod: string }
}

interface ImportSummary {
  appId: string
  name: string
  files: number
  grants: { approved: number, pending: number, skipped: string[] }
  data: { collections: number, docs: number, files: number } | null
  history: { sessions: number, turns: number, events: number } | null
  warnings: string[]
}

const router = useRouter()
const apps = ref<AppItem[]>([])
const loading = ref(true)
const keyword = ref('')
const showCreate = ref(false)
const creating = ref(false)
const form = reactive({ appId: '', name: '', description: '' })

const exportTarget = ref<AppItem | null>(null)
const dataFlags = reactive({ collections: false, files: false, kv: false })
const exporting = ref(false)
const showImport = ref(false)
const importing = ref(false)
const importFile = ref<File | null>(null)
const importAppId = ref('')
const importInput = ref<HTMLInputElement | null>(null)

const filtered = computed(() => apps.value.filter(a => !keyword.value || a.name.includes(keyword.value) || a.appId.includes(keyword.value)))
const appIdError = computed(() => form.appId ? validateAppId(form.appId) : null)
const importAppIdError = computed(() => importAppId.value ? validateAppId(importAppId.value) : null)
function slugOf(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/g, '')
  return slug.length >= 3 ? slug : ''
}
const appIdHint = computed(() => {
  const slug = slugOf(form.name)
  return slug ? `留空自动生成，如：${slug}` : '留空自动生成'
})

async function load() {
  loading.value = true
  try {
    apps.value = await api('/apps')
  }
  finally {
    loading.value = false
  }
}

async function create() {
  if (!form.name.trim())
    return ElMessage.warning('请填写应用名称')
  if (form.appId && appIdError.value)
    return ElMessage.warning(appIdError.value)
  creating.value = true
  try {
    const payload = { ...form, appId: form.appId.trim() || undefined }
    const app = await api<AppItem>('/apps', { body: payload })
    showCreate.value = false
    await router.push(`/apps/${app.appId}/develop`)
  }
  finally {
    creating.value = false
  }
}

function openExport(a: AppItem) {
  exportTarget.value = a
  dataFlags.collections = false
  dataFlags.files = false
  dataFlags.kv = false
}

const canExportData = computed(() => Boolean(exportTarget.value?.perms.includes('data.export')))

async function confirmExport() {
  const a = exportTarget.value
  if (!a)
    return
  exporting.value = true
  try {
    const parts = Object.entries(dataFlags).filter(([, on]) => on).map(([key]) => key)
    await download(`/apps/${a.appId}/export${parts.length ? `?data=${parts.join(',')}` : ''}`, `${a.appId}.app.zip`)
    exportTarget.value = null
    ElMessage.success('应用包已开始下载')
  }
  catch (e) {
    ElMessage.error((e as Error).message || '导出失败')
  }
  finally {
    exporting.value = false
  }
}

function openImport() {
  importFile.value = null
  importAppId.value = ''
  if (importInput.value)
    importInput.value.value = ''
  showImport.value = true
}

function chooseImportFile() {
  importInput.value?.click()
}

function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  importFile.value = input.files?.[0] ?? null
  importAppId.value = ''
}

async function confirmImport() {
  if (!importFile.value)
    return ElMessage.warning('请选择 .app.zip 应用包')
  if (importAppId.value && importAppIdError.value)
    return ElMessage.warning(importAppIdError.value)
  importing.value = true
  try {
    const fd = new FormData()
    fd.append('file', importFile.value)
    if (importAppId.value.trim())
      fd.append('appId', importAppId.value.trim())
    const res = await api<ImportSummary>('/apps/import', { formData: fd, quiet: true })
    showImport.value = false
    importFile.value = null
    if (importInput.value)
      importInput.value.value = ''
    await load()
    ElMessage.success(`已导入应用「${res.name}」`)
    if (res.warnings.length) {
      await ElMessageBox.alert(
        `${res.warnings.join('\n')}\n\n文件 ${res.files} 个；授权 已开通 ${res.grants.approved} / 待审批 ${res.grants.pending} / 跳过 ${res.grants.skipped.length}${res.history ? `；会话 ${res.history.sessions} 个、轮次 ${res.history.turns} 条` : ''}${res.data ? `；数据 ${res.data.docs} 条、文件 ${res.data.files} 个` : ''}`,
        '导入完成，但有提示',
        { type: 'warning' },
      ).catch(() => {})
    }
    await router.push(`/apps/${res.appId}/develop`)
  }
  catch (e) {
    ElMessage.error((e as Error).message || '导入失败')
  }
  finally {
    importing.value = false
  }
}

function statusTag(a: AppItem) {
  if (a.status === 'offline')
    return { type: 'info', text: '已下线' }
  if (a.prodBuildId)
    return { type: 'success', text: '已上线' }
  if (a.betaBuildId)
    return { type: 'warning', text: '测试中' }
  return { type: 'info', text: '开发中' }
}

onMounted(async () => {
  await load()
})
</script>

<template>
  <div class="max-w-1200px mx-auto p-6">
    <div class="flex items-center gap-3 mb-5">
      <div class="text-18px font-600 flex-1">
        我的应用
      </div>
      <el-input v-model="keyword" placeholder="搜索名称或 appId" clearable class="!w-240px" />
      <el-button @click="openImport">
        导入应用
      </el-button>
      <el-button type="primary" @click="showCreate = true">
        新建应用
      </el-button>
    </div>
    <div v-loading="loading" class="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-4 min-h-200px">
      <div
        v-for="a in filtered" :key="a.appId"
        class="bg-white rounded-xl p-4 border border-[var(--border)] cursor-pointer hover:shadow-md transition-shadow"
        @click="router.push(`/apps/${a.appId}/develop`)"
      >
        <div class="flex items-center gap-2">
          <div class="w-36px h-36px rounded-lg bg-gradient-to-br from-orange-400 to-red-500 text-white flex items-center justify-center font-600">
            {{ a.name.slice(0, 1) }}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-600 truncate">
              {{ a.name }}
            </div>
            <div class="text-12px text-[var(--muted)]">
              {{ a.appId }}
            </div>
          </div>
          <el-tag :type="statusTag(a).type as any" size="small">
            {{ statusTag(a).text }}
          </el-tag>
        </div>
        <div class="text-13px text-[var(--muted)] mt-3 h-38px overflow-hidden">
          {{ a.description || '暂无描述' }}
        </div>
        <div class="text-12px text-[var(--muted)] mt-2 flex items-center">
          <span class="flex-1">更新于 {{ new Date(a.updatedAt).toLocaleString('zh-CN') }}</span>
          <el-button v-if="a.perms.includes('app.edit')" text size="small" @click.stop="openExport(a)">
            导出
          </el-button>
        </div>
      </div>
      <el-empty v-if="!loading && !filtered.length" description="还没有应用，点击右上角新建" class="col-span-full" />
    </div>

    <el-dialog v-model="showCreate" title="新建应用" width="480px">
      <el-form label-position="top">
        <el-form-item label="应用名称" required>
          <el-input v-model="form.name" maxlength="40" placeholder="例如：春季好物投票" />
        </el-form-item>
        <el-form-item label="appId（用于访问地址，创建后不能修改）" :error="appIdError ?? ''">
          <el-input v-model="form.appId" maxlength="30" :placeholder="appIdHint">
            <template #prepend>
              /a/
            </template>
            <template #append>
              /
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="简介">
          <el-input v-model="form.description" type="textarea" maxlength="200" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">
          取消
        </el-button>
        <el-button type="primary" :loading="creating" @click="create">
          创建
        </el-button>
      </template>
    </el-dialog>

    <el-dialog :model-value="Boolean(exportTarget)" title="导出应用" width="480px" @close="exportTarget = null">
      <div v-if="exportTarget" class="flex flex-col gap-3">
        <div class="text-13px text-[var(--muted)]">
          将导出「{{ exportTarget.name }}」的全部源码、manifest、后台视图与已获批授权，生成一个可导入其他实例的 ZIP 包。
        </div>
        <div class="text-13px font-600 mt-1">
          运行数据（可选）
        </div>
        <div class="text-12px text-[var(--muted)] -mt-1">
          代码、manifest、后台视图、已获批授权和 AI 会话历史始终包含；下面只决定是否带走应用上线后由访问者产生的数据。开发时放进 public/ 的素材属于源码，已经包含，不在这里选。
        </div>
        <el-checkbox v-model="dataFlags.collections" :disabled="!canExportData">
          访问者提交的数据（集合文档）
        </el-checkbox>
        <div class="text-12px text-[var(--muted)] -mt-2 ml-6">
          普通用户访问应用页面、通过表单或 SDK 写入的业务记录，测试环境和正式环境都会导出，保留原提交者归属。
        </div>
        <el-checkbox v-model="dataFlags.files" :disabled="!canExportData">
          访问者上传的文件
        </el-checkbox>
        <div class="text-12px text-[var(--muted)] -mt-2 ml-6">
          普通用户在应用页面通过 platform.files.upload 上传的图片、音频、视频（存在 _files 里），不是开发时放进 public/ 的素材；导入后文件链接保持不变。
        </div>
        <el-checkbox v-model="dataFlags.kv" :disabled="!canExportData">
          KV 数据
        </el-checkbox>
        <div class="text-12px text-[var(--muted)] -mt-2 ml-6">
          应用级配置（运营在数据台维护）和访问者的用户键值，对应 _kv_app 与 _kv_user。
        </div>
        <div v-if="!canExportData" class="text-12px text-[var(--muted)]">
          没有「导出与同步数据」权限，只能导出代码与配置。
        </div>
      </div>
      <template #footer>
        <el-button @click="exportTarget = null">
          取消
        </el-button>
        <el-button type="primary" :loading="exporting" @click="confirmExport">
          导出
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showImport" title="导入应用" width="520px" @closed="importFile = null">
      <div class="flex flex-col gap-3">
        <div class="text-13px text-[var(--muted)]">
          选择从其他实例导出的 .app.zip 应用包。导入会创建新应用，不会覆盖已有应用。
        </div>
        <div class="flex items-center gap-2">
          <el-button @click="chooseImportFile">
            选择应用包
          </el-button>
          <span class="text-13px truncate">{{ importFile ? `${importFile.name}（${(importFile.size / 1024 / 1024).toFixed(1)}MB）` : '未选择文件' }}</span>
          <input ref="importInput" type="file" accept=".zip,application/zip" class="hidden" @change="onImportFile">
        </div>
        <el-form label-position="top">
          <el-form-item label="目标 appId（留空使用包内 appId）" :error="importAppIdError ?? ''">
            <el-input v-model="importAppId" maxlength="30" placeholder="例如：spring-vote">
              <template #prepend>
                /a/
              </template>
              <template #append>
                /
              </template>
            </el-input>
          </el-form-item>
        </el-form>
        <div class="text-12px text-[var(--muted)]">
          导入完成后应用处于「开发中」，不会自动构建或上线；成员需要重新添加。
        </div>
      </div>
      <template #footer>
        <el-button @click="showImport = false">
          取消
        </el-button>
        <el-button type="primary" :loading="importing" :disabled="!importFile" @click="confirmImport">
          导入
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
