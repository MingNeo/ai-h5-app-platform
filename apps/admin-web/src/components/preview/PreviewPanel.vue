<script setup lang="ts">
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { api } from '../../api'
import { useAppStore } from '../../stores/app'

const props = defineProps<{ appId: string, mode?: 'develop' | 'observe' }>()
const store = useAppStore()
/** 观察模式只看测试版/线上版，不暴露草稿、身份切换和控制台 */
const observeMode = computed(() => props.mode === 'observe')

type Channel = 'dev' | 'beta' | 'prod'
interface LogEntry { ts: number, level: 'log' | 'info' | 'warn' | 'error', kind: string, message: string, source: 'page' | 'server' }

const DEVICES = [
  { key: 'iphone-se', label: 'iPhone SE (375×667)', w: 375, h: 667 },
  { key: 'iphone-14', label: 'iPhone 14 (390×844)', w: 390, h: 844 },
  { key: 'iphone-plus', label: 'iPhone Plus (414×896)', w: 414, h: 896 },
  { key: 'android', label: 'Android (360×800)', w: 360, h: 800 },
  { key: 'ipad', label: 'iPad (768×1024)', w: 768, h: 1024 },
]

const channel = ref<Channel>(observeMode.value ? (store.app?.betaBuildId ? 'beta' : 'prod') : 'dev')
/** 观察模式不自动加载：切 tab 回来不会反复签票据、拉预览 */
const started = ref(!observeMode.value)
const identity = ref<'self' | 'guest' | 'test'>('self')
const deviceKey = ref('iphone-14')
const landscape = ref(false)
const url = ref('')
const frameKey = ref(0)
const loading = ref(false)
const qr = ref('')
const qrUrl = ref('')
const logs = ref<LogEntry[]>([])
const requests = ref<Array<{ ts: number, method: string, url: string, status: number, ok: boolean, durationMs: number }>>([])
const consoleTab = ref<'console' | 'network'>('console')
const showConsole = ref(true)
const currentPath = ref('/')
const box = ref<HTMLDivElement>()
const boxSize = ref({ w: 400, h: 700 })
let pollTimer = 0
let lastServerErrorTs = Date.now()
let resizeObs: ResizeObserver | null = null

const device = computed(() => DEVICES.find(d => d.key === deviceKey.value)!)
const frameW = computed(() => landscape.value ? device.value.h : device.value.w)
const frameH = computed(() => landscape.value ? device.value.w : device.value.h)
const scale = computed(() => Math.min(1, (boxSize.value.w - 24) / (frameW.value + 20), (boxSize.value.h - 24) / (frameH.value + 20)))
/** 本轮 AI 改动还没定型（排队/发送中/运行中/被中断）时不展示报错：这时代码可能是半成品，报错不代表真的有问题 */
const errorsHidden = computed(() => channel.value === 'dev' && store.aiBusy)
const visibleLogs = computed(() => errorsHidden.value ? logs.value.filter(l => l.level !== 'error') : logs.value)
const hiddenErrorCount = computed(() => errorsHidden.value ? logs.value.filter(l => l.level === 'error').length : 0)
const errorCount = computed(() => visibleLogs.value.filter(l => l.level === 'error').length)
const host = computed(() => {
  try {
    return new URL(url.value).origin
  }
  catch {
    return ''
  }
})
const channelAvailable = computed(() => ({
  dev: !observeMode.value,
  beta: Boolean(store.app?.betaBuildId),
  prod: Boolean(store.app?.prodBuildId),
}))

/** 应用内路径：预览页上报的是 /a/{appId}[--channel]/...，先去掉前缀再交给后端 */
function appRelative(path: string) {
  const m = /^\/a\/[^/]+(\/.*)?$/.exec(path)
  return m ? (m[1] || '/') : path
}

async function load(path = '/') {
  loading.value = true
  try {
    const res = await api<{ url: string }>(`/apps/${props.appId}/preview-url`, { body: { channel: channel.value, identity: identity.value, path: appRelative(path) } })
    url.value = res.url
    frameKey.value++
  }
  finally {
    loading.value = false
  }
}

function refresh() {
  void load(currentPath.value)
}

async function start() {
  started.value = true
  await load()
}

function openNew() {
  window.open(url.value, '_blank')
}

async function makeQr() {
  const res = await api<{ url: string }>(`/apps/${props.appId}/preview-url`, { body: { channel: channel.value, identity: 'self', path: appRelative(currentPath.value), qr: true } })
  qrUrl.value = res.url
  qr.value = await QRCode.toDataURL(res.url, { width: 220, margin: 1 })
}

async function copyQr() {
  await navigator.clipboard.writeText(qrUrl.value)
  ElMessage.success('已复制')
}

function onMessage(e: MessageEvent) {
  if (!host.value || e.origin !== host.value)
    return
  const d = e.data
  if (!d || d.source !== 'app-preview')
    return
  if (d.kind === 'console' || d.kind === 'error') {
    logs.value.push({ ts: Date.now(), level: d.level ?? 'error', kind: d.kind, message: d.message, source: 'page' })
    if (logs.value.length > 300)
      logs.value.splice(0, logs.value.length - 300)
  }
  else if (d.kind === 'request') {
    requests.value.push({ ts: Date.now(), method: d.method, url: d.url, status: d.status, ok: d.ok, durationMs: d.durationMs })
    if (requests.value.length > 200)
      requests.value.splice(0, requests.value.length - 200)
  }
  else if (d.kind === 'route' || d.kind === 'ready') {
    currentPath.value = d.path ?? '/'
  }
}

async function pollServerErrors() {
  if (observeMode.value || channel.value !== 'dev' || document.hidden)
    return
  try {
    const errs = await api<Array<{ ts: number, kind: string, message: string }>>(`/apps/${props.appId}/dev-errors`, { query: { since: lastServerErrorTs }, quiet: true })
    for (const e of errs) {
      lastServerErrorTs = Math.max(lastServerErrorTs, e.ts)
      // 页面上报的错误已经通过 postMessage 展示过，这里只补充编译错误、数据告警
      if (e.kind.startsWith('compile') || e.kind === 'data-warning')
        logs.value.push({ ts: e.ts, level: e.kind === 'compile' ? 'error' : 'warn', kind: e.kind, message: e.message, source: 'server' })
    }
  }
  catch {}
}

function fixWithAi(entry: LogEntry) {
  store.pendingAttachments.push({ type: 'error', value: `[${entry.kind}] ${entry.message}`, label: '预览报错' })
}

function fixAll() {
  const errs = logs.value.filter(l => l.level === 'error').slice(-10)
  if (errs.length)
    store.pendingAttachments.push({ type: 'error', value: errs.map(e => `[${e.kind}] ${e.message}`).join('\n\n'), label: `预览报错 ${errs.length} 条` })
}

function clearLogs() {
  logs.value = []
  requests.value = []
  void api(`/apps/${props.appId}/dev-errors`, { method: 'DELETE', quiet: true })
}

watch([channel, identity], () => {
  logs.value = []
  requests.value = []
  if (started.value)
    void load(currentPath.value)
})
watch(() => store.previewVersion, () => {
  if (started.value)
    refresh()
})

onMounted(() => {
  window.addEventListener('message', onMessage)
  if (!observeMode.value) {
    void load()
    pollTimer = window.setInterval(pollServerErrors, 3000)
  }
  resizeObs = new ResizeObserver(([entry]) => {
    boxSize.value = { w: entry!.contentRect.width, h: entry!.contentRect.height }
  })
  if (box.value)
    resizeObs.observe(box.value)
})
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  clearInterval(pollTimer)
  resizeObs?.disconnect()
})
</script>

<template>
  <div class="h-full flex flex-col">
    <div v-if="!observeMode || started" class="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border)] bg-white flex-wrap">
      <el-select v-model="channel" size="small" class="!w-110px">
        <el-option v-if="!observeMode" label="草稿（实时）" value="dev" />
        <el-option label="测试版" value="beta" :disabled="!channelAvailable.beta" />
        <el-option label="线上版" value="prod" :disabled="!channelAvailable.prod" />
      </el-select>
      <el-select v-if="!observeMode" v-model="identity" size="small" class="!w-110px" :disabled="channel === 'prod'">
        <el-option label="我的账号" value="self" />
        <el-option label="游客" value="guest" />
        <el-option label="测试身份" value="test" />
      </el-select>
      <el-select v-model="deviceKey" size="small" class="!w-150px">
        <el-option v-for="d in DEVICES" :key="d.key" :label="d.label" :value="d.key" />
      </el-select>
      <el-button size="small" @click="landscape = !landscape">
        {{ landscape ? '横屏' : '竖屏' }}
      </el-button>
      <el-button size="small" :loading="loading" @click="refresh">
        刷新
      </el-button>
      <el-button size="small" @click="openNew">
        新窗口
      </el-button>
      <el-popover trigger="click" :width="250" @show="makeQr">
        <template #reference>
          <el-button size="small">
            扫码真机
          </el-button>
        </template>
        <div class="flex flex-col items-center gap-2">
          <img v-if="qr" :src="qr" class="w-220px h-220px">
          <div class="text-12px text-[var(--muted)] text-center">
            用宿主 App 或手机浏览器扫码，30 分钟内有效。原生登录、分享等能力只能在 App 内验证。
          </div>
          <el-button size="small" link type="primary" @click="copyQr">
            复制链接
          </el-button>
        </div>
      </el-popover>
    </div>

    <div ref="box" class="relative flex-1 min-h-0 flex items-center justify-center bg-[#eef0f3] overflow-hidden">
      <div v-if="observeMode && !started" class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#eef0f3]">
        <div class="text-13px text-[var(--muted)]">
          预览不会自动加载
        </div>
        <el-button type="primary" @click="start">
          加载预览
        </el-button>
      </div>
      <div
        class="bg-black rounded-[28px] p-[10px] shadow-xl shrink-0"
        :style="{ width: `${frameW + 20}px`, height: `${frameH + 20}px`, transform: `scale(${scale})`, transformOrigin: 'center' }"
      >
        <iframe
          v-if="url" :key="frameKey" :src="url"
          class="w-full h-full rounded-[20px] bg-white border-0 block"
          allow="clipboard-write; autoplay"
        />
      </div>
    </div>

    <div v-if="!observeMode" class="border-t border-[var(--border)] bg-white" :class="showConsole ? 'h-200px' : ''">
      <div class="flex items-center gap-2 px-3 py-1.5 text-13px border-b border-[var(--border)]">
        <el-button size="small" text @click="showConsole = !showConsole">
          {{ showConsole ? '▾' : '▸' }} 控制台
        </el-button>
        <el-tag v-if="errorCount" type="danger" size="small">
          {{ errorCount }} 个错误
        </el-tag>
        <template v-if="showConsole">
          <el-radio-group v-model="consoleTab" size="small">
            <el-radio-button value="console">
              日志
            </el-radio-button>
            <el-radio-button value="network">
              请求
            </el-radio-button>
          </el-radio-group>
          <span class="flex-1" />
          <el-button v-if="errorCount && store.canEdit()" size="small" type="primary" plain @click="fixAll">
            让 AI 修复
          </el-button>
          <el-button size="small" text @click="clearLogs">
            清空
          </el-button>
        </template>
      </div>
      <div v-if="showConsole" class="h-[calc(100%-38px)] overflow-auto scroll-thin font-mono text-12px">
        <template v-if="consoleTab === 'console'">
          <div v-if="hiddenErrorCount" class="px-3 py-1.5 text-[var(--muted)] font-sans border-b border-gray-100">
            本轮改动还没结束，{{ hiddenErrorCount }} 条报错暂不展示
          </div>
          <div
            v-for="(l, i) in visibleLogs" :key="i"
            class="group flex gap-2 px-3 py-1 border-b border-gray-100"
            :class="l.level === 'error' ? 'bg-red-50 text-red-700' : l.level === 'warn' ? 'bg-amber-50 text-amber-700' : ''"
          >
            <span class="text-[var(--muted)] shrink-0">{{ new Date(l.ts).toLocaleTimeString('zh-CN') }}</span>
            <span class="flex-1 whitespace-pre-wrap break-all">{{ l.message }}</span>
            <el-button v-if="l.level === 'error' && store.canEdit()" size="small" link type="primary" class="opacity-0 group-hover:opacity-100" @click="fixWithAi(l)">
              交给 AI
            </el-button>
          </div>
          <div v-if="!visibleLogs.length && !hiddenErrorCount" class="text-[var(--muted)] p-3 font-sans">
            暂无日志
          </div>
        </template>
        <template v-else>
          <div v-for="(r, i) in requests" :key="i" class="flex gap-2 px-3 py-1 border-b border-gray-100" :class="!r.ok ? 'text-red-600' : ''">
            <span class="w-44px shrink-0">{{ r.method }}</span>
            <span class="w-36px shrink-0">{{ r.status || '-' }}</span>
            <span class="flex-1 truncate">{{ r.url }}</span>
            <span class="text-[var(--muted)]">{{ r.durationMs }}ms</span>
          </div>
          <div v-if="!requests.length" class="text-[var(--muted)] p-3 font-sans">
            暂无请求
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
