/**
 * AgentBridge — dsh (deepseek-harness) 执行层的消息注入核心。
 *
 * 与消息来源解耦：CLI / 微信 / 其他渠道只负责调用 createAgent + askAgent，
 * 本模块负责创建 agent 会话、注入用户消息、等待处理完成、聚合回复文本。
 *
 * 模式参考：@deepseek-ai/dsh-headless 的 runner（one-shot direct Agent driver）。
 * 差异：本模块允许同一 agent 会话上多次 ask（多轮对话），并为微信的
 * 异步消息场景预留了长生命周期句柄（createGatewayAgent 返回 handle，不自动销毁）。
 */
import { randomUUID } from 'node:crypto'

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { raceWithTimeout } from './with-timeout.js'
import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// 空类型导入用于携带 loader Context merge（await loader 就绪）
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** 一次 ask 的结果。 */
export interface AskResult {
  /** 聚合后的最终助手文本（assistant/message 的 text 块）。 */
  text: string
  /** 出现 error turn 时的简要信息。 */
  error?: string
}

/**
 * 聚合会话事件流中一次 turn 的最终助手文本与结局。
 * @param events - 会话事件（含此前历史）
 * @param firstSeq - 本次 ask 的起始序号（只统计之后的 turn）
 */
function summarize(events: readonly SessionEvent[], firstSeq: number): AskResult {
  let started = false
  let text = ''
  let error: string | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end' && event.data.reason?.kind === 'error') {
      error = JSON.stringify(event.data.reason)
    }
  }
  return error !== undefined ? { text, error } : { text }
}

/** 解析 agent 创建/恢复的公共选项（provider/model 来自默认模型选择）。 */
export async function resolveAgentOptions(ctx: Context): Promise<{
  agentOptions: { provider: string; model: string }
  setup: (agentCtx: Context) => void
}> {
  // Loader 兄弟插件并发装载；等完整应用就绪再建 agent，
  // 否则其作用域内工具/适配器可能只装配了一半。
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    throw new Error('缺少核心服务（agents / agentDefaultModel / sessions）')
  }
  const selection = defaultModel.currentSelection()
  return {
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  }
}

/** 创建并返回一个就绪的 agent 会话句柄（可多次 ask，多轮对话）。 */
export async function createGatewayAgent(
  ctx: Context,
  cwd?: string,
  sessionId?: string,
): Promise<AgentHandle> {
  const opts = await resolveAgentOptions(ctx)
  const agents = ctx.get('agents')!
  const handle = await agents.create({
    sessionId: SessionId(sessionId ?? `session-${randomUUID()}`),
    meta: { cwd: cwd ?? process.cwd() },
    ...opts,
  })
  await handle.agent.whenIdle()
  return handle
}

/** 恢复一个持久化的 agent 会话（无持久化后端或会话不存在时抛错，由调用方 fallback）。 */
export async function resumeGatewayAgent(ctx: Context, sessionId: string): Promise<AgentHandle> {
  const opts = await resolveAgentOptions(ctx)
  const agents = ctx.get('agents')!
  const handle = await agents.resume({
    resumeSessionId: SessionId(sessionId),
    ...opts,
  })
  await handle.agent.whenIdle()
  return handle
}

/** 向一个 agent 会话注入一条用户消息，等待处理完成并返回回复。 */
export async function askAgent(handle: AgentHandle, text: string): Promise<AskResult> {
  const agent = handle.agent
  const firstSeq = agent.session.seq
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
  )
  await agent.whenIdle()
  return summarize(agent.session.events, firstSeq)
}

/** 流式回调。 */
export interface StreamCallbacks {
  /** 文本增量（assistant/chunk 的 text-delta，按块累积）。 */
  onDelta?: (text: string) => void
  /** 每个 turn 开始时。 */
  onTurnStart?: () => void
  /** 模型请求调用工具时（tool/call 事件；参数为模型产出的原始 JSON 字符串）。 */
  onToolCall?: (name: string, args: string) => void
}

/** 一次 ask 的 LLM 推理超时（秒）。 */
const ASK_TIMEOUT_SEC = 180

/**
 * 从 assistant/chunk 事件中提取应喂给发送器的流式文本（纯函数，可单测）。
 *
 * 背景（实测）：普通文本块逐 token 增量以 text-delta 广播；但**工具调用后
 * 的最终文本块**不产生 text-delta（只有 text-chunks + 聚合的 block-end）——
 * 只订阅 text-delta 会漏掉整个块，发送器收不到任何内容，[image:] 等标记
 * 不会被提取发送（实测"画一个杯子"：图片生成成功但用户收不到）。
 *
 * 规则：
 * - block-start → 重置块状态（块内尚未收到增量）
 * - text-delta 非空 → 标记块已有增量，返回该增量
 * - block-end 携带完整文本 且 该块无增量 → 返回完整文本兜底（幂等：
 *   有增量的块跳过，避免与增量重复发送）
 * - reasoning/工具调用块 block-end 无文本 → 返回 undefined
 */
export interface StreamChunkState {
  blockHadDelta: boolean
}

export function applyStreamChunk(
  event: SessionEvent,
  state: StreamChunkState,
): string | undefined {
  if (event.type !== 'assistant/chunk') return undefined
  const chunk = event.data.chunk
  if (chunk.type === 'block-start') {
    state.blockHadDelta = false
    return undefined
  }
  if (chunk.type === 'text-delta') {
    if (chunk.text) {
      state.blockHadDelta = true
      return chunk.text
    }
    return undefined
  }
  if (chunk.type === 'block-end' && !state.blockHadDelta) {
    const block = chunk.block
    if (block.type === 'text' && block.text) return block.text
    return undefined
  }
  return undefined
}

/**
 * 流式版本：注入消息后实时订阅 session/event 的 assistant/chunk，
 * 逐块回调调用方（用于微信增量发送）。返回与 askAgent 相同的聚合结果。
 */
export async function askAgentStreaming(
  handle: AgentHandle,
  text: string,
  cbs: StreamCallbacks = {},
): Promise<AskResult> {
  const agent = handle.agent
  const firstSeq = agent.session.seq
  const streamState: StreamChunkState = { blockHadDelta: false }

  // 订阅会话事件流（agent 作用域 ctx；只在本 ask 的生命周期内有效）
  const off = agent.ctx.on('session/event', (_session, event) => {
    if (event.seq < firstSeq) return
    if (event.type === 'assistant/chunk') {
      const delta = applyStreamChunk(event, streamState)
      if (delta) cbs.onDelta?.(delta)
      return
    }
    if (event.type === 'tool/call') {
      cbs.onToolCall?.(event.data.name, event.data.arguments)
      return
    }
    if (event.type === 'turn/start') {
      cbs.onTurnStart?.()
    }
  })

  // 超时保护：AI 网关偶发挂起会让 whenIdle() 永不 resolve，而网关轮询
  // 串行 await 本条消息 → 单条消息卡死整个网关（实测：收到消息后 16 分钟
  // 无任何日志、期间所有消息排队）。超时后抛错让调用方回复"处理失败"并解冻
  // 轮询。局限：底层 LLM 推理无法中止，超时后仍在后台跑（其产出不再被聚合，
  // 事件订阅已随 finally 移除），属可接受的保底。
  try {
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
    await raceWithTimeout(
      agent.whenIdle(),
      ASK_TIMEOUT_SEC * 1000,
      () => new Error(`LLM 推理超时（>${ASK_TIMEOUT_SEC}s），请稍后再试`),
    )
    return summarize(agent.session.events, firstSeq)
  } finally {
    off()
  }
}
