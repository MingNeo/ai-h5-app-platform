<script setup lang="ts">
import { validateAppId } from '@app-platform/shared'
import { ElMessage } from 'element-plus'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api'

interface AppItem {
  appId: string
  name: string
  description: string
  status: string
  role: string
  prodBuildId: string | null
  betaBuildId: string | null
  updatedAt: string
  urls: { prod: string }
}

const router = useRouter()
const apps = ref<AppItem[]>([])
const loading = ref(true)
const keyword = ref('')
const showCreate = ref(false)
const creating = ref(false)
const form = reactive({ appId: '', name: '', description: '' })
const baseDomain = ref('')

const filtered = computed(() => apps.value.filter(a => !keyword.value || a.name.includes(keyword.value) || a.appId.includes(keyword.value)))
const appIdError = computed(() => form.appId ? validateAppId(form.appId) : null)

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
  if (appIdError.value || !form.appId)
    return ElMessage.warning(appIdError.value ?? '请填写 appId')
  creating.value = true
  try {
    const app = await api<AppItem>('/apps', { body: form })
    showCreate.value = false
    await router.push(`/apps/${app.appId}/develop`)
  }
  finally {
    creating.value = false
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
  api<{ baseDomain: string }>('/meta').then(m => { baseDomain.value = m.baseDomain }).catch(() => {})
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
        <div class="text-12px text-[var(--muted)] mt-2">
          更新于 {{ new Date(a.updatedAt).toLocaleString('zh-CN') }}
        </div>
      </div>
      <el-empty v-if="!loading && !filtered.length" description="还没有应用，点击右上角新建" class="col-span-full" />
    </div>

    <el-dialog v-model="showCreate" title="新建应用" width="480px">
      <el-form label-position="top">
        <el-form-item label="应用名称" required>
          <el-input v-model="form.name" maxlength="40" placeholder="例如：春季好物投票" />
        </el-form-item>
        <el-form-item label="appId（用于访问地址，创建后不能修改）" required :error="appIdError ?? ''">
          <el-input v-model="form.appId" maxlength="30" placeholder="例如：spring-vote">
            <template #append>
              .{{ baseDomain || 'example.com' }}
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
  </div>
</template>
