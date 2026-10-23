<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../../api'
import { useAppStore } from '../../stores/app'

const store = useAppStore()
const appId = store.app!.appId
const days = ref(7)
const loading = ref(false)
const stats = ref<{
  daily: Array<{ day: string, type: string, n: number, uv: number }>
  errors: Array<{ message: string, count: number, last: string, sample: any }>
  apiFailures: Array<{ url: string, status: number, count: number }>
  lcp: { p50: number | null, p75: number | null, p95: number | null, samples: number }
} | null>(null)

const daily = computed(() => {
  const map = new Map<string, { day: string, pv: number, uv: number, errors: number }>()
  for (const d of stats.value?.daily ?? []) {
    const row = map.get(d.day) ?? { day: d.day, pv: 0, uv: 0, errors: 0 }
    if (d.type === 'pv') {
      row.pv = d.n
      row.uv = d.uv
    }
    else {
      row.errors = d.n
    }
    map.set(d.day, row)
  }
  return [...map.values()]
})
const maxPv = computed(() => Math.max(1, ...daily.value.map(d => d.pv)))
const totals = computed(() => daily.value.reduce((s, d) => ({ pv: s.pv + d.pv, errors: s.errors + d.errors }), { pv: 0, errors: 0 }))

async function load() {
  loading.value = true
  try {
    stats.value = await api(`/apps/${appId}/stats`, { query: { days: days.value } })
  }
  finally {
    loading.value = false
  }
}

watch(days, load)
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="max-w-1100px mx-auto p-6 flex flex-col gap-4">
    <div class="flex items-center gap-3">
      <div class="font-600 flex-1">
        线上版监控
      </div>
      <el-radio-group v-model="days" size="small">
        <el-radio-button :value="1">
          今天
        </el-radio-button>
        <el-radio-button :value="7">
          7 天
        </el-radio-button>
        <el-radio-button :value="30">
          30 天
        </el-radio-button>
      </el-radio-group>
    </div>
    <div class="grid grid-cols-4 gap-4">
      <div class="bg-white rounded-xl p-4 border border-[var(--border)]">
        <div class="text-13px text-[var(--muted)]">
          访问量 PV
        </div>
        <div class="text-24px font-600 mt-1">
          {{ totals.pv }}
        </div>
      </div>
      <div class="bg-white rounded-xl p-4 border border-[var(--border)]">
        <div class="text-13px text-[var(--muted)]">
          JS 错误
        </div>
        <div class="text-24px font-600 mt-1" :class="totals.errors ? 'text-red-500' : ''">
          {{ totals.errors }}
        </div>
      </div>
      <div class="bg-white rounded-xl p-4 border border-[var(--border)]">
        <div class="text-13px text-[var(--muted)]">
          首屏 LCP（P75）
        </div>
        <div class="text-24px font-600 mt-1">
          {{ stats?.lcp.p75 != null ? `${(stats.lcp.p75 / 1000).toFixed(2)}s` : '-' }}
        </div>
      </div>
      <div class="bg-white rounded-xl p-4 border border-[var(--border)]">
        <div class="text-13px text-[var(--muted)]">
          接口失败
        </div>
        <div class="text-24px font-600 mt-1">
          {{ stats?.apiFailures.reduce((s, a) => s + a.count, 0) ?? 0 }}
        </div>
      </div>
    </div>

    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-4">
        每日访问
      </div>
      <div v-if="daily.length" class="flex items-end gap-3 h-180px">
        <div v-for="d in daily" :key="d.day" class="flex-1 flex flex-col items-center gap-1 h-full justify-end">
          <span class="text-12px text-[var(--muted)]">{{ d.pv }}</span>
          <div class="w-full max-w-40px bg-blue-400 rounded-t" :style="{ height: `${(d.pv / maxPv) * 140}px` }" :title="`PV ${d.pv} / UV ${d.uv} / 错误 ${d.errors}`" />
          <span class="text-12px text-[var(--muted)]">{{ d.day }}</span>
        </div>
      </div>
      <el-empty v-else description="暂无数据" :image-size="60" />
    </div>

    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        错误排行
      </div>
      <el-table :data="stats?.errors ?? []" size="small" empty-text="没有错误">
        <el-table-column label="错误信息" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="font-mono text-12px">{{ row.message }}</span>
          </template>
        </el-table-column>
        <el-table-column label="次数" prop="count" width="80" />
        <el-table-column label="最近发生" width="170">
          <template #default="{ row }">
            {{ new Date(row.last).toLocaleString('zh-CN') }}
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="bg-white rounded-xl p-5 border border-[var(--border)]">
      <div class="font-600 mb-3">
        接口失败
      </div>
      <el-table :data="stats?.apiFailures ?? []" size="small" empty-text="没有失败请求">
        <el-table-column label="接口" prop="url" show-overflow-tooltip />
        <el-table-column label="状态码" prop="status" width="90" />
        <el-table-column label="次数" prop="count" width="80" />
      </el-table>
    </div>
  </div>
</template>
