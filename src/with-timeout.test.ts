/**
 * raceWithTimeout / withIdleTimeout 单元测试（LLM 推理超时保护）。
 *
 * 背景：网关轮询串行 await 每条消息，LLM 挂起会卡死整个网关（实测
 * 收到消息后 16 分钟无回复）。超时后必须抛错让调用方解冻轮询，且
 * 迟到 settle 不得产生 unhandled rejection。
 *
 * withIdleTimeout 语义：持续 idleMs 无 reset() → 超时；活动事件
 * （文本增量/工具调用）刷新计时——多轮工具往返的长任务不误杀，
 * 只有真正卡住（无任何事件）才触发。
 */
import { describe, expect, it } from 'vitest'

import { raceWithTimeout, withIdleTimeout } from './with-timeout.js'

describe('raceWithTimeout', () => {
  it('promise 先完成 → 返回原值', async () => {
    await expect(
      raceWithTimeout(Promise.resolve('ok'), 1000, () => new Error('timeout')),
    ).resolves.toBe('ok')
  })

  it('promise 先 reject → 原样抛错', async () => {
    await expect(
      raceWithTimeout(Promise.reject(new Error('boom')), 1000, () => new Error('timeout')),
    ).rejects.toThrow('boom')
  })

  it('超时 → 用 onTimeout 构造的 Error reject（错误信息可自定义）', async () => {
    await expect(
      raceWithTimeout(new Promise<void>(() => {}), 30, () => new Error('LLM 推理超时（>180s）')),
    ).rejects.toThrow('LLM 推理超时')
  })

  it('超时后迟到 resolve 不产生 unhandled rejection', async () => {
    let resolveLate: (v: string) => void = () => {}
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve
    })
    const p = raceWithTimeout(late, 20, () => new Error('timeout'))
    await expect(p).rejects.toThrow('timeout')
    // 晚到的 resolve 应被安全消化（Promise.race 内部 handler 仍在）
    resolveLate('too late')
    await new Promise((r) => setTimeout(r, 30))
  })

  it('正常路径下 timer 被清理（进程不因挂起 timer 阻塞退出）', async () => {
    const p = raceWithTimeout(Promise.resolve(1), 100_000, () => new Error('timeout'))
    await p
  })
})

describe('withIdleTimeout', () => {
  it('持续 reset 刷新计时：活动不断则永不超时', async () => {
    let resolveLater!: (v: string) => void
    const pending = new Promise<string>((r) => {
      resolveLater = r
    })
    const g = withIdleTimeout(pending, 50, () => new Error('idle'))
    // 活动事件间隔（25ms / 45ms）都小于空闲阈值
    setTimeout(() => g.reset(), 25)
    setTimeout(() => g.reset(), 45)
    setTimeout(() => resolveLater('done'), 60)
    await expect(g.promise).resolves.toBe('done')
    g.dispose()
  })

  it('无任何事件 → 空闲超时 reject（错误信息可自定义）', async () => {
    const g = withIdleTimeout(new Promise<void>(() => {}), 30, () => new Error('AI 响应超时（180s 无输出）'))
    await expect(g.promise).rejects.toThrow('AI 响应超时')
    g.dispose()
  })

  it('内部 promise 先完成 → 跟随原值，不被误杀', async () => {
    const g = withIdleTimeout(Promise.resolve('ok'), 30, () => new Error('idle'))
    await expect(g.promise).resolves.toBe('ok')
    g.dispose()
  })

  it('内部 promise 先 reject → 原样抛错', async () => {
    const g = withIdleTimeout(Promise.reject(new Error('boom')), 30, () => new Error('idle'))
    await expect(g.promise).rejects.toThrow('boom')
    g.dispose()
  })

  it('dispose 后计时器清理，迟到超时被吞掉（无 unhandled rejection）', async () => {
    const g = withIdleTimeout(new Promise<void>(() => {}), 20, () => new Error('idle'))
    g.dispose()
    await new Promise((r) => setTimeout(r, 40))
  })
})
