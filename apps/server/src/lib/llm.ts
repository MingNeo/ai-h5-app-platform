// OpenAI 兼容的 Chat Completions 客户端（公司 LLM 网关），支持流式、工具调用、reasoning_content。
// LLM_PROVIDER=mock 时使用内置的脚本化模型，方便本地无密钥调试整条链路。
import { config } from '../config'
import type { ChatMessage } from './mongo'
import { mockChat } from './llm-mock'

export interface ToolDef {
  type: 'function'
  function: { name: string, description: string, parameters: Record<string, unknown> }
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface LlmResult {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
  usage: { inputTokens: number, outputTokens: number }
  finishReason: string
}

export interface LlmOptions {
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
}

export class LlmError extends Error {
  constructor(message: string, public status = 0) {
    super(message)
  }
}

export function llmConfigured() {
  return config.llm.provider === 'mock' || Boolean(config.llm.baseUrl)
}

export function availableModels() {
  if (config.llm.provider === 'mock')
    return ['mock-coder']
  return config.llm.models.length ? config.llm.models : [config.llm.defaultModel]
}

export async function chat(opts: LlmOptions): Promise<LlmResult> {
  if (config.llm.provider === 'mock')
    return mockChat(opts)
  if (!config.llm.baseUrl)
    throw new LlmError('未配置 LLM_BASE_URL')

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }
  if (opts.temperature !== undefined)
    body.temperature = opts.temperature
  if (opts.maxTokens)
    body.max_tokens = opts.maxTokens

  let res: Response
  try {
    res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        ...(config.llm.apiKey ? { authorization: `Bearer ${config.llm.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  }
  catch (e) {
    if ((e as Error).name === 'AbortError')
      throw e
    throw new LlmError(`连接模型服务失败：${(e as Error).message}`)
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new LlmError(`模型服务返回 ${res.status}：${text.slice(0, 500)}`, res.status)
  }

  const result: LlmResult = { content: '', reasoning: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, finishReason: '' }
  const calls = new Map<number, ToolCall>()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const handle = (data: string) => {
    if (data === '[DONE]')
      return
    let json: any
    try {
      json = JSON.parse(data)
    }
    catch {
      return
    }
    if (json.error)
      throw new LlmError(json.error.message || JSON.stringify(json.error))
    if (json.usage) {
      result.usage.inputTokens = json.usage.prompt_tokens ?? result.usage.inputTokens
      result.usage.outputTokens = json.usage.completion_tokens ?? result.usage.outputTokens
    }
    const choice = json.choices?.[0]
    if (!choice)
      return
    const delta = choice.delta ?? {}
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (reasoning) {
      result.reasoning += reasoning
      opts.onReasoning?.(reasoning)
    }
    if (delta.content) {
      result.content += delta.content
      opts.onText?.(delta.content)
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      let call = calls.get(idx)
      if (!call) {
        call = { id: tc.id ?? `call_${idx}_${Date.now()}`, name: '', arguments: '' }
        calls.set(idx, call)
      }
      if (tc.id)
        call.id = tc.id
      if (tc.function?.name)
        call.name += tc.function.name
      if (tc.function?.arguments)
        call.arguments += tc.function.arguments
    }
    if (choice.finish_reason)
      result.finishReason = choice.finish_reason
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line.startsWith('data:'))
        handle(line.slice(5).trim())
    }
  }
  if (buf.trim().startsWith('data:'))
    handle(buf.trim().slice(5).trim())
  result.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter(c => c.name)
  return result
}

/** 粗略估算 token（中文约 1 字 1 token，英文约 4 字符 1 token） */
export function estimateTokens(text: string) {
  let cjk = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2E80)
      cjk++
  }
  return Math.ceil(cjk + (text.length - cjk) / 4)
}
