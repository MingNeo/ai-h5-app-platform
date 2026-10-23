<script setup lang="ts">
import type { AgentEvent, Attachment } from '@app-platform/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { api, ApiError, subscribeSse } from '../../api'
import { useAppStore } from '../../stores/app'
import DiffDialog from '../editor/DiffDialog.vue'
import Composer from './Composer.vue'
import TurnItem from './TurnItem.vue'
import { TurnReducer, type TurnView } from './turns'

const props = defineProps<{ appId: string }>()
const store = useAppStore()
const canEdit = computed(() => store.canEdit())

interface SessionItem { id: string, title: string, updatedAt: string, status: string, usage: { inputTokens: number, outputTokens: number } }
const sessions = ref<SessionItem[]>([])
const todayTokens = ref(0)
const currentId = ref<string | null>(null)
const reducer = new TurnReducer()
const turns = shallowRef<TurnView[]>([])
/** 本地排队：当前轮次跑完才真正发出 */
const queue = ref<Array<{ id: string, message: string, attachments: Attachment[], planMode: boolean, model: string }>>([])
let flushing = false
const loadingSession = ref(false)
const agentCfg = ref<{ configured: boolean, models: string[], defaultModel: string, visionModels: string[], contextTokens: number } | null>(null)
const model = ref('')
const planMode = ref(false)
const scroller = ref<HTMLDivElement>()
const diffRef = ref<InstanceType<typeof DiffDialog>>()
const composerRef = ref<InstanceType<typeof Composer>>()
let unsub: (() => void) | null = null
let stickToBottom = true

const running = computed(() => turns.value.some(t => t.status === 'running' || t.status === 'queued'))
const runningTurn = computed(() => turns.value.find(t => t.status === 'running') ?? turns.value.find(t => t.status === 'queued'))
const contextPct = computed(() => {
  const last = [...turns.value].reverse().find(t => t.usage?.inputTokens)
  if (!last?.usage || !agentCfg.value)
    return 0
  return Math.min(100, Math.round(last.usage.inputTokens / Math.max(1, countModelCalls(last)) / agentCfg.value.contextTokens * 100))
})

function countModelCalls(t: TurnView) {
  return t.segments.filter(s => s.kind === 'tools').length + 1
}

const SUGGESTIONS = [
  '做一个活动报名表单，收集姓名、手机号和参加场次，提交后展示报名成功',
  '做一个投票页面，3 个选项，每人一票，实时显示票数和占比',
  '做一个 H5 小游戏：接住掉落的红包，60 秒倒计时，结束后上传成绩到排行榜',
  '做一个记账小工具，记录每笔收支，按月汇总并显示饼图',
  '做一个问卷调查，5 道选择题，提交后感谢页',
  '给现有页面加一个排行榜，显示前 20 名',
]

async function loadSessions() {
  const res = await api<{ sessions: SessionItem[], todayTokens: number }>(`/apps/${props.appId}/sessions`)
  sessions.value = res.sessions
  todayTokens.value = res.todayTokens
}

async function openSession(id: string) {
  unsub?.()
  currentId.value = id
  loadingSession.value = true
  reducer.reset()
  turns.value = []
  queue.value = []
  try {
    const res = await api<{ events: AgentEvent[] }>(`/sessions/${id}/events`)
    for (const ev of res.events)
      reducer.apply(ev)
    turns.value = reducer.turns
  }
  finally {
    loadingSession.value = false
  }
  stickToBottom = true
  scrollToBottom()
  unsub = subscribeSse(`/sessions/${id}/stream`, (ev: AgentEvent) => {
    if (currentId.value !== id)
      return
    if (reducer.apply(ev)) {
      turns.value = reducer.turns
      if (ev.type === 'tool.result' || ev.type === 'turn.done')
        store.filesVersion++
      if (ev.type === 'turn.done')
        void loadSessions()
      scrollToBottom()
    }
  }, () => reducer.resumeAfter())
}

async function newSession() {
  const s = await api<{ id: string }>(`/apps/${props.appId}/sessions`, { body: {} })
  await loadSessions()
  await openSession(s.id)
}

async function ensureSession() {
  if (currentId.value)
    return currentId.value
  await newSession()
  return currentId.value!
}

async function rename(s: SessionItem) {
  const { value } = await ElMessageBox.prompt('会话名称', '重命名', { inputValue: s.title, inputPattern: /\S/, inputErrorMessage: '不能为空' })
  await api(`/sessions/${s.id}`, { method: 'PATCH', body: { title: value } })
  await loadSessions()
}

async function remove(s: SessionItem) {
  await ElMessageBox.confirm(`删除会话「${s.title}」？对话记录会被清除，代码改动不受影响。`, '删除会话', { type: 'warning' })
  await api(`/sessions/${s.id}`, { method: 'DELETE' })
  if (currentId.value === s.id) {
    unsub?.()
    currentId.value = null
    reducer.reset()
    turns.value = []
  }
  await loadSessions()
}

async function send(payload: { message: string, attachments: Attachment[], planMode: boolean, model: string }) {
  queue.value = [...queue.value, { ...payload, id: `q${Date.now()}${queue.value.length}` }]
  void flush()
}

/** 一次只放出去一条：等服务端确认这一轮已在跑（running），再放下一轮 */
async function flush() {
  if (flushing)
    return
  flushing = true
  try {
    while (queue.value.length) {
      if (running.value)
        return
      const item = queue.value[0]!
      try {
        await post(item)
      }
      catch {
        queue.value = queue.value.filter(q => q.id !== item.id)
        continue
      }
      queue.value = queue.value.filter(q => q.id !== item.id)
      // 排队事件到达前 running 还是 false，等它一下，否则下一条会被立刻发出去
      const deadline = Date.now() + 3000
      while (!running.value && Date.now() < deadline)
        await new Promise(r => setTimeout(r, 100))
    }
  }
  finally {
    flushing = false
  }
}

async function post(payload: { message: string, attachments: Attachment[], planMode: boolean, model: string }) {
  const sid = await ensureSession()
  stickToBottom = true
  await api(`/sessions/${sid}/messages`, { body: payload })
  scrollToBottom()
}

function cancelQueued(id: string) {
  queue.value = queue.value.filter(q => q.id !== id)
}

watch(running, (now) => {
  if (!now)
    void flush()
})

async function stop() {
  const t = runningTurn.value
  if (t)
    await api(`/turns/${t.id}/stop`, { body: {} })
}

async function stopTurn(t: TurnView) {
  await api(`/turns/${t.id}/stop`, { body: {} })
}

async function revert(t: TurnView) {
  await ElMessageBox.confirm(`撤销这一轮对 ${t.changes.length} 个文件的改动？`, '撤销本轮改动', { type: 'warning' })
  try {
    await api(`/turns/${t.id}/revert`, { body: {}, quiet: true })
  }
  catch (e) {
    if (e instanceof ApiError && e.data?.conflicts) {
      await ElMessageBox.confirm(e.message, '文件已被后续修改', { type: 'warning', confirmButtonText: '仍然撤销' })
      await api(`/turns/${t.id}/revert`, { body: { force: true } })
    }
    else {
      ElMessage.error((e as Error).message)
      return
    }
  }
  ElMessage.success('已撤销')
  store.filesVersion++
}

async function rollback(t: TurnView) {
  await ElMessageBox.confirm('把代码恢复到这条消息发送之前的状态？之后的所有改动都会被撤回（可以在版本记录里再恢复）。', '从这里回滚', { type: 'warning' })
  await api(`/turns/${t.id}/rollback`, { body: {} })
  ElMessage.success('已回滚')
  store.filesVersion++
}

function diff(t: TurnView, path?: string) {
  if (!t.snapshotBefore)
    return
  diffRef.value?.show({
    from: t.snapshotBefore,
    to: t.snapshotAfter ?? 'draft',
    paths: t.changes.filter(c => c.status !== 'deleted').map(c => c.path).concat(t.changes.filter(c => c.status === 'deleted').map(c => c.path)),
    path,
    title: '本轮改动',
  })
}

function resend(t: TurnView) {
  void send({ message: t.message, attachments: t.attachments, planMode: t.planMode, model: model.value })
}

function executePlan() {
  void send({ message: '方案没问题，请按上面的方案执行。', attachments: [], planMode: false, model: model.value })
}

function fixIssues(text: string) {
  void send({ message: `请修复以下校验问题：\n${text}`, attachments: [], planMode: false, model: model.value })
}

function useSuggestion(s: string) {
  composerRef.value?.setText(s)
}

function onScroll() {
  const el = scroller.value
  if (el)
    stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function scrollToBottom() {
  if (!stickToBottom)
    return
  void nextTick(() => {
    const el = scroller.value
    if (el)
      el.scrollTop = el.scrollHeight
  })
}

watch(() => store.pendingAttachments.length, (n) => {
  if (n && !currentId.value && sessions.value[0])
    void openSession(sessions.value[0].id)
})

onMounted(async () => {
  agentCfg.value = await api('/agent/config')
  model.value = agentCfg.value!.defaultModel
  await loadSessions()
  if (sessions.value[0])
    await openSession(sessions.value[0].id)
})
onBeforeUnmount(() => unsub?.())
</script>

<template>
  <div class="h-full flex">
    <!-- 会话列表 -->
    <aside class="w-200px shrink-0 border-r border-[var(--border)] bg-white flex flex-col">
      <div class="p-3">
        <el-button class="w-full" :disabled="!canEdit" @click="newSession">
          ＋ 新会话
        </el-button>
      </div>
      <div class="flex-1 overflow-auto scroll-thin px-2">
        <div
          v-for="s in sessions" :key="s.id"
          class="group flex items-center gap-1 px-2.5 py-2 rounded-lg cursor-pointer text-13px mb-0.5"
          :class="s.id === currentId ? 'bg-blue-50 text-blue-700' : 'hover:bg-gray-50'"
          @click="openSession(s.id)"
        >
          <span v-if="s.status !== 'idle'" class="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
          <span class="flex-1 truncate">{{ s.title }}</span>
          <el-dropdown v-if="canEdit" trigger="click" @click.stop>
            <span class="opacity-0 group-hover:opacity-100 px-1 text-[var(--muted)]" @click.stop>⋯</span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="rename(s)">
                  重命名
                </el-dropdown-item>
                <el-dropdown-item @click="remove(s)">
                  删除
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <div v-if="!sessions.length" class="text-12px text-[var(--muted)] text-center mt-6">
          还没有会话
        </div>
      </div>
      <div class="p-3 text-12px text-[var(--muted)] border-t border-[var(--border)]">
        今日用量 {{ (todayTokens / 1000).toFixed(1) }}k tokens
      </div>
    </aside>

    <!-- 对话 -->
    <section class="flex-1 min-w-0 flex flex-col bg-[var(--bg-soft)]">
      <el-alert v-if="agentCfg && !agentCfg.configured" type="warning" :closable="false" title="平台未配置模型服务（LLM_BASE_URL），暂时无法使用 AI" />
      <div ref="scroller" v-loading="loadingSession" class="flex-1 overflow-auto scroll-thin" @scroll="onScroll">
        <div class="max-w-780px mx-auto px-6 py-6 flex flex-col gap-7">
          <template v-if="!turns.length && !loadingSession">
            <div class="text-center mt-10">
              <div class="text-20px font-600">
                想做一个什么样的应用？
              </div>
              <div class="text-[var(--muted)] mt-2">
                描述越具体，生成效果越好。可以引用截图或设计稿。
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <button
                v-for="s in SUGGESTIONS" :key="s" type="button" :disabled="!canEdit"
                class="text-left text-13px p-3 rounded-xl border border-[var(--border)] bg-white hover:border-blue-300 hover:bg-blue-50/40 cursor-pointer transition-colors"
                @click="useSuggestion(s)"
              >
                {{ s }}
              </button>
            </div>
          </template>
          <TurnItem
            v-for="t in turns" :key="t.id" :turn="t" :can-edit="canEdit"
            @stop="stopTurn(t)" @revert="revert(t)" @rollback="rollback(t)" @resend="resend(t)"
            @execute-plan="executePlan" @diff="(p?: string) => diff(t, p)" @fix-issues="fixIssues"
          />
        </div>
      </div>
      <div class="max-w-780px w-full mx-auto px-6 pb-4">
        <div v-if="queue.length" class="mb-2 border border-[var(--border)] rounded-xl bg-white divide-y divide-[var(--border)]">
          <div class="px-3 py-1.5 text-12px text-[var(--muted)]">
            待发送 {{ queue.length }} 条，当前任务结束后依次发出
          </div>
          <div v-for="(q, i) in queue" :key="q.id" class="group flex items-center gap-2 px-3 py-2 text-13px">
            <span class="text-[var(--muted)] shrink-0">{{ i + 1 }}</span>
            <span class="flex-1 truncate">{{ q.message }}</span>
            <span v-if="q.attachments.length" class="text-12px text-[var(--muted)] shrink-0">{{ q.attachments.length }} 个引用</span>
            <el-button size="small" text type="danger" @click="cancelQueued(q.id)">
              取消
            </el-button>
          </div>
        </div>
        <Composer
          ref="composerRef"
          v-model:model="model" v-model:plan-mode="planMode"
          :app-id="appId" :running="running" :disabled="!canEdit || !agentCfg?.configured"
          :models="agentCfg?.models ?? []" :vision-models="agentCfg?.visionModels ?? []"
          @send="send" @stop="stop"
        />
        <div v-if="contextPct > 40" class="text-12px text-[var(--muted)] mt-1.5 text-right">
          上下文已使用约 {{ contextPct }}%，较早的对话会自动压缩；也可以新建会话
        </div>
      </div>
    </section>
    <DiffDialog ref="diffRef" :app-id="appId" />
  </div>
</template>
