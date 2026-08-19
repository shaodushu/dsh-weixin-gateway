/**
 * applyStreamChunk 单元测试（流式文本提取）。
 *
 * 背景（实测）：普通文本块以 text-delta 增量广播；工具调用后的最终文本块
 * 无 text-delta（只有 text-chunks + 聚合 block-end）——曾导致"画一个杯子"
 * 图片生成成功但发送器零输入。本函数做块级兜底：无增量的块在 block-end
 * 时用完整文本补齐，有增量的块跳过（幂等），reasoning/工具调用块文本为空
 * 不误发。
 */
import { describe, expect, it } from 'vitest'

import { applyStreamChunk, askAgentStreaming } from './bridge.js'
import type { StreamChunkState } from './bridge.js'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function chunk(seq: number, type: string, text?: string): SessionEvent {
  return {
    seq,
    type: 'assistant/chunk',
    data: {
      chunk:
        type === 'block-end'
          ? { type, index: 0, block: { type: 'text', text } }
          : { type, text },
    },
  } as unknown as SessionEvent
}

function state(): StreamChunkState {
  return { blockHadDelta: false }
}

/** 按事件序列跑一遍，返回所有提取的文本（模拟发送器收到的增量）。 */
function run(events: SessionEvent[]): string[] {
  const out: string[] = []
  const s = state()
  for (const e of events) {
    const t = applyStreamChunk(e, s)
    if (t) out.push(t)
  }
  return out
}

describe('applyStreamChunk', () => {
  it('普通文本块：text-delta 增量正常输出，block-end 不重复', () => {
    const events = [
      chunk(1, 'block-start'),
      chunk(2, 'text-delta', '记住了'),
      chunk(3, 'block-end', '记住了'),
    ]
    expect(run(events)).toEqual(['记住了'])
  })

  it('工具调用后的最终块：无 text-delta，block-end 用完整文本兜底（杯子场景）', () => {
    const events = [
      chunk(1, 'block-start'),
      chunk(2, 'block-end', ''), // 推理块
      chunk(3, 'block-start'),
      chunk(4, 'block-end', '画好了，和你发的那个保温杯对应的：\n\n[image:/tmp/xxx.png]'),
    ]
    expect(run(events)).toEqual(['画好了，和你发的那个保温杯对应的：\n\n[image:/tmp/xxx.png]'])
  })

  it('多块：有增量的块不兜底、无增量的块兜底，互不干扰', () => {
    const events = [
      chunk(1, 'block-start'),
      chunk(2, 'text-delta', 'a'),
      chunk(3, 'text-delta', 'b'),
      chunk(4, 'block-end', 'ab'),
      chunk(5, 'block-start'),
      chunk(6, 'block-end', '工具后的完整文本'),
    ]
    expect(run(events)).toEqual(['a', 'b', '工具后的完整文本'])
  })

  it('reasoning / 工具调用块：block-end 无文本 → 不输出', () => {
    const events = [
      chunk(1, 'block-start'),
      chunk(2, 'block-end', ''), // reasoning
      chunk(3, 'block-start'),
      chunk(4, 'block-end', ''), // tool-call
    ]
    expect(run(events)).toEqual([])
  })

  it('空 text-delta 不标记块（后续 block-end 仍可兜底）', () => {
    const events = [
      chunk(1, 'block-start'),
      chunk(2, 'text-delta', ''),
      chunk(3, 'block-end', '完整文本'),
    ]
    expect(run(events)).toEqual(['完整文本'])
  })

  it('非 assistant/chunk 事件不处理', () => {
    const s = state()
    expect(applyStreamChunk({ seq: 1, type: 'turn/start', data: {} } as unknown as SessionEvent, s)).toBeUndefined()
  })
})

describe('askAgentStreaming tool/call 转发', () => {
  /** 轻量 mock agent 句柄：可手动 emit 会话事件，whenIdle 立即 resolve。 */
  function mockHandle(): { handle: AgentHandle; emit: (e: SessionEvent) => void } {
    const listeners: Array<(session: unknown, event: SessionEvent) => void> = []
    const agent = {
      session: { seq: 0, events: [] },
      ctx: {
        on: (_type: string, fn: (session: unknown, event: SessionEvent) => void) => {
          listeners.push(fn)
          return () => undefined
        },
      },
      followup: () => undefined,
      whenIdle: async () => undefined,
    } as unknown as AgentHandle
    return {
      handle: { agent } as unknown as AgentHandle,
      emit: (e) => listeners.forEach((fn) => fn(null, e)),
    }
  }

  it('tool/call 事件转发名称与参数原文（占位回复/耗时拆分的触发点）', async () => {
    const { handle, emit } = mockHandle()
    const calls: Array<[string, string]> = []
    const p = askAgentStreaming(handle, '画一个杯子', { onToolCall: (n, a) => calls.push([n, a]) })
    emit({
      seq: 1,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name: 'generate_image', arguments: '{"prompt":"蓝色保温杯"}' },
    } as unknown as SessionEvent)
    await p
    expect(calls).toEqual([['generate_image', '{"prompt":"蓝色保温杯"}']])
  })

  it('非 tool/call 事件不触发 onToolCall', async () => {
    const { handle, emit } = mockHandle()
    const calls: string[] = []
    const p = askAgentStreaming(handle, '你好', { onToolCall: (n) => calls.push(n) })
    emit({ seq: 1, type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent)
    emit({ seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'block-start', index: 0 } } } as unknown as SessionEvent)
    await p
    expect(calls).toEqual([])
  })
})
