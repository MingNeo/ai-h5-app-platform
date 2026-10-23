<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { languageOf, monaco } from './monaco'

const props = defineProps<{ path: string, readonly?: boolean, /** 滚动条常显，内容超出时一眼能看出来 */ scrollbar?: 'auto' | 'visible' }>()
const model = defineModel<string>({ required: true })
const el = ref<HTMLDivElement>()
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()

onMounted(() => {
  editor.value = monaco.editor.create(el.value!, {
    value: model.value,
    language: languageOf(props.path),
    readOnly: props.readonly,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    tabSize: 2,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    scrollbar: {
      vertical: props.scrollbar ?? 'auto',
      horizontal: 'auto',
      verticalScrollbarSize: 10,
      alwaysConsumeMouseWheel: false,
    },
  })
  editor.value.onDidChangeModelContent(() => {
    const v = editor.value!.getValue()
    if (v !== model.value)
      model.value = v
  })
})

watch(model, (v) => {
  if (editor.value && v !== editor.value.getValue())
    editor.value.setValue(v)
})

watch(() => props.path, (p) => {
  const m = editor.value?.getModel()
  if (m)
    monaco.editor.setModelLanguage(m, languageOf(p))
})

watch(() => props.readonly, r => editor.value?.updateOptions({ readOnly: r }))

onBeforeUnmount(() => editor.value?.dispose())
</script>

<template>
  <div ref="el" class="w-full h-full" />
</template>
