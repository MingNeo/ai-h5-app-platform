<script setup lang="ts">
/** 编辑器（Monaco 分包）与文件内容加载时的占位，避免整块区域空白 */
withDefaults(defineProps<{ label?: string }>(), { label: '正在加载…' })
</script>

<template>
  <div class="h-full flex flex-col bg-white">
    <div class="flex items-center gap-2 px-4 py-2 text-12px text-[var(--muted)]">
      <span class="w-3 h-3 rounded-full border-2 border-[var(--border)] border-t-blue-500 animate-spin" />
      {{ label }}
    </div>
    <div class="flex-1 overflow-hidden px-4 py-2">
      <div class="animate-pulse flex flex-col gap-2.5">
        <div v-for="(w, i) in ['62%', '48%', '80%', '36%', '70%', '54%', '88%', '42%', '66%', '30%']" :key="i" class="h-3 rounded bg-[var(--border)]" :style="{ width: w }" />
      </div>
    </div>
  </div>
</template>
