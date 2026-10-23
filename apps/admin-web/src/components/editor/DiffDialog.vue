<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { api } from '../../api'
import { languageOf, monaco } from './monaco'

const props = defineProps<{ appId: string }>()
const visible = ref(false)
const title = ref('')
const files = ref<string[]>([])
const current = ref('')
const refs = ref<{ from: string, to: string }>({ from: '', to: 'draft' })
const el = ref<HTMLDivElement>()
const editor = shallowRef<monaco.editor.IStandaloneDiffEditor>()
const loading = ref(false)

async function show(opts: { from: string, to?: string, paths: string[], title?: string, path?: string }) {
  refs.value = { from: opts.from, to: opts.to ?? 'draft' }
  files.value = opts.paths
  title.value = opts.title ?? '查看差异'
  visible.value = true
  await nextTick()
  if (!editor.value) {
    editor.value = monaco.editor.createDiffEditor(el.value!, {
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
    })
  }
  await select(opts.path ?? opts.paths[0] ?? '')
}

async function select(path: string) {
  current.value = path
  if (!path)
    return
  loading.value = true
  try {
    const d = await api<{ before: string, after: string }>(`/apps/${props.appId}/diff`, { query: { from: refs.value.from, to: refs.value.to, path } })
    const lang = languageOf(path)
    const old = editor.value!.getModel()
    editor.value!.setModel({
      original: monaco.editor.createModel(d.before, lang),
      modified: monaco.editor.createModel(d.after, lang),
    })
    old?.original.dispose()
    old?.modified.dispose()
  }
  finally {
    loading.value = false
  }
}

watch(visible, (v) => {
  if (!v) {
    const m = editor.value?.getModel()
    editor.value?.dispose()
    m?.original.dispose()
    m?.modified.dispose()
    editor.value = undefined
  }
})
onBeforeUnmount(() => editor.value?.dispose())

defineExpose({ show })
</script>

<template>
  <el-dialog v-model="visible" :title="title" width="88vw" top="5vh" destroy-on-close>
    <div class="flex gap-3 h-72vh">
      <div v-if="files.length > 1" class="w-220px shrink-0 overflow-auto border-r border-[var(--border)] pr-2">
        <div
          v-for="f in files" :key="f"
          class="px-2 py-1.5 rounded cursor-pointer text-13px truncate"
          :class="f === current ? 'bg-blue-50 text-blue-600' : 'hover:bg-gray-50'"
          @click="select(f)"
        >
          {{ f }}
        </div>
      </div>
      <div v-loading="loading" class="flex-1 min-w-0 flex flex-col">
        <div class="text-12px text-[var(--muted)] mb-2 flex justify-between">
          <span>修改前</span><span>{{ current }}</span><span>修改后</span>
        </div>
        <div ref="el" class="flex-1 border border-[var(--border)] rounded" />
      </div>
    </div>
  </el-dialog>
</template>
