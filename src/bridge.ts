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

/** 创建并返回一个就绪的 agent 会话句柄（可多次 ask，多轮对话）。 */
export async function createGatewayAgent(ctx: Context, cwd?: string): Promise<AgentHandle> {
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
  const handle = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: cwd ?? process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
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
}

/**
 * 流式版本：注入消息后实时订阅 session/event 的 assistant/chunk（text-delta），
 * 逐块回调调用方（用于微信增量发送）。返回与 askAgent 相同的聚合结果。
 */
export async function askAgentStreaming(
  handle: AgentHandle,
  text: string,
  cbs: StreamCallbacks = {},
): Promise<AskResult> {
  const agent = handle.agent
  const firstSeq = agent.session.seq

  // 订阅会话事件流（agent 作用域 ctx；只在本 ask 的生命周期内有效）
  const off = agent.ctx.on('session/event', (_session, event) => {
    if (event.seq < firstSeq) return
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta' && chunk.text) {
        cbs.onDelta?.(chunk.text)
      }
      return
    }
    if (event.type === 'turn/start') {
      cbs.onTurnStart?.()
    }
  })

  try {
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
    return summarize(agent.session.events, firstSeq)
  } finally {
    off()
  }
}
