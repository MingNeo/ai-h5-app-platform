// 本地调试用的脚本化模型：不连真实 LLM，也能走通「思考 → 计划 → 改文件 → 校验 → 总结」整条链路。
import type { LlmOptions, LlmResult, ToolCall } from './llm'

export const VOTE_PAGE = `<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { showToast } from 'vant'

const options = [
  { id: 'a', label: '方案 A' },
  { id: 'b', label: '方案 B' },
  { id: 'c', label: '方案 C' },
]
const counts = ref<Record<string, number>>({})
const myVote = ref<string | null>(null)
const loading = ref(false)
const total = computed(() => Object.values(counts.value).reduce((s, n) => s + n, 0))

async function load() {
  const groups = await platform.db.collection('votes').groupCount('option')
  counts.value = Object.fromEntries(groups.map(g => [String(g.value), g.count]))
  if (platform.auth.isLogin) {
    const mine = await platform.db.collection('votes').mine().limit(1).get()
    myVote.value = (mine.list[0]?.option as string | undefined) ?? null
  }
}

async function vote(option: string) {
  if (myVote.value)
    return
  loading.value = true
  try {
    await platform.db.collection('votes').add({ option })
    myVote.value = option
    showToast('投票成功')
    await load()
  }
  catch (e) {
    if (platform.isPlatformError(e) && e.code === 'DUPLICATE')
      showToast('你已经投过票了')
    else if (!(platform.isPlatformError(e) && e.code === 'LOGIN_CANCELLED'))
      showToast('投票失败，请稍后重试')
  }
  finally {
    loading.value = false
  }
}

onMounted(async () => {
  await platform.ready()
  await load()
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 p-4">
    <h1 class="text-xl font-bold text-gray-800 mb-1">
      你更喜欢哪个方案？
    </h1>
    <p class="text-sm text-gray-500 mb-4">
      每人限投一票，共 {{ total }} 票
    </p>
    <div class="flex flex-col gap-3">
      <div v-for="o in options" :key="o.id" class="bg-white rounded-xl p-4 shadow-sm">
        <div class="flex items-center justify-between mb-2">
          <span class="font-medium">{{ o.label }}</span>
          <span class="text-sm text-gray-500">{{ counts[o.id] ?? 0 }} 票</span>
        </div>
        <van-progress :percentage="total ? Math.round(((counts[o.id] ?? 0) / total) * 100) : 0" :show-pivot="false" />
        <van-button
          class="mt-3" block round size="small"
          :type="myVote === o.id ? 'success' : 'primary'"
          :disabled="!!myVote || loading"
          @click="vote(o.id)"
        >
          {{ myVote === o.id ? '已投票' : '投它一票' }}
        </van-button>
      </div>
    </div>
  </div>
</template>
`

export const MANIFEST = {
  name: '方案投票',
  requireLogin: false,
  orientation: 'portrait',
  capabilities: [],
  bizApis: [],
  dependencies: [],
  collections: {
    votes: {
      acl: 'public_read',
      description: '投票记录，每人一票',
      fields: { option: { type: 'string', required: true, enum: ['a', 'b', 'c'] } },
      indexes: [{ fields: { option: 1 } }, { fields: { _owner: 1 }, unique: true }],
      limits: { writesPerMinute: 10 },
      moderate: [],
    },
  },
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function stream(opts: LlmOptions, text: string, kind: 'text' | 'reasoning') {
  for (let i = 0; i < text.length; i += 6) {
    if (opts.signal?.aborted)
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const d = text.slice(i, i + 6)
    kind === 'text' ? opts.onText?.(d) : opts.onReasoning?.(d)
    await sleep(15)
  }
}

let callSeq = 0
function call(name: string, args: unknown): ToolCall {
  return { id: `mock_${Date.now()}_${callSeq++}`, name, arguments: JSON.stringify(args) }
}

export async function mockChat(opts: LlmOptions): Promise<LlmResult> {
  const msgs = opts.messages
  const lastUserIdx = msgs.map(m => m.role).lastIndexOf('user')
  const step = msgs.slice(lastUserIdx + 1).filter(m => m.role === 'assistant').length
  const lastUser = msgs[lastUserIdx]
  const userText = typeof lastUser?.content === 'string' ? lastUser.content : ''
  const isAgent = Boolean(opts.tools?.length)
  const result: LlmResult = { content: '', reasoning: '', toolCalls: [], usage: { inputTokens: 1200 + step * 300, outputTokens: 200 }, finishReason: 'stop' }
  const say = async (t: string) => {
    result.content = t
    await stream(opts, t, 'text')
  }
  const think = async (t: string) => {
    result.reasoning = t
    await stream(opts, t, 'reasoning')
  }

  if (!isAgent) {
    await say(`（模拟回复）收到：${userText.slice(0, 50)}`)
    return result
  }
  const planMode = msgs.some(m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('【方案模式】'))
  if (planMode) {
    await think('用户想先看方案。我先看看现有文件结构，再给出步骤。')
    await say('## 实施方案\n\n1. 在 `manifest.json` 新增 `votes` 集合（所有人可读、本人可写，每人一票）\n2. 改写 `src/pages/Home.vue`：展示 3 个选项和实时票数\n3. 投票时调用 `platform.db.collection(\'votes\').add()`，未登录会自动拉起登录\n4. 运行校验确保构建通过\n\n确认后点击「按此执行」。')
    return result
  }
  if (userText.startsWith('自动校验未通过')) {
    await say('校验问题已确认，代码无需进一步修改。')
    return result
  }
  switch (step) {
    case 0:
      await think('需要一个投票页面：先规划步骤，然后看看现有文件。投票数据要存到平台数据库，每人一票，可以用 unique 索引约束 _owner。')
      await say('好的，我来做一个投票页面。')
      result.toolCalls = [
        call('todo_write', { todos: [
          { content: '新增 votes 数据集合', status: 'in_progress' },
          { content: '编写投票页面', status: 'pending' },
          { content: '校验并修复', status: 'pending' },
        ] }),
        call('read_file', { path: 'manifest.json' }),
        call('read_file', { path: 'src/pages/Home.vue' }),
      ]
      result.finishReason = 'tool_calls'
      return result
    case 1:
      await say('先在 manifest 里声明集合。')
      result.toolCalls = [
        call('write_file', { path: 'manifest.json', content: `${JSON.stringify(MANIFEST, null, 2)}\n` }),
        call('todo_write', { todos: [
          { content: '新增 votes 数据集合', status: 'completed' },
          { content: '编写投票页面', status: 'in_progress' },
          { content: '校验并修复', status: 'pending' },
        ] }),
      ]
      result.finishReason = 'tool_calls'
      return result
    case 2:
      await say('接着写投票页面。')
      result.toolCalls = [call('write_file', { path: 'src/pages/Home.vue', content: VOTE_PAGE })]
      result.finishReason = 'tool_calls'
      return result
    case 3:
      result.toolCalls = [
        call('check', {}),
        call('todo_write', { todos: [
          { content: '新增 votes 数据集合', status: 'completed' },
          { content: '编写投票页面', status: 'completed' },
          { content: '校验并修复', status: 'completed' },
        ] }),
      ]
      result.finishReason = 'tool_calls'
      return result
    default:
      await say('投票页面已完成：\n\n- 新增 `votes` 集合，所有人可查看票数，每人限投一票\n- 首页展示 3 个方案和实时票数，未登录点投票会自动弹出登录\n\n可以在右侧预览里试试。')
      return result
  }
}
