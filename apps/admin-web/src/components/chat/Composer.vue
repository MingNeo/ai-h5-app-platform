<script setup lang="ts">
import type { Attachment } from '@app-platform/shared'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { api } from '../../api'
import { useAppStore } from '../../stores/app'

const props = defineProps<{
  appId: string
  running: boolean
  disabled: boolean
  models: string[]
  visionModels: string[]
}>()
const emit = defineEmits<{
  send: [payload: { message: string, attachments: Attachment[], planMode: boolean, model: string }]
  stop: []
}>()
const model = defineModel<string>('model', { required: true })
const planMode = defineModel<boolean>('planMode', { required: true })

const store = useAppStore()
const text = ref('')
const attachments = ref<Attachment[]>([])
const picker = ref<'file' | 'collection' | 'error' | null>(null)
const pickerItems = ref<Array<{ value: string, label: string }>>([])
const picked = ref<string[]>([])
const imageInput = ref<HTMLInputElement>()

watch(() => store.pendingAttachments.length, () => {
  if (!store.pendingAttachments.length)
    return
  for (const a of store.pendingAttachments.splice(0)) {
    if (!attachments.value.some(x => x.type === a.type && x.value === a.value))
      attachments.value.push(a)
  }
  if (!text.value && attachments.value.some(a => a.type === 'error'))
    text.value = '预览里出现了下面的报错，请帮我修复'
}, { immediate: true })

const canSend = computed(() => !props.disabled && text.value.trim().length > 0)
const supportsImage = computed(() => props.visionModels.includes(model.value))

function send() {
  if (!canSend.value)
    return
  emit('send', { message: text.value.trim(), attachments: attachments.value, planMode: planMode.value, model: model.value })
  text.value = ''
  attachments.value = []
}

async function openPicker(kind: 'file' | 'collection' | 'error' | 'image') {
  if (kind === 'image') {
    imageInput.value?.click()
    return
  }
  picked.value = []
  if (kind === 'file') {
    const res = await api<{ files: Array<{ path: string }> }>(`/apps/${props.appId}/files`)
    pickerItems.value = res.files.map(f => ({ value: f.path, label: f.path }))
  }
  else if (kind === 'collection') {
    await store.load(props.appId)
    pickerItems.value = Object.keys(store.app?.manifest?.collections ?? {}).map(c => ({ value: c, label: c }))
  }
  else {
    const errors = await api<Array<{ ts: number, kind: string, message: string }>>(`/apps/${props.appId}/dev-errors`)
    pickerItems.value = errors.slice(-30).reverse().map(e => ({ value: `[${e.kind}] ${e.message}`, label: `${new Date(e.ts).toLocaleTimeString('zh-CN')} ${e.message.slice(0, 120)}` }))
  }
  if (!pickerItems.value.length) {
    ElMessage.info(kind === 'file' ? '没有文件' : kind === 'collection' ? 'manifest.json 里还没有声明数据集合' : '预览里暂时没有报错')
    return
  }
  picker.value = kind
}

function confirmPicker() {
  for (const v of picked.value) {
    const item = pickerItems.value.find(i => i.value === v)
    attachments.value.push({ type: picker.value!, value: v, label: picker.value === 'error' ? '预览报错' : item?.label })
  }
  picker.value = null
}

async function onImage(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!file)
    return
  if (!file.type.startsWith('image/'))
    return ElMessage.warning('请选择图片')
  const url = await compressImage(file)
  attachments.value.push({ type: 'image', value: url, label: file.name })
}

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(img.src)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = reject
    img.src = URL.createObjectURL(file)
  })
}

defineExpose({
  setText(t: string) {
    text.value = t
  },
})
</script>

<template>
  <div
    class="border border-[var(--border)] rounded-2xl bg-white transition-all
           shadow-[0_1px_2px_rgba(16,24,40,.04),0_3px_10px_rgba(16,24,40,.05)]
           focus-within:border-[var(--el-color-primary)]
           focus-within:shadow-[0_1px_2px_rgba(16,24,40,.04),0_0_0_3px_var(--el-color-primary-light-8)]"
  >
    <div v-if="attachments.length" class="flex flex-wrap gap-1.5 px-3 pt-2.5">
      <el-tag v-for="(a, i) in attachments" :key="i" closable type="info" @close="attachments.splice(i, 1)">
        <span v-if="a.type === 'image'" class="inline-flex items-center gap-1">
          <img :src="a.value" class="h-16px w-16px object-cover rounded">{{ a.label }}
        </span>
        <span v-else>{{ a.type === 'file' ? '📄' : a.type === 'collection' ? '🗂' : '⚠️' }} {{ (a.label || a.value).slice(0, 40) }}</span>
      </el-tag>
    </div>
    <el-input
      v-model="text"
      type="textarea"
      :autosize="{ minRows: 2, maxRows: 10 }"
      :placeholder="disabled ? '只读权限，不能发送' : '描述你想要的功能或修改，例如：做一个周末市集摊主招募页，或者直接说「做一个活动」，我来定形态'"
      :disabled="disabled"
      resize="none"
      class="composer-input"
    />
    <div class="flex items-center gap-2 px-2.5 pb-2.5">
      <el-dropdown trigger="click" :disabled="disabled" @command="openPicker">
        <el-button size="small" text :disabled="disabled">
          ＋ 引用
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="file">
              文件
            </el-dropdown-item>
            <el-dropdown-item command="collection">
              数据集合
            </el-dropdown-item>
            <el-dropdown-item command="error">
              预览报错
            </el-dropdown-item>
            <el-dropdown-item command="image">
              图片（截图 / 设计稿）{{ supportsImage ? '' : '· 当前模型不支持看图' }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-select v-model="model" size="small" class="!w-170px" :disabled="disabled">
        <el-option v-for="m in models" :key="m" :label="m" :value="m" />
      </el-select>
      <el-tooltip content="打开后 AI 先只读分析并给出方案，确认后再改代码" placement="top">
        <el-switch v-model="planMode" size="small" active-text="先出方案再改" :disabled="disabled" />
      </el-tooltip>
      <span class="flex-1" />
      <el-button v-if="running" size="small" type="danger" plain @click="emit('stop')">
        ■ 停止
      </el-button>
      <el-button size="small" type="primary" :disabled="!canSend" @click="send">
        {{ running ? '排队发送' : '发送' }}
      </el-button>
    </div>
    <input ref="imageInput" type="file" accept="image/*" class="hidden" @change="onImage">

    <el-dialog :model-value="!!picker" :title="picker === 'file' ? '引用文件' : picker === 'collection' ? '引用数据集合' : '引用预览报错'" width="560px" @close="picker = null">
      <el-checkbox-group v-model="picked" class="flex flex-col max-h-400px overflow-auto">
        <el-checkbox v-for="item in pickerItems" :key="item.value" :value="item.value" class="!mr-0 !h-auto py-1">
          <span class="text-13px break-all whitespace-normal">{{ item.label }}</span>
        </el-checkbox>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="picker = null">
          取消
        </el-button>
        <el-button type="primary" :disabled="!picked.length" @click="confirmPicker">
          引用 {{ picked.length || '' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.composer-input :deep(.el-textarea__inner) {
  box-shadow: none !important;
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.6;
}
</style>
