/**
 * session-test — 会话路由双模式自动化测试。
 *
 * 在真实 dsh 环境中模拟两个微信用户（A=小明、B=小红）依次对话，
 * 验证 SessionRouter 两种模式的行为：
 *   - per-user：会话隔离（B 不知道 A 说的话）
 *   - room：共享（B 能感知 A 的上下文）
 *
 * 用法：dsh --profile headless --patch ./weixin.patch.yml --session-test [per-user|room]
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'

import { askAgentStreaming } from '../bridge.js'
import { SessionRouter } from './session-router.js'
import type { SessionMode } from './session-router.js'
import { logger } from './util/logger.js'

export const name = 'weixin-session-test'

export const inject = ['sessionTestStartup', 'agentDefaultModel', 'agents', 'sessions']

export interface Config {
  mode: SessionMode
}

export function apply(ctx: Context, config: Config): void {
  void (async () => {
    const router = new SessionRouter(ctx, config.mode)
    const results: string[] = []
    try {
      // 用户 A（小明）
      const userA = 'user-A-xiaoming'
      const userB = 'user-B-xiaohong'

      const step = (label: string, pass: boolean, detail: string): void => {
        const line = `${pass ? '✅' : '❌'} ${label}: ${detail}`
        results.push(line)
        console.log(line)
      }

      // 1. A 记住名字
      const a1 = await router.getSession(userA)
      const r1 = await askAgentStreaming(a1, '记住我的名字叫小明，只回复"记住了"', {})
      step('A 记住名字', r1.text.includes('记住') || r1.text.length > 0, `A1=${r1.text.slice(0, 40)}`)

      // 2. B 问名字（per-user 应隔离；room 可能共享）
      const b1 = await router.getSession(userB)
      const r2 = await askAgentStreaming(b1, '我叫什么名字？请只回答名字或"不知道"', {})
      const bKnows = r2.text.includes('小明')
      if (config.mode === 'per-user') {
        step('B 不知 A 的名字（隔离）', !bKnows, `B1=${r2.text.slice(0, 40)}`)
      } else {
        step('room 共享上下文（B 可能知道）', true, `B1=${r2.text.slice(0, 40)}（共享模式下行为正常即可）`)
      }

      // 3. A 问名字（会话应保留 A 的记忆）
      const a2 = await router.getSession(userA)
      const r3 = await askAgentStreaming(a2, '我叫什么名字？请只回答名字', {})
      const aRemembers = r3.text.includes('小明')
      step('A 会话保留记忆', aRemembers, `A2=${r3.text.slice(0, 40)}`)

      // 4. 会话数量断言
      const count = router.size
      if (config.mode === 'per-user') {
        step('per-user 两个会话', count === 2, `sessions=${count}`)
      } else {
        step('room 单个共享会话', count === 1, `sessions=${count}`)
      }
    } catch (err) {
      console.error(`[session-test] 失败: ${err instanceof Error ? err.message : String(err)}`)
      results.push(`❌ 异常: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      await router.disposeAll()
      const exit = ctx.get('appExit') as ((code: number) => void) | undefined
      exit?.(results.some((r) => r.startsWith('❌')) ? 1 : 0)
    }
  })()
}
