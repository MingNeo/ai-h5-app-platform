// 本地调试用的脚本化模型：不连真实 LLM，也能走通「思考 → 计划 → 改文件 → 校验 → 总结」整条链路。
import type { LlmOptions, LlmResult, ToolCall } from './llm'

export const VOTE_PAGE = `// 首页：方案投票。纯 HTML + 原生 ESM，没有任何编译步骤。
// el() 来自平台运行时 /__platform/dom.js，toast() 来自 /__platform/ui.js。
import { el, mount } from '/__platform/dom.js'
import { toast } from '/__platform/ui.js'

const OPTIONS = [
  { id: 'a', label: '方案 A' },
  { id: 'b', label: '方案 B' },
  { id: 'c', label: '方案 C' },
]

export function renderHome() {
  const root = el('main', { class: 'ui-page ui-stack' })
  const state = { counts: {}, mine: null, loading: false }

  function total() {
    return Object.values(state.counts).reduce((sum, n) => sum + n, 0)
  }

  function optionCard(option) {
    const count = state.counts[option.id] || 0
    const percent = total() ? Math.round((count / total()) * 100) : 0
    const voted = state.mine === option.id
    return el('div', { class: 'bg-white rounded-xl p-4 ui-stack' }, [
      el('div', { class: 'flex items-center justify-between' }, [
        el('span', { class: 'font-medium' }, option.label),
        el('span', { class: 'ui-hint' }, count + ' 票'),
      ]),
      el('progress', { class: 'w-full h-2 accent-[var(--ui-primary)]', value: percent, max: 100 }),
      el('button', {
        class: voted
          ? 'w-full h-9 rounded-lg bg-green-500 text-white text-sm'
          : 'w-full h-9 rounded-lg bg-[var(--ui-primary)] text-white text-sm disabled:opacity-50',
        disabled: Boolean(state.mine) || state.loading,
        onClick: () => vote(option.id),
      }, voted ? '已投票' : '投它一票'),
    ])
  }

  function render() {
    mount(root, [
      el('h1', { class: 'text-xl font-bold' }, '你更喜欢哪个方案？'),
      el('p', { class: 'ui-hint' }, '每人限投一票，共 ' + total() + ' 票'),
      ...OPTIONS.map(optionCard),
    ])
  }

  async function load() {
    const groups = await platform.db.collection('votes').groupCount('option')
    state.counts = Object.fromEntries(groups.map(g => [String(g.value), g.count]))
    if (platform.auth.isLogin) {
      const mine = await platform.db.collection('votes').mine().limit(1).get()
      state.mine = mine.list[0] ? String(mine.list[0].option) : null
    }
    render()
  }

  async function vote(option) {
    if (state.mine || state.loading)
      return
    state.loading = true
    try {
      await platform.db.collection('votes').add({ option })
      state.mine = option
      toast('投票成功')
      await load()
    }
    catch (e) {
      if (platform.isPlatformError(e) && e.code === 'DUPLICATE')
        toast('你已经投过票了')
      else if (!(platform.isPlatformError(e) && e.code === 'LOGIN_CANCELLED'))
        toast('投票失败，请稍后重试')
    }
    finally {
      state.loading = false
      render()
    }
  }

  render()
  platform.ready().then(load).catch(() => {})
  return root
}
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
    await say('## 实施方案\n\n1. 在 `manifest.json` 新增 `votes` 集合（所有人可读、本人可写，每人一票）\n2. 改写 `src/pages/home.js`：展示 3 个选项和实时票数\n3. 投票时调用 `platform.db.collection(\'votes\').add()`，未登录会自动拉起登录\n4. 运行校验确保构建通过\n\n确认后点击「按此执行」。')
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
        call('read_file', { path: 'src/pages/home.js' }),
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
      result.toolCalls = [call('write_file', { path: 'src/pages/home.js', content: VOTE_PAGE })]
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
