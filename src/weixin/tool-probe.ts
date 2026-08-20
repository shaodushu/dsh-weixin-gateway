/**
 * tool-probe — 工具冒烟测试：真实 profile 中创建 agent 并调用指定工具。
 *
 * 用法（patch 注入，见下）：
 *   dsh --profile headless --patch tool-probe.patch.yml
 *
 * 背景（0.4.1）：天气插件（dsh-weather-cn 0.1.1）依赖 dsh-tools ^0.0.1-rc.1，
 * 与 dsh 全局的 0.1.0-rc.6 形成双实例——TOOL_RUNTIME_SCHEDULER 是模块级 Symbol，
 * 两副本对不上导致所有工具执行崩溃（Cannot read properties of undefined (reading 'prepare')）。
 * 本探针用于发布前/部署后快速验证工具执行链路。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session'

import { createGatewayAgent, askAgentStreaming } from '../bridge.js'

export const name = 'tool-probe'

export const inject = ['agentDefaultModel', 'agents', 'sessions']

export interface Config {
  /** 要调用工具的任务文本。 */
  task: string
}

export function apply(ctx: Context, config: Config): void {
  void (async () => {
    try {
      const handle = await createGatewayAgent(ctx)
      const r = await askAgentStreaming(handle, config.task, {})
      console.log(`[tool-probe] text=${r.text.slice(0, 300).replace(/\n/g, '\\n')}`)
      console.log(`[tool-probe] error=${r.error ?? 'none'}`)
      await handle.dispose().catch(() => undefined)
      const exit = ctx.get('appExit') as ((code: number) => void) | undefined
      exit?.(r.error ? 1 : 0)
    } catch (err) {
      console.error(`[tool-probe] FAILED: ${err instanceof Error ? err.message : String(err)}`)
      const exit = ctx.get('appExit') as ((code: number) => void) | undefined
      exit?.(1)
    }
  })()
}
