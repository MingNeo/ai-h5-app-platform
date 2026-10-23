<script setup lang="ts">
import { ElMessage } from 'element-plus'
import { computed, ref } from 'vue'
import Markdown from './Markdown.vue'
import { TOOL_LABEL, type ToolItem, toolsSummary, type TurnView } from './turns'

const props = defineProps<{ turn: TurnView, canEdit: boolean }>()
const emit = defineEmits<{
  stop: []
  revert: []
  rollback: []
  resend: []
  executePlan: []
  diff: [path?: string]
  fixIssues: [text: string]
}>()

const openThinking = ref<Set<number>>(new Set())
const openTools = ref<Set<number>>(new Set())
const openIssues = ref<Set<number>>(new Set())

const running = computed(() => props.turn.status === 'running')
const finalText = computed(() => props.turn.segments.filter(s => s.kind === 'text').map(s => (s as { text: string }).text).join('\n\n'))
const totalAdded = computed(() => props.turn.changes.reduce((s, c) => s + c.added, 0))
const totalRemoved = computed(() => props.turn.changes.reduce((s, c) => s + c.removed, 0))
const elapsed = computed(() => props.turn.startedAt && props.turn.finishedAt ? Math.round((props.turn.finishedAt - props.turn.startedAt) / 1000) : 0)

function toggle(set: Set<number>, i: number) {
  set.has(i) ? set.delete(i) : set.add(i)
}

function toolText(i: ToolItem) {
  const label = TOOL_LABEL[i.name] ?? i.name
  const target = i.input?.path ?? (i.input?.from ? `${i.input.from} → ${i.input.to}` : '')
  const extra = i.name === 'grep' ? i.input?.pattern : i.name === 'glob' ? i.input?.pattern : i.name === 'read_docs' ? i.input?.topic : i.name.startsWith('db_') ? i.input?.collection : i.name === 'add_dependency' ? i.input?.name : ''
  return [label, target || extra].filter(Boolean).join(' ')
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
  ElMessage.success('已复制')
}

function issuesText(issues: Array<{ file?: string, line?: number, message: string }>) {
  return issues.map(i => `${i.file ? `${i.file}${i.line ? `:${i.line}` : ''} ` : ''}${i.message}`).join('\n')
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- 用户消息 -->
    <div class="group flex flex-col items-end gap-1">
      <div class="max-w-[85%] bg-blue-50 rounded-2xl rounded-tr-sm px-4 py-2.5 whitespace-pre-wrap break-words">
        <el-tag v-if="turn.planMode" size="small" type="warning" class="mb-1 mr-1">
          先出方案
        </el-tag>
        {{ turn.message }}
        <div v-if="turn.attachments.length" class="flex flex-wrap gap-1 mt-2">
          <el-tag v-for="(a, i) in turn.attachments" :key="i" size="small" type="info">
            {{ a.type === 'file' ? '📄' : a.type === 'collection' ? '🗂' : a.type === 'image' ? '🖼' : '⚠️' }} {{ a.label || a.value.slice(0, 30) }}
          </el-tag>
        </div>
      </div>
      <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <el-button size="small" text @click="copy(turn.message)">
          复制
        </el-button>
        <el-button v-if="canEdit && turn.snapshotBefore && !running" size="small" text @click="emit('rollback')">
          从这里回滚
        </el-button>
      </div>
    </div>

    <!-- 排队中 -->
    <div v-if="turn.status === 'queued'" class="flex items-center gap-2 text-[var(--muted)] text-13px">
      <el-icon class="is-loading">
        <svg viewBox="0 0 1024 1024"><path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32m0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32" /></svg>
      </el-icon>
      排队中，等前面的任务完成后开始
      <el-button v-if="canEdit" size="small" text type="danger" @click="emit('stop')">
        取消
      </el-button>
    </div>

    <!-- AI 回复 -->
    <div v-else class="group flex flex-col gap-2.5">
      <template v-for="(seg, i) in turn.segments" :key="i">
        <div v-if="seg.kind === 'thinking'" class="text-13px">
          <div class="inline-flex items-center gap-1 text-[var(--muted)] cursor-pointer select-none hover:text-[var(--text)]" @click="toggle(openThinking, i)">
            <span>{{ openThinking.has(i) ? '▾' : '▸' }}</span>
            <span v-if="seg.durationMs !== undefined">已思考 {{ Math.max(1, Math.round(seg.durationMs / 1000)) }} 秒</span>
            <span v-else class="animate-pulse">思考中…</span>
          </div>
          <div v-if="openThinking.has(i)" class="mt-1 pl-4 border-l-2 border-gray-200 text-[var(--muted)] whitespace-pre-wrap">
            {{ seg.text }}
          </div>
        </div>

        <Markdown v-else-if="seg.kind === 'text'" :text="seg.text" />

        <div v-else-if="seg.kind === 'tools'" class="text-13px">
          <div class="inline-flex items-center gap-1.5 text-[var(--muted)] cursor-pointer select-none hover:text-[var(--text)]" @click="toggle(openTools, i)">
            <span>{{ openTools.has(i) ? '▾' : '▸' }}</span>
            <span :class="{ 'animate-pulse': seg.items.some(x => !x.done) }">{{ toolsSummary(seg.items) }}</span>
          </div>
          <div v-if="openTools.has(i)" class="mt-1.5 ml-1 pl-3 border-l-2 border-gray-200 flex flex-col gap-1">
            <div v-for="item in seg.items" :key="item.id" class="flex items-center gap-2">
              <span v-if="!item.done" class="text-blue-500">◌</span>
              <span v-else-if="item.ok" class="text-green-600">✓</span>
              <span v-else class="text-red-500">✕</span>
              <span class="truncate">{{ toolText(item) }}</span>
              <span v-if="item.summary && item.done" class="text-[var(--muted)] truncate">· {{ item.summary }}</span>
              <el-button v-if="item.done && item.ok && ['write_file', 'edit_file'].includes(item.name) && turn.snapshotBefore && turn.status !== 'running'" size="small" link type="primary" @click="emit('diff', item.input?.path)">
                差异
              </el-button>
            </div>
          </div>
        </div>

        <div v-else-if="seg.kind === 'todos' && turn.todos.length" class="border border-[var(--border)] rounded-xl px-4 py-3 bg-white">
          <div class="text-13px font-600 mb-2">
            执行计划
          </div>
          <div v-for="(t, k) in turn.todos" :key="k" class="flex items-center gap-2 py-0.5 text-13px">
            <span v-if="t.status === 'completed'" class="text-green-600">✓</span>
            <span v-else-if="t.status === 'in_progress'" class="text-blue-500 animate-pulse">◐</span>
            <span v-else class="text-gray-400">○</span>
            <span :class="{ 'line-through text-[var(--muted)]': t.status === 'completed', 'font-500': t.status === 'in_progress' }">{{ t.content }}</span>
          </div>
        </div>

        <div v-else-if="seg.kind === 'check'" class="text-13px rounded-lg px-3 py-2" :class="seg.status === 'passed' ? 'bg-green-50 text-green-700' : seg.status === 'failed' ? 'bg-orange-50 text-orange-700' : 'bg-gray-50 text-[var(--muted)]'">
          <div class="flex items-center gap-2">
            <span v-if="seg.status === 'running'" class="animate-pulse">正在校验（安全扫描、类型检查、构建）…</span>
            <span v-else-if="seg.status === 'passed'">✓ 校验通过{{ seg.issues.length ? `（${seg.issues.length} 个提示）` : '' }}</span>
            <span v-else>✕ 校验发现 {{ seg.issues.filter(x => x.severity === 'error').length }} 个问题{{ seg.autoFixRound ? `，AI 正在自动修复（第 ${seg.autoFixRound} 次）` : '' }}</span>
            <el-button v-if="seg.issues.length" size="small" link @click="toggle(openIssues, i)">
              {{ openIssues.has(i) ? '收起' : '详情' }}
            </el-button>
          </div>
          <div v-if="openIssues.has(i)" class="mt-1.5 flex flex-col gap-1 text-12px text-[var(--text)]">
            <div v-for="(iss, k) in seg.issues" :key="k" class="font-mono whitespace-pre-wrap break-all">
              <el-tag size="small" :type="iss.severity === 'error' ? 'danger' : 'warning'">
                {{ iss.severity === 'error' ? '错误' : '警告' }}
              </el-tag>
              {{ iss.file ? `${iss.file}${iss.line ? `:${iss.line}` : ''}` : '' }} {{ iss.message }}
            </div>
            <div v-if="seg.status === 'failed' && turn.status !== 'running' && canEdit">
              <el-button size="small" type="primary" plain @click="emit('fixIssues', issuesText(seg.issues))">
                让 AI 修复这些问题
              </el-button>
            </div>
          </div>
        </div>
      </template>

      <div v-if="running" class="flex items-center gap-2 text-13px text-[var(--muted)]">
        <span class="inline-block w-2 h-2 rounded-full bg-blue-500 animate-ping" />
        正在处理…
      </div>

      <!-- 本轮结果 -->
      <div v-if="turn.changes.length && !running" class="border border-[var(--border)] rounded-xl bg-white overflow-hidden">
        <div class="flex items-center px-4 py-2 bg-gray-50 text-13px">
          <span class="font-600">改动了 {{ turn.changes.length }} 个文件</span>
          <span class="ml-2 text-green-600">+{{ totalAdded }}</span>
          <span class="ml-1 text-red-500">-{{ totalRemoved }}</span>
          <span class="flex-1" />
          <el-button size="small" text @click="emit('diff')">
            查看差异
          </el-button>
          <el-button v-if="canEdit" size="small" text type="danger" @click="emit('revert')">
            撤销本轮改动
          </el-button>
        </div>
        <div
          v-for="c in turn.changes" :key="c.path"
          class="flex items-center px-4 py-1.5 text-13px border-t border-[var(--border)] cursor-pointer hover:bg-gray-50"
          @click="emit('diff', c.path)"
        >
          <el-tag size="small" :type="c.status === 'added' ? 'success' : c.status === 'deleted' ? 'danger' : 'info'" class="mr-2">
            {{ c.status === 'added' ? '新增' : c.status === 'deleted' ? '删除' : '修改' }}
          </el-tag>
          <span class="flex-1 truncate font-mono text-12.5px">{{ c.path }}</span>
          <span class="text-green-600 text-12px">+{{ c.added }}</span>
          <span class="text-red-500 text-12px ml-1">-{{ c.removed }}</span>
        </div>
      </div>

      <el-alert v-if="turn.status === 'failed'" type="error" :closable="false" :title="turn.error || '执行失败'">
        <el-button v-if="canEdit" size="small" class="mt-1" @click="emit('resend')">
          重试
        </el-button>
      </el-alert>
      <div v-if="turn.status === 'stopped'" class="text-13px text-[var(--muted)]">
        已停止{{ turn.changes.length ? '，已保留停止前的改动' : '' }}
      </div>

      <div v-if="turn.planMode && turn.status === 'completed' && canEdit" class="flex gap-2">
        <el-button type="primary" @click="emit('executePlan')">
          按此执行
        </el-button>
      </div>

      <div v-if="!running" class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity text-12px text-[var(--muted)]">
        <el-button size="small" text @click="copy(finalText)">
          复制
        </el-button>
        <el-button v-if="canEdit" size="small" text @click="emit('resend')">
          重新生成
        </el-button>
        <span v-if="turn.usage" class="ml-2">
          {{ elapsed ? `${elapsed} 秒 · ` : '' }}{{ ((turn.usage.inputTokens + turn.usage.outputTokens) / 1000).toFixed(1) }}k tokens{{ turn.model ? ` · ${turn.model}` : '' }}
        </span>
      </div>
    </div>
  </div>
</template>
