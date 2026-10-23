<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '../stores/app'

const props = defineProps<{ appId: string }>()
const store = useAppStore()
const route = useRoute()
const router = useRouter()

const tabs = [
  { path: 'develop', label: '开发' },
  { path: 'release', label: '发布' },
  { path: 'data', label: '数据' },
  { path: 'grants', label: '能力' },
  { path: 'monitor', label: '监控' },
  { path: 'members', label: '成员' },
  { path: 'settings', label: '设置' },
]
const active = computed(() => route.path.split('/').pop())

watch(() => props.appId, async (id) => {
  store.app = null
  try {
    await store.load(id)
  }
  catch {
    await router.replace('/')
  }
}, { immediate: true })
</script>

<template>
  <div class="h-full flex flex-col">
    <header class="h-52px flex items-center px-4 border-b border-[var(--border)] bg-white gap-4 shrink-0">
      <el-button text @click="router.push('/')">
        ← 应用列表
      </el-button>
      <div v-if="store.app" class="flex items-center gap-2 min-w-0">
        <span class="font-600 truncate">{{ store.app.name }}</span>
        <span class="text-12px text-[var(--muted)]">{{ store.app.appId }}</span>
        <el-tag v-if="store.app.status === 'offline'" size="small" type="info">
          已下线
        </el-tag>
        <el-tag v-else-if="store.app.prodBuildId" size="small" type="success">
          已上线
        </el-tag>
      </div>
      <div class="flex-1 flex justify-center gap-1">
        <el-button
          v-for="t in tabs" :key="t.path"
          :type="active === t.path ? 'primary' : 'default'" :text="active !== t.path" :plain="active === t.path"
          @click="router.push(`/apps/${appId}/${t.path}`)"
        >
          {{ t.label }}
        </el-button>
      </div>
      <el-button v-if="store.app?.prodBuildId" tag="a" :href="store.app.urls.prod" target="_blank" text>
        打开线上版
      </el-button>
    </header>
    <div v-if="store.app" class="flex-1 min-h-0 overflow-auto bg-[var(--bg-soft)]">
      <router-view :key="appId" />
    </div>
    <div v-else v-loading="true" class="flex-1" />
  </div>
</template>
