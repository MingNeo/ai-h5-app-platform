<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import { useRoute } from 'vue-router'
import ChatPanel from '../../components/chat/ChatPanel.vue'
import EditorSkeleton from '../../components/editor/EditorSkeleton.vue'
import PreviewPanel from '../../components/preview/PreviewPanel.vue'

/** 代码面板（含 Monaco）按需加载，加载期间先显示骨架屏 */
const CodePanel = defineAsyncComponent({
  loader: () => import('../../components/code/CodePanel.vue'),
  loadingComponent: EditorSkeleton,
  delay: 120,
})

const route = useRoute()
const appId = route.params.appId as string
const tab = ref<'preview' | 'code'>('preview')
const rightWidth = ref(Number(localStorage.getItem('app-right-width')) || 520)

function startResize(e: MouseEvent) {
  const startX = e.clientX
  const startW = rightWidth.value
  const move = (ev: MouseEvent) => {
    rightWidth.value = Math.min(Math.max(380, startW - (ev.clientX - startX)), window.innerWidth - 600)
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    document.body.style.userSelect = ''
    localStorage.setItem('app-right-width', String(rightWidth.value))
  }
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}
</script>

<template>
  <div class="h-full flex">
    <div class="flex-1 min-w-0">
      <ChatPanel :app-id="appId" />
    </div>
    <div class="w-5px cursor-col-resize hover:bg-blue-200 bg-[var(--border)] shrink-0" @mousedown="startResize" />
    <div class="shrink-0 flex flex-col bg-white" :style="{ width: `${rightWidth}px` }">
      <div class="flex items-center gap-1 px-3 h-40px border-b border-[var(--border)]">
        <el-button :type="tab === 'preview' ? 'primary' : 'default'" :plain="tab === 'preview'" :text="tab !== 'preview'" size="small" @click="tab = 'preview'">
          预览
        </el-button>
        <el-button :type="tab === 'code' ? 'primary' : 'default'" :plain="tab === 'code'" :text="tab !== 'code'" size="small" @click="tab = 'code'">
          代码
        </el-button>
      </div>
      <div class="flex-1 min-h-0">
        <PreviewPanel v-show="tab === 'preview'" :app-id="appId" />
        <CodePanel v-if="tab === 'code'" :app-id="appId" />
      </div>
    </div>
  </div>
</template>
