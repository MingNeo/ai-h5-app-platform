<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api, ApiError } from '../../api'
import { useAppStore } from '../../stores/app'
import DiffDialog from '../editor/DiffDialog.vue'
import EditorSkeleton from '../editor/EditorSkeleton.vue'

/** Monaco 体积大：切到代码页时才加载，期间显示骨架屏 */
const CodeEditor = defineAsyncComponent({
  loader: () => import('../editor/CodeEditor.vue'),
  loadingComponent: EditorSkeleton,
  delay: 120,
})

const props = defineProps<{ appId: string }>()
const store = useAppStore()
const canEdit = computed(() => store.canEdit())

interface FileItem { path: string, size: number, rev: number, updatedAt: string, updatedBy: string, locked: boolean }
interface TreeNode { label: string, path: string, isDir: boolean, children?: TreeNode[], locked?: boolean }

const files = ref<FileItem[]>([])
const locked = ref<Array<{ path: string }>>([])
const current = ref<string | null>(null)
const content = ref('')
const original = ref('')
const rev = ref(0)
const isText = ref(true)
const isLocked = ref(false)
const saving = ref(false)
/** 文件列表首次加载 */
const filesLoading = ref(true)
/** 正在拉取文件内容 */
const opening = ref(false)
const remoteChanged = ref(false)
const showHistory = ref(false)
const snapshots = ref<Array<{ id: string, kind: string, message: string, createdAt: string, createdBy: string }>>([])
const diffRef = ref<InstanceType<typeof DiffDialog>>()
const uploadInput = ref<HTMLInputElement>()
let pollTimer = 0

const dirty = computed(() => content.value !== original.value)
const tree = computed<TreeNode[]>(() => {
  const root: TreeNode[] = []
  const all = [...files.value.map(f => ({ path: f.path, locked: false })), ...locked.value.map(f => ({ path: f.path, locked: true }))]
  for (const f of all.sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = f.path.split('/')
    let level = root
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/')
      const isDir = i < parts.length - 1
      let node = level.find(n => n.label === part && n.isDir === isDir)
      if (!node) {
        node = { label: part, path, isDir, children: isDir ? [] : undefined, locked: !isDir && f.locked }
        level.push(node)
      }
      if (isDir)
        level = node.children!
    })
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.label.localeCompare(b.label))
    nodes.forEach(n => n.children && sort(n.children))
  }
  sort(root)
  return root
})

async function loadFiles() {
  if (!files.value.length)
    filesLoading.value = true
  try {
    const res = await api<{ files: FileItem[], locked?: Array<{ path: string }> }>(`/apps/${props.appId}/files`, { quiet: true })
    files.value = res.files ?? []
    locked.value = res.locked ?? []
    if (current.value && !isLocked.value) {
      const f = res.files.find(x => x.path === current.value)
      if (!f) {
        current.value = null
      }
      else if (f.rev !== rev.value) {
        if (dirty.value)
          remoteChanged.value = true
        else await open(f.path)
      }
    }
  }
  finally {
    filesLoading.value = false
  }
}

async function open(path: string) {
  if (dirty.value && current.value !== path) {
    try {
      await ElMessageBox.confirm('当前文件有未保存的修改，切换后会丢失，是否继续？', '未保存', { type: 'warning' })
    }
    catch {
      return
    }
  }
  opening.value = true
  try {
    const res = await api<{ path: string, rev: number, locked: boolean, encoding: string, content: string }>(`/apps/${props.appId}/files/content`, { query: { path } })
    current.value = path
    isText.value = res.encoding === 'utf8'
    isLocked.value = res.locked
    content.value = isText.value ? res.content : ''
    original.value = content.value
    rev.value = res.rev
    remoteChanged.value = false
  }
  finally {
    opening.value = false
  }
}

async function save() {
  if (!current.value || !dirty.value)
    return
  saving.value = true
  try {
    const res = await api<{ rev: number }>(`/apps/${props.appId}/files/content`, { method: 'PUT', body: { path: current.value, content: content.value, baseRev: rev.value }, quiet: true })
    rev.value = res.rev
    original.value = content.value
    remoteChanged.value = false
    ElMessage.success('已保存')
    void loadFiles()
    store.previewVersion++
  }
  catch (e) {
    if (e instanceof ApiError && e.code === 'CONFLICT') {
      await ElMessageBox.confirm(`${e.message}。要用你的版本覆盖吗？`, '保存冲突', { type: 'warning', confirmButtonText: '覆盖保存', cancelButtonText: '放弃我的修改' })
        .then(async () => {
          const res = await api<{ rev: number }>(`/apps/${props.appId}/files/content`, { method: 'PUT', body: { path: current.value, content: content.value } })
          rev.value = res.rev
          original.value = content.value
          ElMessage.success('已覆盖保存')
          store.previewVersion++
        })
        .catch(() => open(current.value!))
    }
    else {
      ElMessage.error((e as Error).message)
    }
  }
  finally {
    saving.value = false
  }
}

async function newFile() {
  const { value } = await ElMessageBox.prompt('文件路径（放在 src/ 或 public/ 下）', '新建文件', { inputValue: 'src/components/', inputPattern: /^(src|public)\/.+\.\w+$/, inputErrorMessage: '例如 src/components/Card.vue' })
  await api(`/apps/${props.appId}/files/content`, { method: 'PUT', body: { path: value, content: '' } })
  await loadFiles()
  await open(value)
  store.previewVersion++
}

async function renameFile() {
  if (!current.value)
    return
  const { value } = await ElMessageBox.prompt('新路径', '重命名 / 移动', { inputValue: current.value })
  if (value === current.value)
    return
  await api(`/apps/${props.appId}/files/move`, { body: { from: current.value, to: value } })
  current.value = value
  await loadFiles()
  store.previewVersion++
}

async function deleteFile() {
  if (!current.value)
    return
  await ElMessageBox.confirm(`删除 ${current.value}？可以在版本记录里恢复。`, '删除文件', { type: 'warning' })
  await api(`/apps/${props.appId}/files`, { method: 'DELETE', query: { path: current.value } })
  current.value = null
  original.value = content.value = ''
  await loadFiles()
  store.previewVersion++
}

async function onUpload(e: Event) {
  const list = (e.target as HTMLInputElement).files
  if (!list?.length)
    return
  const fd = new FormData()
  fd.append('dir', 'public/images')
  for (const f of Array.from(list))
    fd.append('file', f)
  ;(e.target as HTMLInputElement).value = ''
  const res = await api<{ paths: string[] }>(`/apps/${props.appId}/files/upload`, { formData: fd })
  ElMessage.success(`已上传 ${res.paths.length} 个素材，在代码里用 /${res.paths[0]?.replace(/^public\//, '')} 引用`)
  await loadFiles()
}

async function loadHistory() {
  snapshots.value = await api(`/apps/${props.appId}/snapshots`)
  showHistory.value = true
}

async function saveVersion() {
  const { value } = await ElMessageBox.prompt('版本说明', '保存版本', { inputValue: '手动保存' })
  await api(`/apps/${props.appId}/snapshots`, { body: { message: value } })
  ElMessage.success('已保存版本')
  if (showHistory.value)
    snapshots.value = await api(`/apps/${props.appId}/snapshots`)
}

async function restore(id: string, message: string) {
  await ElMessageBox.confirm(`把全部代码恢复到「${message}」？当前代码会先自动保存为一个版本。`, '恢复版本', { type: 'warning' })
  await api(`/apps/${props.appId}/snapshots`, { body: { message: '恢复前自动保存' } })
  await api(`/apps/${props.appId}/snapshots/${id}/restore`, { body: {} })
  ElMessage.success('已恢复')
  store.filesVersion++
  store.previewVersion++
  snapshots.value = await api(`/apps/${props.appId}/snapshots`)
}

function compare(id: string) {
  diffRef.value?.show({ from: id, to: 'draft', paths: files.value.map(f => f.path), path: current.value ?? undefined, title: '与当前代码对比' })
}

const KIND_LABEL: Record<string, string> = { init: '创建', ai: 'AI 修改', manual: '手动保存', rollback: '回滚', interrupted: 'AI（中断）', build: '生成测试版' }

watch(() => store.filesVersion, () => void loadFiles())
onMounted(() => {
  void loadFiles()
  pollTimer = window.setInterval(() => {
    if (!document.hidden)
      void loadFiles()
  }, 5000)
})
onBeforeUnmount(() => clearInterval(pollTimer))
</script>

<template>
  <div class="h-full flex">
    <div class="w-210px shrink-0 border-r border-[var(--border)] bg-white flex flex-col">
      <div class="flex gap-1 p-2 border-b border-[var(--border)]">
        <el-button size="small" :disabled="!canEdit" @click="newFile">
          新建
        </el-button>
        <el-button size="small" :disabled="!canEdit" @click="uploadInput?.click()">
          上传素材
        </el-button>
        <el-button size="small" @click="loadHistory">
          版本
        </el-button>
      </div>
      <div v-if="filesLoading && !files.length" class="flex-1 p-3">
        <div class="animate-pulse flex flex-col gap-2.5">
          <div v-for="(w, i) in ['76%', '52%', '64%', '88%', '44%', '70%']" :key="i" class="h-3 rounded bg-[var(--border)]" :style="{ width: w }" />
        </div>
      </div>
      <el-tree
        v-else
        :data="tree" node-key="path" :props="{ label: 'label', children: 'children' }"
        :current-node-key="current ?? undefined" highlight-current default-expand-all :expand-on-click-node="true"
        class="flex-1 overflow-auto scroll-thin text-13px py-1"
        @node-click="(n: TreeNode) => !n.isDir && open(n.path)"
      >
        <template #default="{ data }">
          <span class="truncate" :class="{ 'text-[var(--muted)]': data.locked }">{{ data.isDir ? '📁' : '' }} {{ data.label }}{{ data.locked ? ' 🔒' : '' }}</span>
        </template>
      </el-tree>
      <input ref="uploadInput" type="file" multiple accept="image/*,audio/*,video/mp4" class="hidden" @change="onUpload">
    </div>
    <div class="flex-1 min-w-0 flex flex-col">
      <template v-if="current">
        <div class="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-white text-13px">
          <span class="font-mono truncate">{{ current }}</span>
          <el-tag v-if="isLocked" size="small" type="info">
            平台锁定，只读
          </el-tag>
          <span v-if="dirty" class="text-orange-500">● 未保存</span>
          <span class="flex-1" />
          <el-button v-if="!isLocked && canEdit" size="small" text @click="renameFile">
            重命名
          </el-button>
          <el-button v-if="!isLocked && canEdit" size="small" text type="danger" @click="deleteFile">
            删除
          </el-button>
          <el-button v-if="!isLocked && canEdit" size="small" type="primary" :disabled="!dirty" :loading="saving" @click="save">
            保存
          </el-button>
        </div>
        <el-alert v-if="remoteChanged" type="warning" :closable="false" show-icon>
          <template #title>
            该文件已被 AI 或其他人修改。
            <el-button size="small" link type="primary" @click="original = content; open(current!)">
              放弃我的修改并重新加载
            </el-button>
          </template>
        </el-alert>
        <EditorSkeleton v-if="opening" class="flex-1 min-h-0" label="正在加载文件…" />
        <div v-else-if="!isText" class="flex-1 flex items-center justify-center text-[var(--muted)]">
          二进制文件，不能在线编辑
        </div>
        <CodeEditor v-else v-model="content" :path="current" :readonly="isLocked || !canEdit" class="flex-1 min-h-0" />
      </template>
      <EditorSkeleton v-else-if="opening || filesLoading" class="flex-1 min-h-0" />
      <div v-else class="flex-1 flex items-center justify-center text-[var(--muted)]">
        在左侧选择文件
      </div>
    </div>

    <el-drawer v-model="showHistory" title="版本记录" size="420px">
      <el-button class="mb-3" :disabled="!canEdit" @click="saveVersion">
        保存当前版本
      </el-button>
      <el-timeline>
        <el-timeline-item v-for="s in snapshots" :key="s.id" :timestamp="`${new Date(s.createdAt).toLocaleString('zh-CN')} · ${s.createdBy}`">
          <div class="flex items-start gap-2">
            <div class="flex-1">
              <el-tag size="small" class="mr-1">
                {{ KIND_LABEL[s.kind] ?? s.kind }}
              </el-tag>
              <span class="text-13px">{{ s.message }}</span>
            </div>
          </div>
          <div class="mt-1">
            <el-button size="small" link @click="compare(s.id)">
              对比
            </el-button>
            <el-button v-if="canEdit" size="small" link type="primary" @click="restore(s.id, s.message)">
              恢复到此版本
            </el-button>
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-drawer>
    <DiffDialog ref="diffRef" :app-id="appId" />
  </div>
</template>
